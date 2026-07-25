import assert from "node:assert/strict";
import test from "node:test";

import {
  botIdFromToken,
  createLegacyUpdateBridge,
} from "../src/update-bridge.mjs";

const EMPTY_FS = Object.freeze({
  readdirSync() {
    return [];
  },
  readFileSync() {
    throw new Error("unexpected read");
  },
});

const NOW_MS = Date.parse("2026-07-25T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function request(offset, options = {}) {
  const search = offset == null ? "" : `?offset=${offset}`;
  return {
    method: options.method || "GET",
    headers: options.headers || {},
    url: `/bot${options.token || "123:secret"}/getUpdates${search}`,
  };
}

function response(result, options = {}) {
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers || { "x-upstream": "test" },
    body: options.body ?? Buffer.from(JSON.stringify({
      ok: options.ok ?? true,
      result,
    })),
  };
}

function resultBody(guardResult) {
  return JSON.parse(guardResult.upstream.body.toString("utf8")).result;
}

function bridge(options = {}) {
  const logs = [];
  const instance = createLegacyUpdateBridge({
    fs: options.fs || EMPTY_FS,
    now: options.now || (() => NOW_MS),
    logger(message) {
      logs.push(message);
    },
    config: {
      cloudFreshUpdateMaxAgeMs: 6 * 60 * 60 * 1000,
      localVirtualOffsetSkewMin: 1,
      ...options.config,
    },
  });
  return { instance, logs };
}

test("bot IDs and strict seed initialization preserve legacy validation", () => {
  assert.equal(botIdFromToken("787878:secret-value"), "787878");
  assert.equal(botIdFromToken("token-without-colon"), "token-without-colon");
  assert.equal(botIdFromToken(""), "");

  const { instance } = bridge({
    config: {
      localUpdateStateSeed: "787878:5:1200,797979:9:2000",
    },
  });
  assert.equal(instance.seededLocalUpdateStateCount, 2);
  assert.deepEqual(instance.redactedStateSnapshot(), {
    localUpdateStateByBotId: {
      787878: { localFloor: 5, virtualFloor: 1200 },
      797979: { localFloor: 9, virtualFloor: 2000 },
    },
    cloudUpdateStateByBotId: {},
  });

  for (const seed of [
    "787878:5oops:1000",
    "787878:1e3:1000",
    "787878:5.9:1000",
    "787878:9007199254740992:1000",
    "0:5:1000",
    "787878:5:1000,787878:6:1001",
    "787878:5",
  ]) {
    assert.throws(
      () => bridge({ config: { localUpdateStateSeed: seed } }),
      /LOCAL_UPDATE_STATE_SEED/u,
    );
  }
});

test("persisted bot-scoped offset floor wins over the client floor and ignores unrelated files", () => {
  const files = {
    "update-offset-default.json": JSON.stringify({ botId: "123", lastUpdateId: 150 }),
    "update-offset-other.json": JSON.stringify({ botId: "999", lastUpdateId: 900 }),
    "not-an-offset.json": JSON.stringify({ botId: "123", lastUpdateId: 999 }),
  };
  const fakeFs = {
    readdirSync(directory) {
      assert.equal(directory, "/offsets");
      return Object.keys(files);
    },
    readFileSync(pathname, encoding) {
      assert.equal(encoding, "utf8");
      return files[pathname.slice(pathname.lastIndexOf("/") + 1)];
    },
  };
  const { instance } = bridge({
    fs: fakeFs,
    config: { telegramOffsetDir: "/offsets" },
  });
  const upstream = response([
    { update_id: 150, message: { date: NOW_SECONDS } },
    { update_id: 151, message: { date: NOW_SECONDS } },
  ]);
  const guarded = instance.guardedLocalGetUpdates(
    request(100),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    upstream,
  );
  assert.equal(guarded.floor, 150);
  assert.equal(guarded.dropped, 1);
  assert.equal(guarded.ackOffset, 151);
  assert.deepEqual(resultBody(guarded).map((update) => update.update_id), [151]);
});

test("a read or parse failure discards the persisted floor and keeps the request floor", () => {
  const fakeFs = {
    readdirSync() {
      return ["update-offset-default.json"];
    },
    readFileSync() {
      return "{broken-json";
    },
  };
  const { instance } = bridge({ fs: fakeFs });
  const guarded = instance.guardedLocalGetUpdates(
    request(100),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    response([{ update_id: 100 }, { update_id: 101 }]),
  );
  assert.equal(guarded.floor, 99);
  assert.equal(guarded.dropped, 0);
  assert.equal(guarded.upstream.body.toString(), response([{ update_id: 100 }, { update_id: 101 }]).body.toString());
});

