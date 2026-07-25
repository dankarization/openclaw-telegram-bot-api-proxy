import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeHooks } from "../src/runtime-hooks.mjs";

test("runtime hooks expose injectable clock, sleep, and fault points", async () => {
  const calls = [];
  const hooks = createRuntimeHooks({
    now: () => 1234,
    sleep: async (ms) => calls.push(["sleep", ms]),
    fault: async (point, context) => calls.push(["fault", point, context]),
  });

  assert.equal(hooks.now(), 1234);
  await hooks.sleep(17);
  await hooks.fault("after-upstream-response", { target: "local" });
  assert.deepEqual(calls, [
    ["sleep", 17],
    ["fault", "after-upstream-response", { target: "local" }],
  ]);
});

test("default sleep can be cancelled", async () => {
  const hooks = createRuntimeHooks();
  const controller = new AbortController();
  const waiting = hooks.sleep(10_000, { signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/u);
});
