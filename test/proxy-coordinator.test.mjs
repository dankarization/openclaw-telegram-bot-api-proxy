import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { pathToFileURL } from "node:url";

const PROXY_ENTRYPOINT = process.env.PROXY_ENTRYPOINT_OVERRIDE
  ? pathToFileURL(process.env.PROXY_ENTRYPOINT_OVERRIDE)
  : new URL("../src/telegram-bot-api-proxy.mjs", import.meta.url);
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/legacy-routing-golden.json", import.meta.url), "utf8"));

function json(status, value) {
  return { body: JSON.stringify(value), status };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
}

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://upstream.test");
    const match = url.pathname.match(/^\/bot([^/]+)\/([^/]+)$/u);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {
      body: Buffer.concat(chunks),
      botId: String(match?.[1] || "").split(":", 1)[0],
      method: match?.[2] || "unknown",
      offset: url.searchParams.get("offset"),
      token: match?.[1] || "",
    };
    requests.push(request);
    let response;
    try {
      response = await handler(request, { req, res });
    } catch (error) {
      response = json(500, { ok: false, description: error.message });
    }
    if (response?.disconnect) {
      res.destroy();
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    response ||= json(404, { ok: false, description: "route not mocked" });
    res.writeHead(response.status, {
      "content-length": Buffer.byteLength(response.body),
      "content-type": "application/json",
    });
    res.end(response.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    requests,
    root: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function waitForOutput(child, output, expected) {
  const deadline = Date.now() + 5000;
  while (!output.value.includes(expected)) {
    if (child.exitCode != null) throw new Error(`proxy exited (${child.exitCode}):\n${output.value}`);
    if (Date.now() >= deadline) throw new Error(`proxy startup timed out:\n${output.value}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startHarness(t, localHandler, env = {}) {
  const local = await startUpstream(localHandler);
  const cloud = await startUpstream((request) => (
    request.method === "getMe"
      ? json(200, { ok: true, result: { id: Number(request.botId) } })
      : json(404, { ok: false, description: "cloud must stay unused" })
  ));
  const port = await reservePort();
  const output = { value: "" };
  const child = spawn(process.execPath, [PROXY_ENTRYPOINT.pathname], {
    env: {
      ...process.env,
      BUFFER_LIMIT_BYTES: String(8 * 1024 * 1024),
      CLOUD_API_ROOT: cloud.root,
      ENABLE_CLOUD_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "0",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "0",
      LISTEN_HOST: "127.0.0.1",
      LOCAL_API_ROOT: local.root,
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "1",
      LOCAL_GETUPDATES_RETRY_BASE_MS: "0",
      LOCAL_GETUPDATES_TIMEOUT_SECONDS: "0",
      LOCAL_GETUPDATES_UPSTREAM_TIMEOUT_MS: "2000",
      LOCAL_HEALTH_TIMEOUT_MS: "1000",
      LOCAL_HEALTH_TTL_MS: "1000",
      LOCAL_UNHEALTHY_COOLDOWN_MS: "1",
      PORT: String(port),
      TELEGRAM_OFFSET_DIR: "/path/that/does/not/exist",
      UPSTREAM_TIMEOUT_MS: "2000",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  await waitForOutput(child, output, `listening=127.0.0.1:${port}`);

  t.after(async () => {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await Promise.all([local.close(), cloud.close()]);
  });
  return {
    child,
    cloud,
    local,
    output,
    proxyRoot: `http://127.0.0.1:${port}`,
  };
}

async function poll(proxyRoot, token, options = {}) {
  const response = await fetch(`${proxyRoot}/bot${token}/getUpdates?offset=1`, {
    signal: options.signal,
  });
  return { payload: await response.json(), status: response.status };
}

test("same-bot long polls are serialized before the upstream can return 409", async (t) => {
  let active = 0;
  let maxActive = 0;
  const events = [];
  const harness = await startHarness(t, async (request) => {
    if (request.method === "getMe") return json(200, { ok: true, result: { id: Number(request.botId) } });
    if (request.method !== "getUpdates") return null;
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${request.botId}`);
    if (active > 1) {
      active -= 1;
      events.push(`conflict:${request.botId}`);
      return json(409, { ok: false, description: "terminated by other getUpdates request" });
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    active -= 1;
    events.push(`end:${request.botId}`);
    return json(200, { ok: true, result: [] });
  });
  const token = "111111:serial-secret-value";

  const [first, second] = await Promise.all([
    poll(harness.proxyRoot, token),
    poll(harness.proxyRoot, token),
  ]);

  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    "start:111111",
    "end:111111",
    "start:111111",
    "end:111111",
  ]);
});

test("different bot IDs keep independent long polls", async (t) => {
  const release = deferred();
  const bothStarted = deferred();
  const active = new Set();
  let maxActive = 0;
  const harness = await startHarness(t, async (request) => {
    if (request.method === "getMe") return json(200, { ok: true, result: { id: Number(request.botId) } });
    if (request.method !== "getUpdates") return null;
    active.add(request.botId);
    maxActive = Math.max(maxActive, active.size);
    if (active.size === 2) bothStarted.resolve();
    await release.promise;
    active.delete(request.botId);
    return json(200, { ok: true, result: [] });
  });

  const first = poll(harness.proxyRoot, "222222:first-secret");
  const second = poll(harness.proxyRoot, "333333:second-secret");
  await bothStarted.promise;
  assert.equal(maxActive, 2);
  release.resolve();
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.status), [200, 200]);
});

test("a queued client disconnect is removed without reaching upstream", async (t) => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let pollCalls = 0;
  const harness = await startHarness(t, async (request) => {
    if (request.method === "getMe") return json(200, { ok: true, result: { id: Number(request.botId) } });
    if (request.method !== "getUpdates") return null;
    pollCalls += 1;
    if (pollCalls === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return json(200, { ok: true, result: [] });
  });
  const token = "444444:queued-cancel-secret";

  const first = poll(harness.proxyRoot, token);
  await firstStarted.promise;
  const cancelledController = new AbortController();
  const cancelled = poll(harness.proxyRoot, token, { signal: cancelledController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  cancelledController.abort(new Error("client cancelled"));
  await assert.rejects(cancelled, /client cancelled/u);
  const third = poll(harness.proxyRoot, token);

  releaseFirst.resolve();
  assert.deepEqual((await Promise.all([first, third])).map((result) => result.status), [200, 200]);
  assert.equal(pollCalls, 2);
});

test("an active client disconnect does not release the bot lane before its upstream cycle ends", async (t) => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const events = [];
  let pollCalls = 0;
  const harness = await startHarness(t, async (request) => {
    if (request.method === "getMe") return json(200, { ok: true, result: { id: Number(request.botId) } });
    if (request.method !== "getUpdates") return null;
    pollCalls += 1;
    events.push(`start:${pollCalls}`);
    if (pollCalls === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    events.push(`end:${pollCalls}`);
    return json(200, { ok: true, result: [] });
  });
  const token = "555555:active-cancel-secret";
  const controller = new AbortController();

  const disconnected = poll(harness.proxyRoot, token, { signal: controller.signal });
  await firstStarted.promise;
  controller.abort(new Error("client disconnected"));
  await assert.rejects(disconnected, /client disconnected/u);
  const second = poll(harness.proxyRoot, token);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pollCalls, 1);

  releaseFirst.resolve();
  assert.equal((await second).status, 200);
  assert.deepEqual(events, ["start:1", "end:1", "start:2", "end:2"]);
});

test("sequential JSON polling matches the frozen c301f55 golden trace", async (t) => {
  const upstreamBody = GOLDEN.postJsonGetUpdates.downstream.body;
  const harness = await startHarness(t, async (request) => {
    if (request.method === "getMe") return json(200, { ok: true, result: { id: Number(request.botId) } });
    if (request.method === "getUpdates") return { body: upstreamBody, status: 200 };
    return null;
  }, {
    LOCAL_GETUPDATES_TIMEOUT_SECONDS: "0",
  });

  const response = await fetch(`${harness.proxyRoot}/bot666666:golden-secret/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      offset: 41,
      timeout: 60,
      allowed_updates: ["message"],
    }),
  });
  const downstream = {
    body: await response.text(),
    status: response.status,
  };
  const normalize = (request) => ({
    body: request.body.toString("utf8"),
    botId: request.botId,
    method: request.method,
    offset: request.offset,
  });
  const trace = {
    localRequests: harness.local.requests.map(normalize),
    cloudRequests: harness.cloud.requests.map(normalize),
    downstream,
  };

  assert.deepEqual(trace, GOLDEN.postJsonGetUpdates);
});

test("multipart upload stays local-only even when the local health probe fails", async (t) => {
  const harness = await startHarness(t, async (request) => {
    if (request.method === "getMe") return { disconnect: true };
    if (request.method === "sendDocument") {
      assert.match(request.body.toString("utf8"), /name="document"/u);
      return json(200, { ok: true, result: { message_id: 1 } });
    }
    return null;
  });
  const form = new FormData();
  form.set("chat_id", "1");
  form.set("document", new Blob(["document-bytes"]), "proof.txt");

  const response = await fetch(`${harness.proxyRoot}/bot777777:upload-secret/sendDocument`, {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(harness.local.requests.filter((request) => request.method === "sendDocument").length, 1);
  assert.equal(harness.cloud.requests.length, 0);
  await waitForOutput(harness.child, harness.output, "method=sendDocument target=local stream=upload");
});