test("seeded local request translation keeps the paired affine anchor", () => {
  const { instance } = bridge({
    config: { localUpdateStateSeed: "123:5:1200" },
  });
  const body = Buffer.alloc(0);

  const staleClient = instance.localRequestForGetUpdates(
    request(1001),
    "getUpdates",
    "123:secret",
    body,
  );
  assert.equal(staleClient.translated, true);
  assert.equal(staleClient.req.url, "/bot123:secret/getUpdates?offset=6");

  const advancedClient = instance.localRequestForGetUpdates(
    request(1202),
    "getUpdates",
    "123:secret",
    body,
  );
  assert.equal(advancedClient.req.url, "/bot123:secret/getUpdates?offset=7");

  const untouchedReq = request(1202);
  const untouched = instance.localRequestForGetUpdates(
    untouchedReq,
    "getMe",
    "123:secret",
    body,
  );
  assert.equal(untouched.req, untouchedReq);
  assert.equal(untouched.translated, false);
});

test("cloud requests fail closed without a cursor and bootstrap only at explicit offset zero", () => {
  const { instance } = bridge();
  const req = request(1000);
  const body = Buffer.alloc(0);

  assert.deepEqual(
    instance.cloudRequestForGetUpdates(
      req,
      "getUpdates",
      "123:secret",
      body,
      { requireUsableCursor: true },
    ),
    {
      reqUrl: req.url,
      body,
      translated: false,
      blocked: true,
    },
  );

  const bootstrap = instance.cloudRequestForGetUpdates(
    req,
    "GETUPDATES",
    "123:secret",
    body,
    { bootstrapNativeOffset: true },
  );
  assert.equal(bootstrap.reqUrl, "/bot123:secret/getUpdates?offset=0");
  assert.equal(bootstrap.translated, true);
  assert.equal(bootstrap.bootstrapped, true);
  assert.equal(bootstrap.blocked, false);
});

test("cloud rescue filters stale messages while keeping current edits and undated callbacks", () => {
  const { instance, logs } = bridge();
  const oldSeconds = NOW_SECONDS - (7 * 60 * 60);
  const guarded = instance.guardedCloudGetUpdates(
    request(1000),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    response([
      { update_id: 10, message: { date: oldSeconds, text: "stale" } },
      {
        update_id: 11,
        edited_message: {
          date: oldSeconds,
          edit_date: NOW_SECONDS,
          text: "current edit",
        },
      },
      {
        update_id: 12,
        callback_query: {
          id: "current",
          message: { date: oldSeconds },
        },
      },
    ]),
    { virtualizeLowerIds: true },
  );

  assert.equal(guarded.dropped, 1);
  assert.equal(guarded.floor, 999);
  assert.equal(guarded.translated, true);
  assert.deepEqual(resultBody(guarded).map((update) => update.update_id), [1000, 1001]);
  assert.deepEqual(instance.redactedStateSnapshot().cloudUpdateStateByBotId, {
    123: {
      cloudFloor: 12,
      virtualFloor: 1001,
      filterStaleUpdates: true,
    },
  });
  assert.deepEqual(logs, [
    "method=getUpdates target=cloud action=virtualized-update-id count=2 dropped=1 cloudFloor=12 virtualFloor=1001",
  ]);

  const translatedRequest = instance.cloudRequestForGetUpdates(
    request(1002),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    { requireUsableCursor: true },
  );
  assert.equal(translatedRequest.reqUrl, "/bot123:secret/getUpdates?offset=13");
  assert.equal(translatedRequest.blocked, false);
});

test("an all-stale cloud rescue returns empty and records the terminal native floor", () => {
  const { instance, logs } = bridge();
  const stale = NOW_SECONDS - (7 * 60 * 60);
  const guarded = instance.guardedCloudGetUpdates(
    request(1000),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    response([
      { update_id: 1, message: { date: stale } },
      { update_id: 2, message: { date: stale } },
    ]),
    { virtualizeLowerIds: true },
  );

  assert.deepEqual(resultBody(guarded), []);
  assert.equal(guarded.dropped, 2);
  assert.equal(guarded.floor, 999);
  assert.equal(guarded.translated, true);
  assert.deepEqual(instance.redactedStateSnapshot().cloudUpdateStateByBotId, {
    123: {
      cloudFloor: 2,
      virtualFloor: 999,
      filterStaleUpdates: true,
    },
  });
  assert.deepEqual(logs, [
    "method=getUpdates target=cloud action=virtualized-update-id result=0 dropped=2 floor=999 reason=stale-cloud-updates",
  ]);
});

