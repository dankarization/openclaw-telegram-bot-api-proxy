import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeHooks } from "../src/runtime-hooks.mjs";
import { createUpstreamClient } from "../src/upstream-client.mjs";

function request(options = {}) {
  return {
    headers: options.headers || {},
    method: options.method || "GET",
    url: options.url || "/bot1:x/getMe",
  };
}

test("health probe decides on headers and cancels an unbounded body", async () => {
  let cancelled = false;
  const client = createUpstreamClient({
    upstreamTimeoutMs: 1000,
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(Buffer.from("first-chunk"));
      },
    }), { status: 200 }),
  });

  assert.deepEqual(
    await client.probeUpstream(
      "http://upstream.test",
      "/bot1:x/getMe",
      { method: "getMe", target: "local" },
    ),
    { statusCode: 200 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("buffered client preserves request/response bytes and exposes token-free fault context", async () => {
  const calls = [];
  const hooks = createRuntimeHooks({
    fault: async (point, context) => calls.push(["fault", point, context]),
  });
  const client = createUpstreamClient({
    hooks,
    upstreamTimeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push(["fetch", url, {
        body: options.body.toString(),
        headers: options.headers,
        method: options.method,
      }]);
      return new Response("upstream-body", {
        status: 201,
        headers: { "x-upstream": "yes" },
      });
    },
  });

  const result = await client.forwardBuffered(
    request({
      method: "POST",
      headers: {
        connection: "close",
        "content-length": "999",
        "content-type": "application/json",
        host: "proxy.test",
      },
    }),
    "http://upstream.test",
    Buffer.from('{"ok":true}'),
    "/bot1:x/sendMessage",
    { method: "sendMessage", target: "local" },
  );

  assert.deepEqual(result, {
    statusCode: 201,
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      "x-upstream": "yes",
    },
    body: Buffer.from("upstream-body"),
  });
  assert.deepEqual(calls, [
    ["fault", "before-upstream-request", { method: "sendMessage", target: "local" }],
    ["fetch", "http://upstream.test/bot1:x/sendMessage", {
      body: '{"ok":true}',
      headers: {
        "content-length": "11",
        "content-type": "application/json",
      },
      method: "POST",
    }],
    ["fault", "after-upstream-response", {
      method: "sendMessage",
      statusCode: 201,
      target: "local",
    }],
  ]);
  assert.equal(JSON.stringify(calls).includes("1:x"), true);
  assert.equal(JSON.stringify(calls.filter(([kind]) => kind === "fault")).includes("1:x"), false);
});

test("buffered client forwards coordinator shutdown cancellation", async () => {
  const controller = new AbortController();
  const client = createUpstreamClient({
    upstreamTimeoutMs: 10_000,
    fetchImpl: async (url, options) => {
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          reject(options.signal.reason);
          return;
        }
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      throw new Error(`unexpected completion for ${url}`);
    },
  });

  const pending = client.forwardBuffered(
    request(),
    "http://upstream.test",
    Buffer.alloc(0),
    undefined,
    { signal: controller.signal },
  );
  controller.abort(new Error("shutdown"));
  await assert.rejects(pending, /shutdown/u);
});
