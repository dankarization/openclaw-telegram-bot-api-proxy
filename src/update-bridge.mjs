import fsModule from "node:fs";

import {
  bodyWithOffset,
  exactSafeNonNegativeInteger,
  numericOffset,
  requestOffsetFloor,
  requestOffsetValue,
  requestWithUrl,
} from "./request-parsing.mjs";

const DEFAULT_CONFIG = Object.freeze({
  telegramOffsetDir: "telegram",
  cloudFreshUpdateMaxAgeMs: 6 * 60 * 60 * 1000,
  localVirtualOffsetSkewMin: 1000000,
  localUpdateStateSeed: "",
});

export function botIdFromToken(token) {
  return String(token || "").split(":", 1)[0] || "";
}

export function createLegacyUpdateBridge(options = {}) {
  return new LegacyUpdateBridge(options);
}

class LegacyUpdateBridge {
  #fs;
  #now;
  #logger;
  #config;
  #cloudUpdateStateByBotId = new Map();
  #localUpdateStateByBotId = new Map();
  #seededLocalUpdateStateCount;

  constructor({
    fs = fsModule,
    now = Date.now,
    logger = () => {},
    config = {},
  } = {}) {
    this.#fs = fs;
    this.#now = now;
    this.#logger = logger;
    this.#config = {
      telegramOffsetDir: config.telegramOffsetDir ?? DEFAULT_CONFIG.telegramOffsetDir,
      cloudFreshUpdateMaxAgeMs: config.cloudFreshUpdateMaxAgeMs ?? DEFAULT_CONFIG.cloudFreshUpdateMaxAgeMs,
      localVirtualOffsetSkewMin: config.localVirtualOffsetSkewMin ?? DEFAULT_CONFIG.localVirtualOffsetSkewMin,
    };
    this.#seededLocalUpdateStateCount = this.#seedLocalUpdateStates(
      config.localUpdateStateSeed ?? DEFAULT_CONFIG.localUpdateStateSeed,
    );
  }

  get seededLocalUpdateStateCount() {
    return this.#seededLocalUpdateStateCount;
  }

  // Снимок содержит только bot ID и числовые cursor-state, без token и payload.
  redactedStateSnapshot() {
    const copyStates = (states) => Object.fromEntries(
      [...states].map(([botId, state]) => [botId, { ...state }]),
    );
    return {
      localUpdateStateByBotId: copyStates(this.#localUpdateStateByBotId),
      cloudUpdateStateByBotId: copyStates(this.#cloudUpdateStateByBotId),
    };
  }

  #seedLocalUpdateStates(value) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    const parsedEntries = [];
    const botIds = new Set();
    for (const [index, entry] of raw.split(",").entries()) {
      const fields = entry.trim().split(":");
      if (fields.length !== 3) throw new Error(`invalid LOCAL_UPDATE_STATE_SEED entry ${index + 1}`);
      const [botIdRaw, localFloorRaw, virtualFloorRaw] = fields;
      const botIdNumber = exactSafeNonNegativeInteger(botIdRaw);
      const localFloor = exactSafeNonNegativeInteger(localFloorRaw);
      const virtualFloor = exactSafeNonNegativeInteger(virtualFloorRaw);
      if (botIdNumber == null || botIdNumber === 0 || localFloor == null || virtualFloor == null) {
        throw new Error(`invalid LOCAL_UPDATE_STATE_SEED entry ${index + 1}`);
      }
      const botId = String(botIdNumber);
      if (botIds.has(botId)) throw new Error(`duplicate LOCAL_UPDATE_STATE_SEED botId at entry ${index + 1}`);
      botIds.add(botId);
      parsedEntries.push({ botId, localFloor, virtualFloor });
    }
    for (const { botId, localFloor, virtualFloor } of parsedEntries) {
      this.#localUpdateStateByBotId.set(botId, { localFloor, virtualFloor });
    }
    return parsedEntries.length;
  }

  #updateDateMs(update) {
    const seconds = numericOffset(
      update?.message?.date
        ?? update?.edited_message?.edit_date
        ?? update?.channel_post?.date
        ?? update?.edited_channel_post?.edit_date
        ?? update?.my_chat_member?.date
        ?? update?.chat_member?.date
        ?? update?.chat_join_request?.date
        ?? null,
    );
    return seconds == null ? null : seconds * 1000;
  }

  // Без timestamp legacy path считает cloud update допустимым.
  #isFreshCloudUpdate(update) {
    const dateMs = this.#updateDateMs(update);
    if (dateMs == null) return true;
    return this.#now() - dateMs <= this.#config.cloudFreshUpdateMaxAgeMs;
  }

  #persistedOffsetFloor(token) {
    const botId = botIdFromToken(token);
    if (!botId) return null;
    try {
      let floor = null;
      for (const name of this.#fs.readdirSync(this.#config.telegramOffsetDir)) {
        if (!/^update-offset-.+\.json$/u.test(name)) continue;
        const raw = this.#fs.readFileSync(`${this.#config.telegramOffsetDir}/${name}`, "utf8");
        const state = JSON.parse(raw);
        if (String(state?.botId || "") !== botId) continue;
        const lastUpdateId = numericOffset(state?.lastUpdateId);
        if (lastUpdateId != null) floor = Math.max(floor ?? lastUpdateId, lastUpdateId);
      }
      return floor;
    } catch {
      return null;
    }
  }

  #localOffsetFloor(req, token, body) {
    const requestFloor = requestOffsetFloor(req, body);
    const persistedFloor = this.#persistedOffsetFloor(token);
    const floor = Math.max(
      requestFloor ?? Number.NEGATIVE_INFINITY,
      persistedFloor ?? Number.NEGATIVE_INFINITY,
    );
    return Number.isFinite(floor) ? floor : null;
  }

  cloudRequestForGetUpdates(req, method, token, body, options = {}) {
    if (method !== "getUpdates") {
      return { reqUrl: req.url, body, translated: false, blocked: false };
    }
    const botId = botIdFromToken(token);
    const state = botId ? this.#cloudUpdateStateByBotId.get(botId) : null;
    const hasUsableCursor = state?.cloudFloor != null && state?.virtualFloor != null;
    if (options.requireUsableCursor && !hasUsableCursor) {
      return { reqUrl: req.url, body, translated: false, blocked: true };
    }
    if (options.bootstrapNativeOffset && !hasUsableCursor) {
      return {
        ...bodyWithOffset(req, body, 0),
        translated: true,
        bootstrapped: true,
        blocked: false,
      };
    }
    if (!state) return { reqUrl: req.url, body, translated: false, blocked: false };

    const requestedOffset = requestOffsetValue(req, body);
    let cloudOffset = null;
    if (state.cloudFloor != null && state.virtualFloor != null) {
      if (requestedOffset != null && requestedOffset > state.virtualFloor) {
        cloudOffset = state.cloudFloor + (requestedOffset - state.virtualFloor);
      } else {
        cloudOffset = state.cloudFloor + 1;
      }
    }
    if (cloudOffset == null) {
      return { reqUrl: req.url, body, translated: false, blocked: false };
    }
    return {
      ...bodyWithOffset(req, body, cloudOffset),
      translated: true,
      blocked: false,
    };
  }

  localRequestForGetUpdates(req, method, token, body) {
    if (method !== "getUpdates") {
      return { req: requestWithUrl(req, req.url), body, translated: false };
    }
    const botId = botIdFromToken(token);
    const state = botId ? this.#localUpdateStateByBotId.get(botId) : null;
    if (!state || state.localFloor == null || state.virtualFloor == null) {
      return { req: requestWithUrl(req, req.url), body, translated: false };
    }

    const requestedOffset = requestOffsetValue(req, body);
    let localOffset = state.localFloor + 1;
    if (requestedOffset != null && requestedOffset > state.virtualFloor) {
      localOffset = state.localFloor + (requestedOffset - state.virtualFloor);
    }
    const translated = bodyWithOffset(req, body, localOffset);
    return {
      req: requestWithUrl(req, translated.reqUrl),
      body: translated.body,
      translated: true,
    };
  }

  #jsonResponse(upstream, payload) {
    return {
      ...upstream,
      headers: {
        ...upstream.headers,
        "content-type": "application/json",
      },
      body: Buffer.from(JSON.stringify(payload)),
    };
  }

  guardedCloudGetUpdates(req, method, token, body, upstream, options = {}) {
    if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) {
      return { upstream, dropped: 0, floor: null, translated: false };
    }

    try {
      const payload = JSON.parse(upstream.body.toString("utf8"));
      if (!payload?.ok || !Array.isArray(payload.result)) {
        return { upstream, dropped: 0, floor: null, translated: false };
      }

      const botId = botIdFromToken(token);
      const localFloor = this.#localOffsetFloor(req, token, body);
      const state = botId ? this.#cloudUpdateStateByBotId.get(botId) : null;
      const updateIds = payload.result
        .map((update) => numericOffset(update?.update_id))
        .filter((id) => id != null);
      const maxCloudUpdateId = updateIds.length > 0 ? Math.max(...updateIds) : null;

      if (!state && payload.result.length === 0 && botId && localFloor != null) {
        this.#cloudUpdateStateByBotId.set(botId, {
          cloudFloor: null,
          virtualFloor: localFloor,
          filterStaleUpdates: Boolean(options.virtualizeLowerIds),
        });
        return { upstream, dropped: 0, floor: localFloor, translated: false };
      }

      // Healthy-but-empty local rescue поднимает только свежие lower cloud IDs.
      if (!state && options.virtualizeLowerIds && botId && localFloor != null && maxCloudUpdateId != null) {
        const fresh = payload.result.filter((update) => this.#isFreshCloudUpdate(update));
        const freshUpdateIds = fresh
          .map((update) => numericOffset(update?.update_id))
          .filter((id) => id != null);
        if (freshUpdateIds.length === 0) {
          this.#cloudUpdateStateByBotId.set(botId, {
            cloudFloor: maxCloudUpdateId,
            virtualFloor: localFloor,
            filterStaleUpdates: true,
          });
          this.#logger(`method=getUpdates target=cloud action=virtualized-update-id result=0 dropped=${payload.result.length} floor=${localFloor} reason=stale-cloud-updates`);
          return {
            upstream: this.#jsonResponse(upstream, { ...payload, result: [] }),
            dropped: payload.result.length,
            floor: localFloor,
            translated: true,
          };
        }

        const cloudBase = Math.min(...freshUpdateIds) - 1;
        const virtualBase = localFloor;
        let nextCloudFloor = maxCloudUpdateId;
        let nextVirtualFloor = virtualBase;
        const result = fresh.map((update) => {
          const cloudUpdateId = numericOffset(update?.update_id);
          const virtualUpdateId = virtualBase + (cloudUpdateId - cloudBase);
          nextVirtualFloor = Math.max(nextVirtualFloor, virtualUpdateId);
          return { ...update, update_id: virtualUpdateId };
        });
        this.#cloudUpdateStateByBotId.set(botId, {
          cloudFloor: nextCloudFloor,
          virtualFloor: nextVirtualFloor,
          filterStaleUpdates: true,
        });
        this.#logger(`method=getUpdates target=cloud action=virtualized-update-id count=${result.length} dropped=${payload.result.length - result.length} cloudFloor=${nextCloudFloor} virtualFloor=${nextVirtualFloor}`);
        return {
          upstream: this.#jsonResponse(upstream, { ...payload, result }),
          dropped: payload.result.length - result.length,
          floor: localFloor,
          translated: true,
        };
      }

      if (!state && localFloor != null && maxCloudUpdateId != null && maxCloudUpdateId <= localFloor) {
        if (botId) {
          this.#cloudUpdateStateByBotId.set(botId, {
            cloudFloor: maxCloudUpdateId,
            virtualFloor: localFloor,
          });
        }
        return {
          upstream: this.#jsonResponse(upstream, { ...payload, result: [] }),
          dropped: payload.result.length,
          floor: localFloor,
          translated: false,
        };
      }

      if (!state) {
        if (localFloor == null) {
          return { upstream, dropped: 0, floor: null, translated: false };
        }
        const result = payload.result.filter(
          (update) => numericOffset(update?.update_id) > localFloor,
        );
        const dropped = payload.result.length - result.length;
        return {
          upstream: dropped > 0
            ? this.#jsonResponse(upstream, { ...payload, result })
            : upstream,
          dropped,
          floor: localFloor,
          translated: false,
        };
      }

      const cloudBase = state.cloudFloor
        ?? ((updateIds.length > 0 ? Math.min(...updateIds) : 1) - 1);
      const virtualBase = state.virtualFloor ?? (localFloor ?? cloudBase);
      const result = [];
      let nextCloudFloor = state.cloudFloor ?? cloudBase;
      let nextVirtualFloor = state.virtualFloor ?? virtualBase;
      const filterStaleUpdates = Boolean(
        options.virtualizeLowerIds || state.filterStaleUpdates,
      );

      for (const update of payload.result) {
        const cloudUpdateId = numericOffset(update?.update_id);
        if (cloudUpdateId == null || cloudUpdateId <= cloudBase) continue;
        nextCloudFloor = Math.max(nextCloudFloor, cloudUpdateId);
        if (filterStaleUpdates && !this.#isFreshCloudUpdate(update)) continue;
        const virtualUpdateId = virtualBase + (cloudUpdateId - cloudBase);
        result.push({ ...update, update_id: virtualUpdateId });
        nextVirtualFloor = Math.max(nextVirtualFloor, virtualUpdateId);
      }

      if (
        botId
        && (
          nextCloudFloor !== state.cloudFloor
          || filterStaleUpdates !== Boolean(state.filterStaleUpdates)
        )
      ) {
        this.#cloudUpdateStateByBotId.set(botId, {
          ...state,
          cloudFloor: nextCloudFloor,
          virtualFloor: nextVirtualFloor,
          filterStaleUpdates,
        });
        this.#logger(`method=getUpdates target=cloud action=virtualized-update-id count=${result.length} dropped=${payload.result.length - result.length} cloudFloor=${nextCloudFloor} virtualFloor=${nextVirtualFloor}`);
      }

      return {
        upstream: this.#jsonResponse(upstream, { ...payload, result }),
        dropped: payload.result.length - result.length,
        floor: state.virtualFloor ?? localFloor,
        translated: true,
      };
    } catch {
      return { upstream, dropped: 0, floor: null, translated: false };
    }
  }

  emptySuccessfulGetUpdates(method, upstream) {
    if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) {
      return false;
    }
    try {
      const payload = JSON.parse(upstream.body.toString("utf8"));
      return Boolean(
        payload?.ok
        && Array.isArray(payload.result)
        && payload.result.length === 0
      );
    } catch {
      return false;
    }
  }

  #shouldBridgeLocalUpdateIds(floor, localUpdateId, updates) {
    if (floor == null || localUpdateId == null || floor <= localUpdateId) return false;
    if (floor - localUpdateId < this.#config.localVirtualOffsetSkewMin) return false;
    return updates.some((update) => this.#isFreshCloudUpdate(update));
  }

  #bridgeLocalUpdateIds(botId, localFloor, virtualFloor) {
    if (!botId || localFloor == null || virtualFloor == null) return false;
    const previous = this.#localUpdateStateByBotId.get(botId);
    if (
      previous
      && previous.localFloor === localFloor
      && previous.virtualFloor === virtualFloor
    ) {
      return false;
    }
    this.#localUpdateStateByBotId.set(botId, { localFloor, virtualFloor });
    this.#logger(`method=getUpdates target=local action=bridge-local-update-ids localFloor=${localFloor} virtualFloor=${virtualFloor}`);
    return true;
  }

  #translateLocalUpdatesWithBridge(token, payload) {
    const botId = botIdFromToken(token);
    const state = botId ? this.#localUpdateStateByBotId.get(botId) : null;
    if (!state || state.localFloor == null || state.virtualFloor == null) return null;

    const result = [];
    let dropped = 0;
    let maxDroppedUpdateId = null;
    let nextLocalFloor = state.localFloor;
    let nextVirtualFloor = state.virtualFloor;
    for (const update of payload.result) {
      const localUpdateId = numericOffset(update?.update_id);
      if (localUpdateId == null) {
        dropped += 1;
        continue;
      }
      if (localUpdateId <= state.localFloor) {
        dropped += 1;
        maxDroppedUpdateId = Math.max(maxDroppedUpdateId ?? localUpdateId, localUpdateId);
        continue;
      }
      const virtualUpdateId = state.virtualFloor + (localUpdateId - state.localFloor);
      result.push({ ...update, update_id: virtualUpdateId });
      nextLocalFloor = Math.max(nextLocalFloor, localUpdateId);
      nextVirtualFloor = Math.max(nextVirtualFloor, virtualUpdateId);
    }

    if (
      nextLocalFloor !== state.localFloor
      || nextVirtualFloor !== state.virtualFloor
    ) {
      this.#localUpdateStateByBotId.set(botId, {
        localFloor: nextLocalFloor,
        virtualFloor: nextVirtualFloor,
      });
      const cloudState = this.#cloudUpdateStateByBotId.get(botId);
      if (cloudState?.virtualFloor != null && nextVirtualFloor > cloudState.virtualFloor) {
        this.#cloudUpdateStateByBotId.set(botId, {
          ...cloudState,
          virtualFloor: nextVirtualFloor,
        });
      }
      this.#logger(`method=getUpdates target=local action=virtualized-local-update-id count=${result.length} dropped=${dropped} localFloor=${nextLocalFloor} virtualFloor=${nextVirtualFloor}`);
    }

    return {
      result,
      dropped,
      floor: state.virtualFloor,
      ackOffset: maxDroppedUpdateId == null ? null : maxDroppedUpdateId + 1,
      translated: result.length > 0,
    };
  }

  guardedLocalGetUpdates(req, method, token, body, upstream) {
    if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) {
      return {
        upstream,
        dropped: 0,
        floor: null,
        ackOffset: null,
        translated: false,
        bridged: false,
      };
    }
    try {
      const payload = JSON.parse(upstream.body.toString("utf8"));
      if (!payload?.ok || !Array.isArray(payload.result)) {
        return {
          upstream,
          dropped: 0,
          floor: null,
          ackOffset: null,
          translated: false,
          bridged: false,
        };
      }
      const floor = this.#localOffsetFloor(req, token, body);
      if (floor == null) {
        return {
          upstream,
          dropped: 0,
          floor: null,
          ackOffset: null,
          translated: false,
          bridged: false,
        };
      }

      const translated = this.#translateLocalUpdatesWithBridge(token, payload);
      if (translated) {
        return {
          upstream: translated.translated || translated.dropped > 0
            ? this.#jsonResponse(upstream, { ...payload, result: translated.result })
            : upstream,
          dropped: translated.dropped,
          floor: translated.floor,
          ackOffset: translated.ackOffset,
          translated: translated.translated,
          bridged: false,
        };
      }

      const botId = botIdFromToken(token);
      let maxDroppedUpdateId = null;
      const result = payload.result.filter((update) => {
        const updateId = numericOffset(update?.update_id);
        if (updateId == null || updateId > floor) return true;
        maxDroppedUpdateId = Math.max(maxDroppedUpdateId ?? updateId, updateId);
        return false;
      });
      const dropped = payload.result.length - result.length;
      const bridged = (
        result.length === 0
        && this.#shouldBridgeLocalUpdateIds(floor, maxDroppedUpdateId, payload.result)
      )
        ? this.#bridgeLocalUpdateIds(botId, maxDroppedUpdateId, floor)
        : false;
      return {
        upstream: dropped > 0
          ? this.#jsonResponse(upstream, { ...payload, result })
          : upstream,
        dropped,
        floor,
        ackOffset: maxDroppedUpdateId == null ? null : maxDroppedUpdateId + 1,
        translated: false,
        bridged,
      };
    } catch {
      return {
        upstream,
        dropped: 0,
        floor: null,
        ackOffset: null,
        translated: false,
        bridged: false,
      };
    }
  }
}