test("lower cloud IDs are dropped without opt-in virtualization and create a usable cursor", () => {
  const { instance } = bridge();
  const guarded = instance.guardedCloudGetUpdates(
    request(100),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    response([{ update_id: 3 }, { update_id: 4 }]),
  );
  assert.deepEqual(resultBody(guarded), []);
  assert.equal(guarded.dropped, 2);
  assert.equal(guarded.floor, 99);
  assert.equal(guarded.translated, false);

  const translated = instance.cloudRequestForGetUpdates(
    request(100),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    { requireUsableCursor: true },
  );
  assert.equal(translated.reqUrl, "/bot123:secret/getUpdates?offset=5");
  assert.equal(translated.translated, true);
  assert.equal(translated.blocked, false);
});

test("local stale filtering establishes a bridge and later emits stable virtual IDs", () => {
  const { instance, logs } = bridge();
  const first = instance.guardedLocalGetUpdates(
    request(1000),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    response([{ update_id: 5, message: { date: NOW_SECONDS, text: "stale" } }]),
  );
  assert.deepEqual(resultBody(first), []);
  assert.equal(first.dropped, 1);
  assert.equal(first.floor, 999);
  assert.equal(first.ackOffset, 6);
  assert.equal(first.translated, false);
  assert.equal(first.bridged, true);

  const localRequest = instance.localRequestForGetUpdates(
    request(1000),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
  );
  assert.equal(localRequest.req.url, "/bot123:secret/getUpdates?offset=6");

  const second = instance.guardedLocalGetUpdates(
    localRequest.req,
    "getUpdates",
    "123:secret",
    localRequest.body,
    response([
      { update_id: 5, message: { date: NOW_SECONDS, text: "repeat" } },
      { update_id: 6, message: { date: NOW_SECONDS, text: "new" } },
    ]),
  );
  assert.deepEqual(resultBody(second).map((update) => update.update_id), [1000]);
  assert.equal(second.dropped, 1);
  assert.equal(second.ackOffset, 6);
  assert.equal(second.translated, true);
  assert.equal(second.bridged, false);
  assert.deepEqual(instance.redactedStateSnapshot().localUpdateStateByBotId, {
    123: { localFloor: 6, virtualFloor: 1000 },
  });
  assert.deepEqual(logs, [
    "method=getUpdates target=local action=bridge-local-update-ids localFloor=5 virtualFloor=999",
    "method=getUpdates target=local action=virtualized-local-update-id count=1 dropped=1 localFloor=6 virtualFloor=1000",
  ]);
});

test("stale dated local updates do not establish a bridge", () => {
  const { instance } = bridge();
  const stale = NOW_SECONDS - (7 * 60 * 60);
  const guarded = instance.guardedLocalGetUpdates(
    request(1000),
    "getUpdates",
    "123:secret",
    Buffer.alloc(0),
    response([{ update_id: 5, message: { date: stale } }]),
  );
  assert.equal(guarded.dropped, 1);
  assert.equal(guarded.bridged, false);
  assert.deepEqual(instance.redactedStateSnapshot().localUpdateStateByBotId, {});
});

test("empty-success and malformed-response decisions retain their original shapes", () => {
  const { instance } = bridge();
  const empty = response([]);
  assert.equal(instance.emptySuccessfulGetUpdates("getUpdates", empty), true);
  assert.equal(instance.emptySuccessfulGetUpdates("getMe", empty), false);
  assert.equal(instance.emptySuccessfulGetUpdates("getUpdates", response([{}])), false);
  assert.equal(instance.emptySuccessfulGetUpdates(
    "getUpdates",
    response([], { body: Buffer.from("{broken") }),
  ), false);

  const malformed = response([], { body: Buffer.from("{broken") });
  assert.deepEqual(
    instance.guardedCloudGetUpdates(
      request(1),
      "getUpdates",
      "123:secret",
      Buffer.alloc(0),
      malformed,
    ),
    { upstream: malformed, dropped: 0, floor: null, translated: false },
  );
  assert.deepEqual(
    instance.guardedLocalGetUpdates(
      request(1),
      "getUpdates",
      "123:secret",
      Buffer.alloc(0),
      malformed,
    ),
    {
      upstream: malformed,
      dropped: 0,
      floor: null,
      ackOffset: null,
      translated: false,
      bridged: false,
    },
  );
});
