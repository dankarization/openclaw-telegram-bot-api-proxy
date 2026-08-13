import assert from "node:assert/strict";
import test from "node:test";

import { PerBotPollCoordinator } from "../src/per-bot-poll-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("polls for one bot execute in deterministic FIFO order", async () => {
  const coordinator = new PerBotPollCoordinator();
  const firstGate = deferred();
  const order = [];
  let active = 0;
  let maxActive = 0;

  const first = coordinator.run("bot:one", async () => {
    order.push("first:start");
    active += 1;
    maxActive = Math.max(maxActive, active);
    await firstGate.promise;
    active -= 1;
    order.push("first:end");
    return 1;
  });
  const second = coordinator.run("bot:one", async () => {
    order.push("second:start");
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    order.push("second:end");
    return 2;
  });

  await nextTurn();
  assert.deepEqual(order, ["first:start"]);
  assert.deepEqual(coordinator.snapshot(), [{ botKey: "bot:one", active: true, pending: 1 }]);

  firstGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("polls for different bots remain concurrent", async () => {
  const coordinator = new PerBotPollCoordinator();
  const gate = deferred();
  const started = deferred();
  const active = new Set();

  const task = (botKey) => coordinator.run(botKey, async () => {
    active.add(botKey);
    if (active.size === 2) started.resolve();
    await gate.promise;
    active.delete(botKey);
  });

  const first = task("bot:one");
  const second = task("bot:two");
  await started.promise;
  assert.deepEqual(new Set(active), new Set(["bot:one", "bot:two"]));

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("one bot retains only the configured number of queued polls", async () => {
  const events = [];
  const coordinator = new PerBotPollCoordinator({
    maxPendingPerBot: 1,
    onEvent: (event) => events.push(event),
  });
  const activeGate = deferred();
  const active = coordinator.run("bot:one", async () => activeGate.promise);
  const queued = coordinator.run("bot:one", async () => "queued");

  await assert.rejects(
    coordinator.run("bot:one", async () => "excess"),
    (error) => error?.code === "POLL_QUEUE_FULL",
  );
  assert.deepEqual(coordinator.snapshot(), [{
    botKey: "bot:one",
    active: true,
    pending: 1,
  }]);
  assert.equal(
    events.some((event) => (
      event.type === "queue-full"
      && event.pending === 1
      && event.maxPending === 1
    )),
    true,
  );

  activeGate.resolve("active");
  assert.deepEqual(await Promise.all([active, queued]), ["active", "queued"]);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("admission is bounded before request bodies become queued tasks", () => {
  const coordinator = new PerBotPollCoordinator({ maxPendingPerBot: 1 });
  const first = coordinator.reserve("bot:one");
  const second = coordinator.reserve("bot:one");

  assert.throws(
    () => coordinator.reserve("bot:one"),
    (error) => error?.code === "POLL_QUEUE_FULL",
  );
  assert.deepEqual(coordinator.snapshot(), [{
    botKey: "bot:one",
    active: false,
    pending: 0,
  }]);

  first.release();
  const replacement = coordinator.reserve("bot:one");
  second.release();
  replacement.release();
  assert.deepEqual(coordinator.snapshot(), []);
});

test("aborting a queued poll removes it without blocking the next poll", async () => {
  const coordinator = new PerBotPollCoordinator();
  const firstGate = deferred();
  const controller = new AbortController();
  const order = [];

  const first = coordinator.run("bot:one", async () => {
    order.push("first");
    await firstGate.promise;
  });
  const cancelled = coordinator.run("bot:one", async () => {
    order.push("cancelled");
  }, { signal: controller.signal });
  const third = coordinator.run("bot:one", async () => {
    order.push("third");
  });

  controller.abort(new Error("client disconnected"));
  await assert.rejects(cancelled, /client disconnected/u);
  firstGate.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(order, ["first", "third"]);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("a failed active poll releases the lane for the next waiter", async () => {
  const coordinator = new PerBotPollCoordinator();
  const order = [];

  const failed = coordinator.run("bot:one", async () => {
    order.push("failed:start");
    throw Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" });
  });
  const next = coordinator.run("bot:one", async () => {
    order.push("next:start");
    return "ok";
  });

  await assert.rejects(failed, /upstream timeout/u);
  assert.equal(await next, "ok");
  assert.deepEqual(order, ["failed:start", "next:start"]);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("disconnecting an active client lets its ambiguous upstream cycle finish under the lock", async () => {
  const coordinator = new PerBotPollCoordinator();
  const controller = new AbortController();
  const activeGate = deferred();
  const order = [];

  const active = coordinator.run("bot:one", async ({ signal }) => {
    order.push("active");
    assert.equal(signal.aborted, false);
    await activeGate.promise;
    assert.equal(signal.aborted, false);
    order.push("active:finished");
  }, { signal: controller.signal });
  const next = coordinator.run("bot:one", async () => {
    order.push("next");
  });

  await nextTurn();
  controller.abort(new Error("request timeout"));
  await nextTurn();
  assert.deepEqual(order, ["active"]);
  assert.deepEqual(coordinator.snapshot(), [{ botKey: "bot:one", active: true, pending: 1 }]);

  activeGate.resolve();
  await Promise.all([active, next]);
  assert.deepEqual(order, ["active", "active:finished", "next"]);
  assert.deepEqual(coordinator.snapshot(), []);
});

test("shutdown aborts active work, rejects queued work, and rejects new work", async () => {
  const coordinator = new PerBotPollCoordinator();
  const active = coordinator.run("bot:one", async ({ signal }) => {
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const queued = coordinator.run("bot:one", async () => "never");

  await nextTurn();
  coordinator.close(new Error("shutdown"));

  await assert.rejects(active, /shutdown/u);
  await assert.rejects(queued, /closed/u);
  await assert.rejects(coordinator.run("bot:one", async () => "never"), /closed/u);
  assert.equal(coordinator.closed, true);
  assert.deepEqual(coordinator.snapshot(), []);
});
