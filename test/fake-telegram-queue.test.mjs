import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeTelegramConflictError,
  FakeTelegramQueue,
} from "./support/fake-telegram-queue.mjs";

function update(updateId) {
  return { update_id: updateId, message: { message_id: updateId, text: `update-${updateId}` } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

test("a positive offset acknowledges only update IDs strictly below it", async () => {
  const queue = new FakeTelegramQueue([update(10), update(11), update(12)]);

  assert.deepEqual(
    (await queue.getUpdates({ offset: 11 })).map((item) => item.update_id),
    [11, 12],
  );
  assert.deepEqual(queue.pendingUpdateIds(), [11, 12]);
  assert.deepEqual(queue.calls[0].acknowledgedUpdateIds, [10]);

  assert.deepEqual(
    (await queue.getUpdates({ offset: 12 })).map((item) => item.update_id),
    [12],
  );
  assert.deepEqual(queue.pendingUpdateIds(), [12]);
});

test("offset zero never acknowledges queued updates", async () => {
  const queue = new FakeTelegramQueue([update(20), update(21)]);

  const first = await queue.getUpdates({ offset: 0 });
  const repeated = await queue.getUpdates({ offset: 0 });

  assert.deepEqual(first, repeated);
  assert.deepEqual(queue.pendingUpdateIds(), [20, 21]);
  assert.deepEqual(queue.calls.map((call) => call.acknowledgedUpdateIds), [[], []]);
});

test("a high virtual offset destructively acknowledges a lower native backlog", async () => {
  const queue = new FakeTelegramQueue([update(40), update(41), update(42)]);
  const virtualOffsetThatMustNeverReachUpstream = 1_000_000;

  assert.deepEqual(
    await queue.getUpdates({ offset: virtualOffsetThatMustNeverReachUpstream }),
    [],
  );
  assert.deepEqual(queue.pendingUpdateIds(), []);
  assert.deepEqual(queue.calls[0].acknowledgedUpdateIds, [40, 41, 42]);
});

test("overlapping long polls are detected as a Telegram-style conflict", async () => {
  const queue = new FakeTelegramQueue([update(50)]);
  const releaseFirstPoll = deferred();

  const firstPoll = queue.getUpdates({ offset: 0, holdUntil: releaseFirstPoll.promise });
  assert.equal(queue.activePollCount, 1);

  await assert.rejects(
    queue.getUpdates({ offset: 0 }),
    (error) => (
      error instanceof FakeTelegramConflictError
      && error.code === 409
      && error.statusCode === 409
    ),
  );
  assert.equal(queue.overlapCount, 1);

  releaseFirstPoll.resolve();
  assert.deepEqual(
    (await firstPoll).map((item) => item.update_id),
    [50],
  );
  assert.equal(queue.activePollCount, 0);
});
