const MAX_GET_UPDATES_LIMIT = 100;

function assertSafeNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function cloneUpdate(update) {
  return structuredClone(update);
}

export class FakeTelegramConflictError extends Error {
  constructor() {
    super("Conflict: terminated by another getUpdates request");
    this.name = "FakeTelegramConflictError";
    this.code = 409;
    this.errorCode = 409;
    this.error_code = 409;
    this.status = 409;
    this.statusCode = 409;
  }
}

/**
 * Minimal in-memory model of Telegram's getUpdates queue.
 *
 * The simulator deliberately models only the semantics needed by the durable
 * reconciliation work:
 *   - offset=0 observes without acknowledging;
 *   - a positive offset acknowledges every update_id strictly below it;
 *   - at most one long poll may be active for a queue.
 *
 * Negative offsets are rejected because their destructive "tail" semantics are
 * outside PR 0 and must never leak into the normal durable polling loop.
 */
export class FakeTelegramQueue {
  #activePollId = null;
  #nextPollId = 1;
  #updates = [];

  constructor(updates = []) {
    this.calls = [];
    this.overlapCount = 0;
    this.enqueue(...updates);
  }

  get activePollCount() {
    return this.#activePollId == null ? 0 : 1;
  }

  enqueue(...updates) {
    const existingIds = new Set(this.#updates.map((update) => update.update_id));
    for (const update of updates) {
      if (update == null || typeof update !== "object") {
        throw new TypeError("update must be an object");
      }
      assertSafeNonNegativeInteger(update.update_id, "update_id");
      if (existingIds.has(update.update_id)) {
        throw new Error(`duplicate update_id ${update.update_id}`);
      }
      existingIds.add(update.update_id);
      this.#updates.push(cloneUpdate(update));
    }
    this.#updates.sort((left, right) => left.update_id - right.update_id);
  }

  pendingUpdateIds() {
    return this.#updates.map((update) => update.update_id);
  }

  async getUpdates({ offset = 0, limit = MAX_GET_UPDATES_LIMIT, holdUntil } = {}) {
    assertSafeNonNegativeInteger(offset, "offset");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GET_UPDATES_LIMIT) {
      throw new RangeError(`limit must be an integer between 1 and ${MAX_GET_UPDATES_LIMIT}`);
    }

    if (this.#activePollId != null) {
      this.overlapCount += 1;
      this.calls.push({ offset, status: "conflict" });
      throw new FakeTelegramConflictError();
    }

    const pollId = this.#nextPollId;
    this.#nextPollId += 1;
    this.#activePollId = pollId;

    try {
      const acknowledgedUpdateIds = [];
      if (offset > 0) {
        this.#updates = this.#updates.filter((update) => {
          const acknowledged = update.update_id < offset;
          if (acknowledged) acknowledgedUpdateIds.push(update.update_id);
          return !acknowledged;
        });
      }

      if (holdUntil != null) await holdUntil;

      const result = this.#updates.slice(0, limit).map(cloneUpdate);
      this.calls.push({
        acknowledgedUpdateIds,
        offset,
        resultUpdateIds: result.map((update) => update.update_id),
        status: "ok",
      });
      return result;
    } finally {
      if (this.#activePollId === pollId) this.#activePollId = null;
    }
  }
}
