function abortError(reason, fallbackMessage) {
  if (reason instanceof Error) {
    const error = new Error(reason.message || fallbackMessage, { cause: reason });
    error.name = reason.name || "AbortError";
    error.code = reason.code || "ABORT_ERR";
    return error;
  }
  const error = new Error(typeof reason === "string" && reason ? reason : fallbackMessage);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function closedError(reason) {
  const error = new Error("getUpdates coordinator is closed", reason instanceof Error ? { cause: reason } : undefined);
  error.name = "CoordinatorClosedError";
  error.code = "COORDINATOR_CLOSED";
  return error;
}

function queueFullError(maxPendingPerBot) {
  const error = new Error(
    `getUpdates queue is full (${maxPendingPerBot} pending per bot)`,
  );
  error.name = "PollQueueFullError";
  error.code = "POLL_QUEUE_FULL";
  return error;
}

export class PerBotPollCoordinator {
  #closed = false;
  #closeReason = null;
  #lanes = new Map();
  #maxPendingPerBot;
  #now;
  #onEvent;

  constructor(options = {}) {
    const maxPendingPerBot = options.maxPendingPerBot ?? 4;
    if (!Number.isSafeInteger(maxPendingPerBot) || maxPendingPerBot < 0) {
      throw new TypeError("maxPendingPerBot must be a non-negative safe integer");
    }
    this.#maxPendingPerBot = maxPendingPerBot;
    this.#now = options.now || Date.now;
    this.#onEvent = options.onEvent || (() => {});
  }

  get closed() {
    return this.#closed;
  }

  snapshot() {
    return [...this.#lanes.entries()].map(([botKey, lane]) => ({
      botKey,
      active: lane.active != null,
      pending: lane.queue.length,
    }));
  }

  run(botKey, task, options = {}) {
    if (typeof botKey !== "string" || botKey.length === 0) {
      return Promise.reject(new TypeError("botKey must be a non-empty string"));
    }
    if (typeof task !== "function") {
      return Promise.reject(new TypeError("task must be a function"));
    }
    if (this.#closed) return Promise.reject(closedError(this.#closeReason));

    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(abortError(signal.reason, "getUpdates request aborted before queueing"));
    }

    let lane = this.#lanes.get(botKey);
    if (
      lane
      && (lane.active != null || lane.queue.length > 0)
      && lane.queue.length >= this.#maxPendingPerBot
    ) {
      this.#emit({
        type: "queue-full",
        botKey,
        pending: lane.queue.length,
        maxPending: this.#maxPendingPerBot,
      });
      return Promise.reject(queueFullError(this.#maxPendingPerBot));
    }
    if (!lane) {
      lane = { active: null, queue: [] };
      this.#lanes.set(botKey, lane);
    }

    return new Promise((resolve, reject) => {
      const item = {
        controller: null,
        enqueuedAt: this.#now(),
        onAbort: null,
        reject,
        resolve,
        settled: false,
        signal,
        started: false,
        task,
      };

      item.onAbort = () => {
        if (item.settled) return;
        if (item.started) {
          this.#emit({
            type: "client-aborted-active",
            botKey,
            queueWaitMs: Math.max(0, this.#now() - item.enqueuedAt),
          });
          return;
        }
        const index = lane.queue.indexOf(item);
        if (index >= 0) lane.queue.splice(index, 1);
        item.settled = true;
        signal.removeEventListener("abort", item.onAbort);
        reject(abortError(signal.reason, "getUpdates request aborted while queued"));
        this.#emit({
          type: "cancelled",
          botKey,
          queueWaitMs: Math.max(0, this.#now() - item.enqueuedAt),
        });
        this.#deleteIdleLane(botKey, lane);
      };
      signal?.addEventListener("abort", item.onAbort, { once: true });

      lane.queue.push(item);
      this.#emit({
        type: "queued",
        botKey,
        pending: lane.queue.length,
      });
      void this.#drain(botKey, lane);
    });
  }

  close(reason = new Error("proxy is shutting down")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [botKey, lane] of this.#lanes) {
      lane.active?.controller?.abort(reason);
      for (const item of lane.queue.splice(0)) {
        if (item.settled) continue;
        item.settled = true;
        item.signal?.removeEventListener("abort", item.onAbort);
        item.reject(closedError(reason));
      }
      this.#emit({
        type: "closed",
        botKey,
        pending: 0,
        active: lane.active != null,
      });
      this.#deleteIdleLane(botKey, lane);
    }
  }

  async #drain(botKey, lane) {
    if (lane.active || this.#closed) return;
    const item = lane.queue.shift();
    if (!item) {
      this.#deleteIdleLane(botKey, lane);
      return;
    }
    if (item.settled) {
      void this.#drain(botKey, lane);
      return;
    }

    item.started = true;
    item.controller = new AbortController();
    lane.active = item;
    const queueWaitMs = Math.max(0, this.#now() - item.enqueuedAt);
    // После начала upstream cycle клиентский disconnect его не обрывает:
    // Telegram мог уже применить offset. Цикл заканчивается под lock, а
    // shutdown всё ещё может прервать его внутренним controller.
    const signal = item.controller.signal;
    this.#emit({ type: "started", botKey, queueWaitMs });

    try {
      const value = await item.task({ botKey, queueWaitMs, signal });
      if (!item.settled) {
        item.settled = true;
        item.resolve(value);
      }
      this.#emit({ type: "finished", botKey, queueWaitMs });
    } catch (error) {
      if (!item.settled) {
        item.settled = true;
        item.reject(error);
      }
      this.#emit({
        type: signal.aborted ? "aborted" : "failed",
        botKey,
        queueWaitMs,
      });
    } finally {
      item.signal?.removeEventListener("abort", item.onAbort);
      lane.active = null;
      this.#deleteIdleLane(botKey, lane);
      if (!this.#closed) void this.#drain(botKey, lane);
    }
  }

  #deleteIdleLane(botKey, lane) {
    if (!lane.active && lane.queue.length === 0 && this.#lanes.get(botKey) === lane) {
      this.#lanes.delete(botKey);
    }
  }

  #emit(event) {
    try {
      this.#onEvent(event);
    } catch {
      // Observability must never influence polling decisions or lock release.
    }
  }
}
