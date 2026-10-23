import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const PROXY_ENTRYPOINT = new URL("../src/telegram-bot-api-proxy.mjs", import.meta.url);
const CLOUD_FILE_LIMIT = 20 * 1024 * 1024;

function json(status, value) {
  return { status, body: JSON.stringify(value), contentType: "application/json" };
}

function text(status, value) {
  return { status, body: value, contentType: "application/octet-stream" };
}

function disconnect() {
  return { disconnect: true };
}

function delayed(delayMs, response) {
  return { delayMs, response };
}

function parseUpstreamRequest(req) {
  const url = new URL(req.url || "/", "http://upstream.test");
  const apiMatch = url.pathname.match(/^\/bot([^/]+)\/([^/]+)$/u);
  if (apiMatch) {
    return {
      kind: "api",
      token: apiMatch[1],
      method: apiMatch[2],
      fileId: url.searchParams.get("file_id"),
      offset: url.searchParams.get("offset"),
      pathname: url.pathname,
    };
  }
  const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.*)$/u);
  if (fileMatch) {
    return {
      kind: "file",
      token: fileMatch[1],
      filePath: decodeURIComponent(fileMatch[2]),
      pathname: url.pathname,
    };
  }
  return { kind: "unknown", pathname: url.pathname };
}

async function startUpstream(target, handler, options = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const clientController = new AbortController();
    req.once("aborted", () => clientController.abort());
    const request = {
      target,
      ...parseUpstreamRequest(req),
      clientSignal: clientController.signal,
    };
    if (options.captureBodies) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      request.body = Buffer.concat(chunks);
    }
    requests.push(request);
    let response;
    try {
      response = await handler(request);
    } catch (error) {
      response = json(500, { ok: false, description: error.message });
    }
    if (response?.disconnect) {
      res.destroy();
      return;
    }
    if (response?.stream) return response.stream(req, res);
    if (response?.delayMs != null) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
      response = response.response;
    }
    response ||= json(404, { ok: false, description: `${target} route not mocked` });
    res.writeHead(response.status, {
      "content-type": response.contentType,
      "content-length": Buffer.byteLength(response.body),
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

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForReady(child, output, expected) {
  const deadline = Date.now() + 5000;
  while (!output.value.includes(expected)) {
    if (child.exitCode != null) {
      throw new Error(`proxy exited before startup (${child.exitCode}):\n${output.value}`);
    }
    if (Date.now() >= deadline) throw new Error(`proxy startup timed out:\n${output.value}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForOutput(output, expected) {
  const deadline = Date.now() + 1000;
  while (!output.value.includes(expected)) {
    if (Date.now() >= deadline) throw new Error(`proxy log timed out waiting for ${expected}:\n${output.value}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runProxyWithInvalidSeed(seed) {
  const port = await reservePort();
  const output = { value: "" };
  const child = spawn(process.execPath, [PROXY_ENTRYPOINT.pathname], {
    env: {
      ...process.env,
      LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      LOCAL_UPDATE_STATE_SEED: seed,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 2000);
  timeout.unref?.();
  const [code, signal] = await once(child, "exit");
  clearTimeout(timeout);
  return { code, signal, output: output.value };
}

async function startHarness(t, options) {
  const upstreamOptions = { captureBodies: options.captureBodies === true };
  const local = await startUpstream("local", options.local, upstreamOptions);
  const cloud = await startUpstream("cloud", options.cloud, upstreamOptions);
  const port = await reservePort();
  const output = { value: "" };
  const child = spawn(process.execPath, [PROXY_ENTRYPOINT.pathname], {
    env: {
      ...process.env,
      LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      LOCAL_API_ROOT: local.root,
      CLOUD_API_ROOT: cloud.root,
      ENABLE_CLOUD_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "0",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "0",
      TELEGRAM_OFFSET_DIR: "/path/that/does/not/exist",
      CLOUD_FILE_FALLBACK_MAX_BYTES: String(CLOUD_FILE_LIMIT),
      BUFFER_LIMIT_BYTES: String(8 * 1024 * 1024),
      LOCAL_HEALTH_TTL_MS: "1",
      LOCAL_UNHEALTHY_COOLDOWN_MS: "1",
      LOCAL_HEALTH_TIMEOUT_MS: "1000",
      UPSTREAM_TIMEOUT_MS: "2000",
      LOCAL_GETFILE_MAX_ATTEMPTS: "3",
      LOCAL_GETFILE_RETRY_BASE_MS: "1",
      LOCAL_GETFILE_UPSTREAM_TIMEOUT_MS: "250",
      LOCAL_GETFILE_DOWNLOAD_TIMEOUT_MS: "250",
      LOCAL_GETUPDATES_TIMEOUT_SECONDS: "10",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "4",
      LOCAL_GETUPDATES_RETRY_BASE_MS: "300",
      LOCAL_GETUPDATES_UPSTREAM_TIMEOUT_MS: "15000",
      CLOUD_PENDING_PROBE_TTL_MS: "5000",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "60000",
      CLOUD_FRESH_UPDATE_MAX_AGE_MS: String(6 * 60 * 60 * 1000),
      LOCAL_VIRTUAL_OFFSET_SKEW_MIN: "1000000",
      LOCAL_UPDATE_STATE_SEED: "",
      FILE_INFO_CACHE_TTL_MS: "300000",
      FILE_UPDATE_INFO_CACHE_TTL_MS: "1800000",
      LOCAL_FILE_PATH_REWRITE_FROM: "/container-data",
      LOCAL_FILE_PATH_REWRITE_TO: "/host-data",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });

  const expected = `listening=127.0.0.1:${port}`;
  await waitForReady(child, output, expected);

  t.after(async () => {
    if (child.exitCode == null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await Promise.all([local.close(), cloud.close()]);
  });

  return {
    local,
    cloud,
    output,
    child,
    proxyRoot: `http://127.0.0.1:${port}`,
  };
}

async function getFile(proxyRoot, token, fileId) {
  const { status, payload } = await rawGetFile(proxyRoot, token, fileId);
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  return payload.result;
}

async function rawGetFile(proxyRoot, token, fileId) {
  const response = await fetch(`${proxyRoot}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  return { status: response.status, payload: await response.json() };
}

function encodeFilePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

async function downloadFile(proxyRoot, token, filePath) {
  const response = await fetch(`${proxyRoot}/file/bot${token}/${encodeFilePath(filePath)}`);
  return { status: response.status, body: await response.text() };
}

async function getUpdates(proxyRoot, token, offset) {
  const { status, payload } = await rawGetUpdates(proxyRoot, token, offset);
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  return payload.result;
}

async function rawGetUpdates(proxyRoot, token, offset) {
  const response = await fetch(`${proxyRoot}/bot${token}/getUpdates?offset=${offset}`);
  const payload = await response.json();
  return { status: response.status, payload };
}

async function rawBotApiRequest(proxyRoot, token, method, payload) {
  const response = await fetch(`${proxyRoot}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, payload: await response.json() };
}

function healthyGetMe(request, healthy = true) {
  if (request.kind === "api" && request.method === "getMe") {
    return healthy
      ? json(200, { ok: true, result: { id: Number(request.token.split(":", 1)[0]) } })
      : json(503, { ok: false, description: "local unhealthy" });
  }
  return null;
}

test("setMessageReaction passes through local with its JSON body unchanged", async (t) => {
  const token = "700001:reaction-local-secret-1234567890";
  const payload = {
    chat_id: 123,
    message_id: 456,
    reaction: [{ type: "emoji", emoji: "👍" }],
    is_big: true,
  };
  const harness = await startHarness(t, {
    captureBodies: true,
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.method === "setMessageReaction") {
        return json(200, { ok: true, result: true });
      }
      return null;
    },
    cloud: () => json(500, { ok: false, description: "cloud must not be called" }),
  });

  assert.deepEqual(
    await rawBotApiRequest(harness.proxyRoot, token, "setMessageReaction", payload),
    { status: 200, payload: { ok: true, result: true } },
  );
  const localReaction = harness.local.requests.find(
    (request) => request.method === "setMessageReaction",
  );
  assert.deepEqual(JSON.parse(localReaction.body.toString("utf8")), payload);
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "setMessageReaction").length,
    0,
  );
});

test("reaction methods rescue local 5xx through cloud without widening unsafe status fallback", async (t) => {
  const token = "700002:reaction-fallback-secret-1234567890";
  const payloads = new Map([
    ["setMessageReaction", {
      chat_id: 123,
      message_id: 456,
      reaction: [{ type: "emoji", emoji: "🔥" }],
    }],
    ["deleteMessageReaction", { chat_id: 123, message_id: 456, user_id: 789 }],
    ["deleteAllMessageReactions", { chat_id: 123, message_id: 456 }],
  ]);
  const harness = await startHarness(t, {
    captureBodies: true,
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (payloads.has(request.method) || request.method === "sendDocument") {
        return json(503, { ok: false, description: "local unavailable" });
      }
      return null;
    },
    cloud: (request) => {
      if (payloads.has(request.method)) return json(200, { ok: true, result: true });
      return json(500, { ok: false, description: "unexpected cloud request" });
    },
  });

  for (const [method, payload] of payloads) {
    assert.deepEqual(
      await rawBotApiRequest(harness.proxyRoot, token, method, payload),
      { status: 200, payload: { ok: true, result: true } },
      method,
    );
    const localRequest = harness.local.requests.find((request) => request.method === method);
    const cloudRequest = harness.cloud.requests.find((request) => request.method === method);
    assert.deepEqual(JSON.parse(localRequest.body.toString("utf8")), payload, `${method} local body`);
    assert.deepEqual(JSON.parse(cloudRequest.body.toString("utf8")), payload, `${method} cloud body`);
  }

  const unsafePayload = { chat_id: 123, document: "file-id" };
  assert.deepEqual(
    await rawBotApiRequest(harness.proxyRoot, token, "sendDocument", unsafePayload),
    { status: 503, payload: { ok: false, description: "local unavailable" } },
  );
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "sendDocument").length,
    0,
  );
});

test("getFile still tries local when the 2-second health check aborts", async (t) => {
  const token = "710101:health-timeout-secret-1234567890";
  const harness = await startHarness(t, {
    env: {
      LOCAL_HEALTH_TIMEOUT_MS: "20",
      LOCAL_GETFILE_UPSTREAM_TIMEOUT_MS: "250",
    },
    local: (request) => {
      if (request.kind === "api" && request.method === "getMe") {
        return delayed(80, json(200, { ok: true, result: { id: 710101 } }));
      }
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, {
          ok: true,
          result: {
            file_path: "/container-data/health/photo.jpg",
            file_size: 1024,
          },
        });
      }
      return null;
    },
    cloud: () => json(500, { ok: false, description: "cloud must not be called" }),
  });

  const file = await getFile(harness.proxyRoot, token, "health-local-file");
  assert.equal(file.file_path, "/host-data/health/photo.jpg");
  assert.equal(
    harness.local.requests.filter((request) => request.method === "getFile").length,
    1,
  );
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    0,
  );
  await waitForOutput(harness.output, "local=down reason=20");
});

test("getFile retries local ETIMEDOUT and succeeds without cloud", async (t) => {
  const token = "710102:getfile-retry-secret-1234567890";
  let attempts = 0;
  const harness = await startHarness(t, {
    env: {
      LOCAL_GETFILE_UPSTREAM_TIMEOUT_MS: "20",
      LOCAL_GETFILE_RETRY_BASE_MS: "1",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        attempts += 1;
        if (attempts === 1) {
          return delayed(80, json(200, {
            ok: true,
            result: { file_path: "/container-data/late.jpg" },
          }));
        }
        return json(200, {
          ok: true,
          result: {
            file_path: "/container-data/retried.jpg",
            file_size: 2048,
          },
        });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [{
            update_id: 1,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: "retry-local-file", file_size: 2048 },
            },
          }],
        });
      }
      return null;
    },
    cloud: () => json(500, { ok: false, description: "cloud must not be called" }),
  });

  await getUpdates(harness.proxyRoot, token, 0);
  const file = await getFile(harness.proxyRoot, token, "retry-local-file");
  assert.equal(file.file_path, "/host-data/retried.jpg");
  assert.equal(attempts, 2);
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    0,
  );
  assert.match(
    harness.output.value,
    /method=getFile target=local action=retry attempt=1 timeoutMode=fallback-window reason=ETIMEDOUT/u,
  );
});

test("large local getFile uses the long download window instead of the fast fallback timeout", async (t) => {
  const token = "710108:cold-large-file-secret-1234567890";
  const fileId = "cold-four-gib-file";
  const harness = await startHarness(t, {
    env: {
      LOCAL_GETFILE_UPSTREAM_TIMEOUT_MS: "20",
      LOCAL_GETFILE_DOWNLOAD_TIMEOUT_MS: "250",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [{
            update_id: 1,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: fileId, file_size: 4 * 1024 * 1024 * 1024 },
            },
          }],
        });
      }
      if (request.kind === "api" && request.method === "getFile") {
        return delayed(80, json(200, {
          ok: true,
          result: {
            file_path: "/container-data/cold/four-gib.bin",
            file_size: 4 * 1024 * 1024 * 1024,
          },
        }));
      }
      return null;
    },
    cloud: () => json(500, { ok: false, description: "cloud must not be called" }),
  });

  await getUpdates(harness.proxyRoot, token, 0);
  const file = await getFile(harness.proxyRoot, token, fileId);
  assert.equal(file.file_path, "/host-data/cold/four-gib.bin");
  assert.equal(
    harness.local.requests.filter((request) => request.method === "getFile").length,
    1,
  );
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    0,
  );
  await waitForOutput(harness.output, "timeoutMode=download-window");
  assert.match(
    harness.output.value,
    /method=getFile target=local status=200 timeoutMode=download-window/u,
  );
});

test("downstream disconnect cancels a long local-only getFile native request", async (t) => {
  const token = "710109:cancel-long-getfile-secret-1234567890";
  let getFileStarted;
  const getFileReceived = new Promise((resolve) => { getFileStarted = resolve; });
  let upstreamAbort;
  const upstreamAborted = new Promise((resolve) => { upstreamAbort = resolve; });
  const harness = await startHarness(t, {
    env: {
      LOCAL_GETFILE_DOWNLOAD_TIMEOUT_MS: "10000",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        request.clientSignal.addEventListener("abort", upstreamAbort, { once: true });
        getFileStarted();
        return delayed(1000, json(200, {
          ok: true,
          result: { file_path: "/container-data/cold/long.bin" },
        }));
      }
      return null;
    },
    cloud: () => json(500, { ok: false, description: "cloud must not be called" }),
  });

  const downstream = http.get(`${harness.proxyRoot}/bot${token}/getFile?file_id=long-local-only`);
  downstream.on("error", () => {});
  await getFileReceived;
  downstream.destroy();

  await Promise.race([
    upstreamAborted,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("native getFile upstream request was not cancelled")),
      200,
    )),
  ]);
});

test("blocked getFile fallback preserves local authentication responses", async (t) => {
  const token = "710107:auth-response-secret-1234567890";
  let localStatus = 401;
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        return json(localStatus, {
          ok: false,
          error_code: localStatus,
          description: `local-${localStatus}`,
        });
      }
      return null;
    },
    cloud: (request) => healthyGetMe(request),
  });

  const unauthorized = await rawGetFile(harness.proxyRoot, token, "unknown-file");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.payload.description, "local-401");
  localStatus = 404;
  const missing = await rawGetFile(harness.proxyRoot, token, "unknown-file");
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.description, "local-404");
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    0,
  );
});

test("confirmed-small media-group file may use cloud after local retries are exhausted", async (t) => {
  const token = "710103:small-media-group-secret-1234567890";
  const fileId = "small-photo-large";
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                date: now,
                media_group_id: "album-1",
                photo: [
                  { file_id: "small-photo-thumb", file_size: 512 },
                  { file_id: fileId, file_size: 4096 },
                ],
              },
            },
            {
              update_id: 11,
              message: {
                date: now,
                media_group_id: "album-1",
                video: { file_id: "small-video", file_size: 8192 },
              },
            },
          ],
        });
      }
      if (request.kind === "api" && request.method === "getFile") return disconnect();
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, {
          ok: true,
          result: { file_path: "photos/small.jpg", file_size: 4096 },
        });
      }
      if (request.kind === "file") return text(200, "small-cloud-download");
      return healthyGetMe(request);
    },
  });

  await getUpdates(harness.proxyRoot, token, 0);
  const file = await getFile(harness.proxyRoot, token, fileId);
  assert.equal(file.file_path, "photos/small.jpg");
  assert.equal(
    harness.local.requests.filter((request) => request.method === "getFile").length,
    3,
  );
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    1,
  );
});

test("cloud-sourced file_id keeps cloud affinity after mandatory local getFile", async (t) => {
  const token = "710104:cloud-source-secret-1234567890";
  const fileId = "cloud-source-no-size";
  const cloudPath = "documents/cloud-source.bin";
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [] });
      }
      if (request.kind === "api" && request.method === "getFile") {
        return json(400, { ok: false, description: "Bad Request: file not found" });
      }
      if (request.kind === "file") return text(404, "wrong-local");
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 1 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [{
            update_id: 5,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: fileId },
            },
          }],
        });
      }
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, {
          ok: true,
          result: { file_path: cloudPath, file_size: 4096 },
        });
      }
      if (request.kind === "file") return text(200, `cloud:${request.filePath}`);
      return healthyGetMe(request);
    },
  });

  assert.deepEqual(
    (await getUpdates(harness.proxyRoot, token, 1000)).map((update) => update.update_id),
    [1000],
  );
  const file = await getFile(harness.proxyRoot, token, fileId);
  assert.equal(file.file_path, cloudPath);
  assert.equal(
    harness.local.requests.filter((request) => request.method === "getFile").length,
    1,
  );
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    1,
  );
  assert.deepEqual(await downloadFile(harness.proxyRoot, token, cloudPath), {
    status: 200,
    body: `cloud:${cloudPath}`,
  });
});

test("a filtered local mirror cannot overwrite delivered cloud file provenance", async (t) => {
  const token = "710105:filtered-mirror-secret-1234567890";
  const fileId = "shared-cloud-file-no-size";
  let phase = "cloud";
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "1",
      LOCAL_VIRTUAL_OFFSET_SKEW_MIN: "1",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        if (phase === "cloud") return json(200, { ok: true, result: [] });
        return json(200, {
          ok: true,
          result: [{
            update_id: 5,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: fileId },
            },
          }],
        });
      }
      if (request.kind === "api" && request.method === "getFile") {
        return disconnect();
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 1 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [{
            update_id: 10,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: fileId },
            },
          }],
        });
      }
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, {
          ok: true,
          result: { file_path: "documents/preserved-cloud.bin", file_size: 1024 },
        });
      }
      return healthyGetMe(request);
    },
  });

  assert.deepEqual(
    (await getUpdates(harness.proxyRoot, token, 1201)).map((update) => update.update_id),
    [1201],
  );
  phase = "filtered-local-mirror";
  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1202), []);

  const file = await getFile(harness.proxyRoot, token, fileId);
  assert.equal(file.file_path, "documents/preserved-cloud.bin");
  assert.equal(
    harness.cloud.requests.filter((request) => request.method === "getFile").length,
    1,
  );
});

test("media metadata capture leaves seeded getUpdates offset virtualization unchanged", async (t) => {
  const token = "710106:offset-virtualization-secret-1234567890";
  const localOffsets = [];
  const harness = await startHarness(t, {
    env: { LOCAL_UPDATE_STATE_SEED: "710106:41:9000" },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        localOffsets.push(request.offset);
        return json(200, {
          ok: true,
          result: [{
            update_id: 42,
            message: {
              date: Math.floor(Date.now() / 1000),
              audio: { file_id: "offset-audio", file_size: 2048 },
            },
          }],
        });
      }
      return null;
    },
    cloud: (request) => healthyGetMe(request),
  });

  const updates = await getUpdates(harness.proxyRoot, token, 9001);
  assert.deepEqual(localOffsets, ["42"]);
  assert.deepEqual(updates.map((update) => update.update_id), [9001]);
  assert.equal(updates[0].message.audio.file_id, "offset-audio");
});

test("local getFile serves rewritten local bytes without an upstream file endpoint", async (t) => {
  const root = await localCache(t);
  await mkdir(path.join(root, "media"));
  await writeFile(path.join(root, "media/local.ogg"), "local bytes");
  const token = "111111:local-secret-value-1234567890";
  let localHealthy = true;
  const harness = await startHarness(t, {
    env: { LOCAL_FILE_PATH_REWRITE_TO: root },
    local: (request) => {
      const health = healthyGetMe(request, localHealthy);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, {
          ok: true,
          result: { file_path: "/container-data/media/local.ogg", file_size: 11 },
        });
      }
      if (request.kind === "file") return text(200, `local:${request.filePath}`);
      return null;
    },
    cloud: (request) => request.kind === "file" ? text(200, "wrong-cloud") : healthyGetMe(request),
  });

  const file = await getFile(harness.proxyRoot, token, "local-file");
  assert.equal(file.file_path, `${root}/media/local.ogg`);
  localHealthy = false;
  await new Promise((resolve) => setTimeout(resolve, 10));

  const download = await downloadFile(harness.proxyRoot, token, file.file_path);
  assert.deepEqual(download, { status: 200, body: "local bytes" });
  assert.equal(harness.local.requests.filter((request) => request.kind === "file").length, 0);
  assert.equal(harness.cloud.requests.filter((request) => request.kind === "file").length, 0);
});

test("confirmed-small local update may fall back from local 400 and keeps the download on cloud", async (t) => {
  const token = "222222:cloud-secret-value-1234567890";
  const cloudPath = "documents/from-cloud.pdf";
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        return json(400, { ok: false, description: "Bad Request: file not found" });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [{
            update_id: 1,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: "cloud-file", file_size: 4096 },
            },
          }],
        });
      }
      if (request.kind === "file") return text(404, "wrong-local");
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, { ok: true, result: { file_path: cloudPath, file_size: 4096 } });
      }
      if (request.kind === "file") return text(200, `cloud:${request.filePath}`);
      return healthyGetMe(request);
    },
  });

  await getUpdates(harness.proxyRoot, token, 0);
  const file = await getFile(harness.proxyRoot, token, "cloud-file");
  assert.equal(file.file_path, cloudPath);
  const download = await downloadFile(harness.proxyRoot, token, file.file_path);
  assert.deepEqual(download, { status: 200, body: `cloud:${cloudPath}` });
  assert.equal(harness.local.requests.filter((request) => request.kind === "file").length, 0);
});

test("a 147 MB update never reaches cloud getFile while boundary and local-large routing stay safe", async (t) => {
  const root = await localCache(t);
  await mkdir(path.join(root, "local"));
  const large = await open(path.join(root, "local/large.bin"), "w");
  await large.truncate(CLOUD_FILE_LIMIT + 1);
  await large.close();
  const token = "333333:limit-secret-value-1234567890";
  const fileById = {
    boundary: { source: "cloud", file_path: "cloud/boundary.bin", file_size: CLOUD_FILE_LIMIT },
    over: { source: "cloud", file_path: "cloud/over.bin", file_size: 147 * 1024 * 1024 },
    localLarge: { source: "local", file_path: "/container-data/local/large.bin", file_size: CLOUD_FILE_LIMIT + 1 },
  };
  const harness = await startHarness(t, {
    env: { LOCAL_FILE_PATH_REWRITE_TO: root },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        const file = fileById[request.fileId];
        if (file?.source === "local") return json(200, { ok: true, result: file });
        return json(400, { ok: false, description: "Bad Request: file not found" });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: Object.entries(fileById).map(([fileId, file], index) => ({
            update_id: index + 1,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: fileId, file_size: file.file_size },
            },
          })),
        });
      }
      if (request.kind === "file") return text(200, `local:${request.filePath}`);
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, { ok: true, result: fileById[request.fileId] });
      }
      if (request.kind === "file") return text(200, `cloud:${request.filePath}`);
      return healthyGetMe(request);
    },
  });

  await getUpdates(harness.proxyRoot, token, 0);

  const boundary = await getFile(harness.proxyRoot, token, "boundary");
  assert.deepEqual(await downloadFile(harness.proxyRoot, token, boundary.file_path), {
    status: 200,
    body: "cloud:cloud/boundary.bin",
  });

  const over = await rawGetFile(harness.proxyRoot, token, "over");
  assert.equal(over.status, 503);
  assert.match(over.payload.description, /cloud fallback blocked \(file-too-large\)/u);

  const localLarge = await getFile(harness.proxyRoot, token, "localLarge");
  assert.equal(localLarge.file_path, `${root}/local/large.bin`);
  const localDownload = await fetch(fileUrl(harness, token, localLarge.file_path));
  assert.equal(localDownload.status, 200);
  let downloaded = 0;
  for await (const chunk of localDownload.body) downloaded += chunk.length;
  assert.equal(downloaded, CLOUD_FILE_LIMIT + 1);
  assert.equal(harness.local.requests.filter((request) => request.kind === "file").length, 0);

  const cloudDownloads = harness.cloud.requests.filter((request) => request.kind === "file");
  assert.deepEqual(cloudDownloads.map((request) => request.filePath), ["cloud/boundary.bin"]);
  assert.deepEqual(
    harness.cloud.requests
      .filter((request) => request.method === "getFile")
      .map((request) => request.fileId),
    ["boundary"],
  );
});

test("expired file metadata no longer controls download routing", async (t) => {
  const token = "444444:expiry-secret-value-1234567890";
  const cloudPath = "cloud/expired.bin";
  const harness = await startHarness(t, {
    env: { FILE_INFO_CACHE_TTL_MS: "25" },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        return json(400, { ok: false, description: "Bad Request: file not found" });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [{
            update_id: 1,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: "expires", file_size: 100 },
            },
          }],
        });
      }
      if (request.kind === "file") return text(200, "local-after-expiry");
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, { ok: true, result: { file_path: cloudPath, file_size: 100 } });
      }
      if (request.kind === "file") return text(200, "stale-cloud-affinity");
      return healthyGetMe(request);
    },
  });

  await getUpdates(harness.proxyRoot, token, 0);
  const file = await getFile(harness.proxyRoot, token, "expires");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await downloadFile(harness.proxyRoot, token, file.file_path), {
    status: 200,
    body: "local-after-expiry",
  });
  assert.equal(harness.cloud.requests.filter((request) => request.kind === "file").length, 0);
});

test("bot-scoped affinity remains isolated under parallel requests without leaking tokens", async (t) => {
  const localToken = "555555:parallel-local-secret-1234567890";
  const cloudToken = "666666:parallel-cloud-secret-1234567890";
  const sharedPath = "shared/same-name.dat";
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        if (request.token === localToken) {
          return json(200, { ok: true, result: { file_path: sharedPath, file_size: 200 } });
        }
        return json(400, { ok: false, description: "Bad Request: file not found" });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        const fileId = request.token === localToken ? "local-shared" : "cloud-shared";
        return json(200, {
          ok: true,
          result: [{
            update_id: request.token === localToken ? 1 : 2,
            message: {
              date: Math.floor(Date.now() / 1000),
              document: { file_id: fileId, file_size: 200 },
            },
          }],
        });
      }
      if (request.kind === "file") return text(200, `local:${request.token}`);
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, { ok: true, result: { file_path: sharedPath, file_size: 200 } });
      }
      if (request.kind === "file") return text(200, `cloud:${request.token}`);
      return healthyGetMe(request);
    },
  });

  await Promise.all([
    getUpdates(harness.proxyRoot, localToken, 0),
    getUpdates(harness.proxyRoot, cloudToken, 0),
  ]);
  const [localFile, cloudFile] = await Promise.all([
    getFile(harness.proxyRoot, localToken, "local-shared"),
    getFile(harness.proxyRoot, cloudToken, "cloud-shared"),
  ]);
  assert.equal(localFile.file_path, sharedPath);
  assert.equal(cloudFile.file_path, sharedPath);

  const downloads = await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const token = index % 2 === 0 ? localToken : cloudToken;
    return downloadFile(harness.proxyRoot, token, sharedPath);
  }));
  for (const [index, download] of downloads.entries()) {
    const token = index % 2 === 0 ? localToken : cloudToken;
    const source = index % 2 === 0 ? "local" : "cloud";
    assert.deepEqual(download, { status: 200, body: `${source}:${token}` });
  }

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.output.value.includes(localToken), false);
  assert.equal(harness.output.value.includes(cloudToken), false);
  assert.equal(harness.local.requests.filter((request) => request.kind === "file").length, 6);
  assert.equal(harness.cloud.requests.filter((request) => request.kind === "file").length, 6);
});

test("getUpdates normalizes business and guest messages without logging their text", async (t) => {
  const token = "766766:inbound-normalization-secret-value-1234567890";
  const now = Math.floor(Date.now() / 1000);
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [
            { update_id: 1001, business_message: { message_id: 1, date: now, chat: { id: 1 }, rich_message: { text: "business rich" } } },
            { update_id: 1002, guest_message: { message_id: 2, date: now, chat: { id: 1 }, text: "guest text" } },
            { update_id: 1003, message: { message_id: 3, date: now, chat: { id: 1 }, checklist: { title: "private checklist" } } },
          ],
        });
      }
      return null;
    },
    cloud: (request) => healthyGetMe(request),
  });

  const updates = await getUpdates(harness.proxyRoot, token, 1000);
  assert.equal(updates.length, 3);
  assert.deepEqual(updates[0].message, updates[0].business_message);
  assert.deepEqual(updates[1].message, updates[1].guest_message);
  assert.equal(updates[2].message.text, "[Telegram content received: checklist]");
  await waitForOutput(harness.output, "action=inbound-update-shape source=local update=business_message,message");
  assert.equal(harness.output.value.includes("business rich"), false);
  assert.equal(harness.output.value.includes("guest text"), false);
  assert.equal(harness.output.value.includes("private checklist"), false);
});

test("bridged local polling does not re-deliver stale updates", async (t) => {
  const token = "777777:bridge-secret-value-1234567890";
  const staleUpdate = { update_id: 5, message: { date: Math.floor(Date.now() / 1000), text: "stale" } };
  const harness = await startHarness(t, {
    env: { LOCAL_VIRTUAL_OFFSET_SKEW_MIN: "1" },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [staleUpdate] });
      }
      return null;
    },
    cloud: (request) => healthyGetMe(request),
  });

  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1000), []);
  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1001), []);
});

test("a bridge seed can re-anchor above bot-scoped durable event high-water with a stale client cursor", async (t) => {
  const token = "787878:seeded-bridge-secret-value-1234567890";
  const localOffsets = [];
  const harness = await startHarness(t, {
    env: { LOCAL_UPDATE_STATE_SEED: "787878:5:1200,797979:9:2000" },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        localOffsets.push(request.offset);
        return json(200, {
          ok: true,
          result: [{ update_id: 6, message: { date: Math.floor(Date.now() / 1000), text: "after restart" } }],
        });
      }
      return null;
    },
    cloud: (request) => healthyGetMe(request),
  });

  // The downstream ACK cursor may lag behind IDs already present in a durable
  // ingress spool. The paired anchor must keep the native request at 6 while
  // issuing the first new virtual ID above this bot's durable event high-water (1200).
  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1001)).map((update) => update.update_id), [1201]);
  assert.deepEqual(localOffsets, ["6"]);
  assert.match(harness.output.value, /localUpdateStateSeeds=2/u);
});

test("malformed, duplicate, and unsafe bridge seeds fail startup", async () => {
  const invalidSeeds = [
    "787878:5oops:1000",
    "787878:1e3:1000",
    "787878:5.9:1000",
    "787878:9007199254740992:1000",
    "9007199254740992:5:1000",
    "787878:5:1000,787878:6:1001",
    "787878:5",
  ];
  for (const seed of invalidSeeds) {
    const result = await runProxyWithInvalidSeed(seed);
    assert.notEqual(result.code, 0, `seed unexpectedly started proxy: ${seed}`);
    assert.equal(result.signal, null);
    assert.match(result.output, /LOCAL_UPDATE_STATE_SEED/u);
  }
});

test("successful empty local polling never probes cloud by default", async (t) => {
  const token = "888888:empty-local-secret-value-1234567890";
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [] });
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 9 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [{ update_id: 9 }] });
      }
      return healthyGetMe(request);
    },
  });

  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1000), []);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getWebhookInfo").length, 0);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 0);
  assert.match(harness.output.value, /cloudGetUpdatesOnLocalEmpty=disabled/u);
});

test("empty-local cloud pending rescue remains available by explicit opt-in", async (t) => {
  const token = "999999:opt-in-secret-value-1234567890";
  const freshUpdate = { update_id: 10, message: { date: Math.floor(Date.now() / 1000), text: "cloud" } };
  const cloudOffsets = [];
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [] });
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 1 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        cloudOffsets.push(request.offset);
        return json(200, { ok: true, result: request.offset === "0" ? [freshUpdate] : [] });
      }
      return healthyGetMe(request);
    },
  });

  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1000)).map((update) => update.update_id), [1000]);
  assert.deepEqual(cloudOffsets, ["0"]);
  await waitForOutput(harness.output, "fallbackReason=local-empty-pending-rescue");
  assert.match(harness.output.value, /fallbackReason=local-empty-pending-rescue/u);
});

test("opt-in rescue keeps a current edit and callback for an old message", async (t) => {
  const token = "100100:old-message-events-secret-value-1234567890";
  const now = Math.floor(Date.now() / 1000);
  const oldMessageDate = now - (7 * 60 * 60);
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [] });
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 2 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: request.offset === "0" ? [
            {
              update_id: 10,
              edited_message: { message_id: 1, date: oldMessageDate, edit_date: now, text: "edited now" },
            },
            {
              update_id: 11,
              callback_query: { id: "current-callback", message: { message_id: 1, date: oldMessageDate } },
            },
          ] : [],
        });
      }
      return healthyGetMe(request);
    },
  });

  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1000)).map((update) => update.update_id), [1000, 1001]);
});

test("opt-in rescue preserves allowed_updates and filters reaction updates by their own date", async (t) => {
  const token = "100101:reaction-updates-secret-value-1234567890";
  const now = Math.floor(Date.now() / 1000);
  const freshReaction = {
    update_id: 12,
    message_reaction: {
      chat: { id: 123, type: "private" },
      message_id: 456,
      date: now,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
      user: { id: 789, is_bot: false, first_name: "Reviewer" },
    },
  };
  const requestPayload = {
    offset: 1000,
    timeout: 0,
    allowed_updates: ["message_reaction", "message_reaction_count"],
  };
  const harness = await startHarness(t, {
    captureBodies: true,
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.method === "getUpdates") return json(200, { ok: true, result: [] });
      return null;
    },
    cloud: (request) => {
      if (request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 3 } });
      }
      if (request.method === "getUpdates") {
        return json(200, {
          ok: true,
          result: [
            {
              update_id: 10,
              message_reaction: { ...freshReaction.message_reaction, date: now - (7 * 60 * 60) },
            },
            {
              update_id: 11,
              message_reaction_count: {
                chat: { id: -100123, type: "channel" },
                message_id: 455,
                reactions: [],
              },
            },
            freshReaction,
          ],
        });
      }
      return healthyGetMe(request);
    },
  });

  const rescued = await rawBotApiRequest(
    harness.proxyRoot,
    token,
    "getUpdates",
    requestPayload,
  );
  assert.equal(rescued.status, 200);
  assert.deepEqual(rescued.payload.result, [{ ...freshReaction, update_id: 1000 }]);

  const localPoll = harness.local.requests.find((request) => request.method === "getUpdates");
  const cloudPoll = harness.cloud.requests.find((request) => request.method === "getUpdates");
  assert.deepEqual(JSON.parse(localPoll.body.toString("utf8")), requestPayload);
  assert.deepEqual(JSON.parse(cloudPoll.body.toString("utf8")), {
    ...requestPayload,
    offset: 0,
  });
});

test("getUpdates 401 and 404 stay local and never fall back to cloud", async (t) => {
  const token = "101010:auth-status-secret-value-1234567890";
  let localStatus = 401;
  const harness = await startHarness(t, {
    env: { ENABLE_CLOUD_GETUPDATES_FALLBACK: "1" },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(localStatus, { ok: false, error_code: localStatus, description: `local-${localStatus}` });
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [{ update_id: 9999 }] });
      }
      return healthyGetMe(request);
    },
  });

  const unauthorized = await rawGetUpdates(harness.proxyRoot, token, 2000);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.payload.description, "local-401");
  localStatus = 404;
  const missing = await rawGetUpdates(harness.proxyRoot, token, 2000);
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.description, "local-404");
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 0);
});

test("getUpdates 5xx fails closed without a cloud cursor and falls back after initialization", async (t) => {
  const token = "1111110:server-error-secret-value-1234567890";
  const now = Math.floor(Date.now() / 1000);
  let phase = "failure";
  const cloudOffsets = [];
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "2",
      LOCAL_GETUPDATES_RETRY_BASE_MS: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        if (phase === "prime") return json(200, { ok: true, result: [] });
        return json(503, { ok: false, description: "local unavailable" });
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 1 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        cloudOffsets.push(request.offset);
        const updateId = request.offset === "0" ? 10 : request.offset === "11" ? 11 : null;
        return json(200, {
          ok: true,
          result: updateId == null ? [] : [{ update_id: updateId, message: { date: now, text: "fallback" } }],
        });
      }
      return healthyGetMe(request);
    },
  });

  const response = await rawGetUpdates(harness.proxyRoot, token, 1000);
  assert.equal(response.status, 503);
  assert.equal(response.payload.description, "local unavailable");
  assert.equal(harness.local.requests.filter((request) => request.method === "getUpdates").length, 2);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 0);
  await waitForOutput(harness.output, "fallbackReason=cloud-cursor-uninitialized");
  assert.match(harness.output.value, /action=fallback-blocked/u);

  phase = "prime";
  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1000)).map((update) => update.update_id), [1000]);
  phase = "failure";
  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1001)).map((update) => update.update_id), [1001]);
  assert.equal(harness.local.requests.filter((request) => request.method === "getUpdates").length, 5);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 2);
  assert.deepEqual(cloudOffsets, ["0", "11"]);
  await waitForOutput(harness.output, "fallbackReason=local-5xx");
});

test("getUpdates network failure retries locally and fails closed without a cloud cursor", async (t) => {
  const token = "121212:network-secret-value-1234567890";
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "2",
      LOCAL_GETUPDATES_RETRY_BASE_MS: "0",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") return disconnect();
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [{ update_id: 10 }] });
      }
      return healthyGetMe(request);
    },
  });

  const response = await rawGetUpdates(harness.proxyRoot, token, 1000);
  assert.equal(response.status, 502);
  assert.equal(harness.local.requests.filter((request) => request.method === "getUpdates").length, 2);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 0);
  await waitForOutput(harness.output, "fallbackReason=cloud-cursor-uninitialized");
  assert.match(harness.output.value, /action=retry attempt=1/u);
  assert.match(harness.output.value, /action=fallback-blocked/u);
});

test("oversized getUpdates never bypasses buffered cursor protection", async (t) => {
  const token = "123123:oversized-getupdates-secret-value-1234567890";
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      BUFFER_LIMIT_BYTES: "16",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "1",
    },
    local: (request) => {
      if (request.kind === "api" && request.method === "getMe") return disconnect();
      if (request.kind === "api" && request.method === "getUpdates") return disconnect();
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [{ update_id: 10 }] });
      }
      return healthyGetMe(request);
    },
  });

  const response = await fetch(`${harness.proxyRoot}/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset: 1000, padding: "request-exceeds-test-buffer" }),
  });
  assert.equal(response.status, 502);
  assert.equal(harness.local.requests.filter((request) => request.method === "getUpdates").length, 0);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 0);
});

test("getUpdates timeout retries locally and fails closed without a cloud cursor", async (t) => {
  const token = "125125:timeout-secret-value-1234567890";
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "2",
      LOCAL_GETUPDATES_RETRY_BASE_MS: "0",
      LOCAL_GETUPDATES_UPSTREAM_TIMEOUT_MS: "20",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return delayed(100, json(200, { ok: true, result: [] }));
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getUpdates") {
        return json(200, { ok: true, result: [{ update_id: 10 }] });
      }
      return healthyGetMe(request);
    },
  });

  const response = await rawGetUpdates(harness.proxyRoot, token, 1000);
  assert.equal(response.status, 502);
  assert.equal(harness.local.requests.filter((request) => request.method === "getUpdates").length, 2);
  assert.equal(harness.cloud.requests.filter((request) => request.method === "getUpdates").length, 0);
  await waitForOutput(harness.output, "fallbackReason=cloud-cursor-uninitialized");
  assert.match(harness.output.value, /action=retry attempt=1/u);
  assert.match(harness.output.value, /action=fallback-blocked/u);
});

test("opt-in cloud bootstrap drains multiple stale batches before returning fresh updates", async (t) => {
  const token = "127127:stale-bootstrap-secret-value-1234567890";
  const now = Math.floor(Date.now() / 1000);
  const staleDate = now - (7 * 60 * 60);
  let phase = "rescue";
  const cloudOffsets = [];
  const staleBatch = (firstUpdateId) => Array.from({ length: 100 }, (_, index) => ({
    update_id: firstUpdateId + index,
    message: { date: staleDate, text: "stale cloud backlog" },
  }));
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "1",
      CLOUD_FRESH_UPDATE_MAX_AGE_MS: String(6 * 60 * 60 * 1000),
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getUpdates") {
        return phase === "rescue" ? json(200, { ok: true, result: [] }) : disconnect();
      }
      return null;
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 201 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        cloudOffsets.push(request.offset);
        if (request.offset === "0") return json(200, { ok: true, result: staleBatch(1) });
        if (request.offset === "101") return json(200, { ok: true, result: staleBatch(101) });
        if (request.offset === "201") {
          return json(200, {
            ok: true,
            result: [{ update_id: 201, message: { date: now, text: "fresh cloud update" } }],
          });
        }
        return json(200, { ok: true, result: [] });
      }
      return healthyGetMe(request);
    },
  });

  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1000), []);
  phase = "failure";
  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1000), []);
  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1000)).map((update) => update.update_id), [1000]);
  assert.deepEqual(cloudOffsets, ["0", "101", "201"]);
});

test("cloud-local-cloud recovery advances the shared virtual cursor", async (t) => {
  const token = "131313:recovery-secret-value-1234567890";
  const now = Math.floor(Date.now() / 1000);
  let phase = "prime";
  const cloudOffsets = [];
  const harness = await startHarness(t, {
    env: {
      ENABLE_CLOUD_GETUPDATES_FALLBACK: "1",
      ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY: "1",
      CLOUD_PENDING_FALLBACK_DELAY_MS: "0",
      LOCAL_GETUPDATES_MAX_ATTEMPTS: "1",
      LOCAL_VIRTUAL_OFFSET_SKEW_MIN: "1",
    },
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind !== "api" || request.method !== "getUpdates") return null;
      if (phase === "prime") return json(200, { ok: true, result: [] });
      if (phase === "bridge") {
        if (request.offset === "12") return json(200, { ok: true, result: [] });
        return json(200, { ok: true, result: [{ update_id: 11, message: { date: now, text: "stale local" } }] });
      }
      if (phase === "local") {
        return json(200, { ok: true, result: [{ update_id: 12, message: { date: now, text: "local" } }] });
      }
      return disconnect();
    },
    cloud: (request) => {
      if (request.kind === "api" && request.method === "getWebhookInfo") {
        return json(200, { ok: true, result: { pending_update_count: 1 } });
      }
      if (request.kind === "api" && request.method === "getUpdates") {
        cloudOffsets.push(request.offset);
        const updateId = request.offset === "0" ? 10 : request.offset === "11" ? 11 : null;
        return json(200, {
          ok: true,
          result: updateId == null ? [] : [{ update_id: updateId, message: { date: now, text: "cloud" } }],
        });
      }
      return healthyGetMe(request);
    },
  });

  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1000)).map((update) => update.update_id), [1000]);
  phase = "bridge";
  assert.deepEqual(await getUpdates(harness.proxyRoot, token, 1001), []);
  phase = "local";
  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1001)).map((update) => update.update_id), [1001]);
  phase = "network";
  assert.deepEqual((await getUpdates(harness.proxyRoot, token, 1002)).map((update) => update.update_id), [1002]);
  assert.deepEqual(cloudOffsets, ["0", "11"]);
});

// Synthetic local Bot API responses over real HTTP, through the actual proxy
// child and OS filesystem. No Telegram traffic, credentials or polling owner.
async function localCache(t) {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "proxy-local-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fileUrl(harness, token, filename) {
  return `${harness.proxyRoot}/file/bot${token}/${encodeFilePath(filename)}`;
}

async function localFileHarness(t, root, files, env = {}) {
  return startHarness(t, {
    env: { LOCAL_FILE_PATH_REWRITE_TO: root, ...env },
    local: (request) => {
      if (request.method === "getFile") {
        const file = files[request.fileId];
        if (file) return json(200, { ok: true, result: file });
        return json(400, { ok: false });
      }
      // Deliberately no /file endpoint (the real local Bot API lacks it).
      return healthyGetMe(request);
    },
    cloud: () => json(500, { ok: false, description: "cloud must not be called" }),
  });
}

const remoteToken = "123456:synthetic-remote-media-secret-only";

test("remote local getFile to HTTP bytes exceeds 20 MiB with exact length/hash, HEAD and no upstream download", async (t) => {
  const root = await localCache(t);
  const filename = path.join(root, "media space-ю.bin");
  const size = 24 * 1024 * 1024 + 123;
  const chunk = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 17) % 251;
  const expectedHash = createHash("sha256");
  const handle = await open(filename, "w");
  try {
    for (let offset = 0; offset < size; offset += chunk.length) {
      const part = chunk.subarray(0, Math.min(chunk.length, size - offset));
      await handle.writeFile(part);
      expectedHash.update(part);
    }
  } finally { await handle.close(); }
  const harness = await localFileHarness(t, root, {
    large: { file_path: "/container-data/media space-ю.bin", file_size: size },
  });
  const file = await getFile(harness.proxyRoot, remoteToken, "large");
  assert.equal(file.file_path, filename); // unchanged host-local response
  const head = await fetch(fileUrl(harness, remoteToken, file.file_path), { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(size));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const response = await fetch(fileUrl(harness, remoteToken, file.file_path));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(size));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  let received = 0;
  const hash = createHash("sha256");
  for await (const part of response.body) { received += part.length; hash.update(part); }
  assert.equal(received, size);
  assert.equal(hash.digest("hex"), expectedHash.digest("hex"));
  assert.equal(harness.local.requests.filter((r) => r.kind === "file").length, 0);
  assert.equal(harness.cloud.requests.length, 0);
  await waitForOutput(harness.output, "target=local-file");
  assert(!harness.output.value.includes(remoteToken));
  assert(!harness.output.value.includes(filename));
  t.diagnostic(`synthetic real HTTP bytes=${received}, SHA-256 matched; no Telegram requests`);
});

test("local byte grants reject missing, invalid, unrelated, other-bot and guessed same-bot tokens without fallback", async (t) => {
  const root = await localCache(t);
  await writeFile(path.join(root, "good.bin"), "good");
  await writeFile(path.join(root, "unrelated.bin"), "private");
  const harness = await localFileHarness(t, root, {
    good: { file_path: "/container-data/good.bin", file_size: 4 },
    missing: { file_path: "/container-data/missing.bin", file_size: 4 },
    outside: { file_path: `${root}-other/secret.bin`, file_size: 4 },
    invalid: { file_path: "/container-data/../secret.bin", file_size: 4 },
    unknownSize: { file_path: "/container-data/good.bin" },
    malformedSize: { file_path: "/container-data/good.bin", file_size: "4bad" },
  });
  const goodPath = path.join(root, "good.bin");
  assert.equal((await fetch(fileUrl(harness, remoteToken, goodPath))).status, 404);
  for (const id of ["missing", "outside", "invalid", "malformedSize"]) {
    const file = await getFile(harness.proxyRoot, remoteToken, id);
    const response = await fetch(fileUrl(harness, remoteToken, file.file_path));
    assert.equal(response.status, 404, id);
    assert(!(await response.text()).includes(root));
  }
  await getFile(harness.proxyRoot, remoteToken, "unknownSize");
  assert.equal((await fetch(fileUrl(harness, remoteToken, goodPath))).status, 200);
  await getFile(harness.proxyRoot, remoteToken, "good");
  for (const token of ["654321:another-bot-secret", "123456:guessed-secret-same-bot"]) {
    assert.equal((await fetch(fileUrl(harness, token, goodPath))).status, 404);
  }
  assert.equal((await fetch(fileUrl(harness, remoteToken, path.join(root, "unrelated.bin")))).status, 404);
  assert.equal((await fetch(fileUrl(harness, remoteToken, goodPath), { method: "POST" })).status, 405);
  assert.equal((await fetch(fileUrl(harness, remoteToken, goodPath))).status, 200);
  assert.equal(harness.cloud.requests.length, 0);
  assert.equal(harness.local.requests.filter((r) => r.kind === "file").length, 0);
  assert(!harness.output.value.includes(remoteToken));
});

test("local byte serving rejects symlink escape, directory, FIFO and changed size even after getFile", async (t) => {
  const root = await localCache(t);
  const outside = await localCache(t);
  await writeFile(path.join(outside, "secret.bin"), "outside");
  await symlink(path.join(outside, "secret.bin"), path.join(root, "escape.bin"));
  await symlink(outside, path.join(root, "ancestor"));
  await writeFile(path.join(root, "another-bot.bin"), "private");
  await symlink(path.join(root, "another-bot.bin"), path.join(root, "inside-link.bin"));
  await mkdir(path.join(root, "directory"));
  await writeFile(path.join(root, "changed.bin"), "short");
  const fifo = spawn("mkfifo", [path.join(root, "fifo")]);
  assert.equal((await once(fifo, "exit"))[0], 0);
  const files = {
    escape: { file_path: "/container-data/escape.bin", file_size: 7 },
    ancestor: { file_path: "/container-data/ancestor/secret.bin", file_size: 7 },
    inside: { file_path: "/container-data/inside-link.bin", file_size: 7 },
    directory: { file_path: "/container-data/directory", file_size: 4096 },
    fifo: { file_path: "/container-data/fifo", file_size: 0 },
    changed: { file_path: "/container-data/changed.bin", file_size: 6 },
  };
  const harness = await localFileHarness(t, root, files);
  for (const id of Object.keys(files)) {
    const file = await getFile(harness.proxyRoot, remoteToken, id);
    const res = await fetch(fileUrl(harness, remoteToken, file.file_path), { signal: AbortSignal.timeout(2000) });
    assert.equal(res.status, 404, id);
    await res.text();
  }
  assert.equal(harness.cloud.requests.length, 0);
});

test("local grant expires and fresh getFile renews it; zero-byte files are supported", async (t) => {
  const root = await localCache(t);
  await writeFile(path.join(root, "empty.bin"), "");
  const harness = await localFileHarness(t, root, {
    empty: { file_path: "/container-data/empty.bin", file_size: 0 },
  }, { FILE_INFO_CACHE_TTL_MS: "100" });
  const file = await getFile(harness.proxyRoot, remoteToken, "empty");
  assert.equal((await fetch(fileUrl(harness, remoteToken, file.file_path))).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal((await fetch(fileUrl(harness, remoteToken, file.file_path))).status, 404);
  await getFile(harness.proxyRoot, remoteToken, "empty");
  assert.equal((await fetch(fileUrl(harness, remoteToken, file.file_path))).status, 200);
  assert.equal(harness.cloud.requests.length, 0);
});

async function openFileDescriptors(pid, filename) {
  const names = await readdir(`/proc/${pid}/fd`);
  const links = await Promise.all(names.map((name) => readlink(`/proc/${pid}/fd/${name}`).catch(() => "")));
  return links.filter((link) => link === filename).length;
}

async function waitForNoFileDescriptor(pid, filename) {
  const deadline = Date.now() + 2000;
  while (await openFileDescriptors(pid, filename)) {
    if (Date.now() > deadline) throw new Error("local download descriptor leaked after cancellation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("slow remote download backpressures and repeated cancellation releases descriptor/counters without fallback", async (t) => {
  const root = await localCache(t);
  const filename = path.join(root, "slow.bin");
  const handle = await open(filename, "w");
  await handle.truncate(128 * 1024 * 1024); // sparse, not a new build/cache environment
  await handle.close();
  const harness = await localFileHarness(t, root, {
    slow: { file_path: "/container-data/slow.bin", file_size: 128 * 1024 * 1024 },
  });
  await getFile(harness.proxyRoot, remoteToken, "slow");
  const rss = async () => Number((await readFile(`/proc/${harness.child.pid}/status`, "utf8")).match(/^VmRSS:\s+(\d+)/m)[1]) * 1024;
  const before = await rss();
  for (let attempt = 0; attempt < 3; attempt++) {
    const req = http.get(fileUrl(harness, remoteToken, filename));
    req.on("error", () => {});
    const [res] = await once(req, "response");
    res.on("error", () => {});
    res.pause();
    assert.equal(res.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await openFileDescriptors(harness.child.pid, filename), 1, "stream should remain backpressured, not buffer entire file");
    assert((await rss()) - before < 40 * 1024 * 1024, "bounded streaming RSS");
    req.destroy();
    res.destroy();
    await waitForNoFileDescriptor(harness.child.pid, filename);
  }
  // A completed probe must see one active stream, not accumulated cancellations.
  const probe = await fetch(fileUrl(harness, remoteToken, filename), { method: "HEAD" });
  assert.equal(probe.status, 200);
  await waitForOutput(harness.output, "target=local-file stream=download status=200 activeStreaming=1");
  assert(!/target=local-file.*activeStreaming=[2-9]/u.test(harness.output.value));
  assert.equal(harness.cloud.requests.length, 0);
  assert(!harness.output.value.includes(remoteToken));
});

test("local transfer truncated after headers fails closed and releases the file", async (t) => {
  const root = await localCache(t);
  const filename = path.join(root, "truncated.bin");
  const handle = await open(filename, "w");
  await handle.truncate(128 * 1024 * 1024);
  await handle.close();
  const harness = await localFileHarness(t, root, {
    truncated: { file_path: "/container-data/truncated.bin", file_size: 128 * 1024 * 1024 },
  });
  await getFile(harness.proxyRoot, remoteToken, "truncated");
  const req = http.get(fileUrl(harness, remoteToken, filename));
  req.on("error", () => {});
  const [res] = await once(req, "response");
  res.on("error", () => {});
  res.pause();
  const writer = await open(filename, "w");
  await writer.close();
  const completed = new Promise((resolve, reject) => {
    res.on("end", () => reject(new Error("truncated transfer must not complete")));
    res.on("aborted", resolve);
  });
  res.resume();
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("truncation did not abort HTTP response")), 2000).unref()),
  ]);
  await waitForNoFileDescriptor(harness.child.pid, filename);
  assert.equal(harness.cloud.requests.length, 0);
});

test("raw encoded traversal/malformed paths cannot reuse a local grant; absent or filesystem-root config stays closed", async (t) => {
  const root = await localCache(t);
  await writeFile(path.join(root, "good.bin"), "good");
  const files = { good: { file_path: "/container-data/good.bin", file_size: 4 } };
  const harness = await localFileHarness(t, root, files);
  await getFile(harness.proxyRoot, remoteToken, "good");
  async function rawStatus(rawPath) {
    const url = new URL(harness.proxyRoot);
    const req = http.get({ hostname: url.hostname, port: url.port, path: rawPath });
    const [res] = await once(req, "response");
    res.resume();
    await once(res, "end");
    return res.statusCode;
  }
  const prefix = `/file/bot${remoteToken}/`;
  assert.equal(await rawStatus(`${prefix}${encodeURIComponent(root)}/nested/%2e%2e/good.bin`), 404);
  assert.equal(await rawStatus(`${prefix}${encodeURIComponent(root)}/%00good.bin`), 404);
  assert.equal(await rawStatus(`${prefix}%zz`), 400);
  assert.equal(await rawStatus(`${prefix}${encodeURIComponent(root)}%252Fgood.bin`), 404);
  assert.equal(harness.cloud.requests.length, 0);
  for (const config of ["", "/"]) {
    const closed = await localFileHarness(t, root, files, { LOCAL_FILE_PATH_REWRITE_TO: config });
    const file = await getFile(closed.proxyRoot, remoteToken, "good");
    assert.equal((await fetch(fileUrl(closed, remoteToken, file.file_path))).status, 404);
    assert.equal(closed.cloud.requests.length, 0);
  }
});

test("local-file deadline aborts a backpressured client and frees its descriptor", async (t) => {
  const root = await localCache(t);
  const filename = path.join(root, "deadline.bin");
  const handle = await open(filename, "w");
  await handle.truncate(128 * 1024 * 1024);
  await handle.close();
  const harness = await localFileHarness(t, root, {
    deadline: { file_path: "/container-data/deadline.bin", file_size: 128 * 1024 * 1024 },
  }, { LOCAL_GETFILE_DOWNLOAD_TIMEOUT_MS: "300" });
  await getFile(harness.proxyRoot, remoteToken, "deadline");
  const req = http.get(fileUrl(harness, remoteToken, filename));
  req.on("error", () => {});
  const [res] = await once(req, "response");
  res.on("error", () => {});
  res.pause();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await waitForNoFileDescriptor(harness.child.pid, filename);
  req.destroy();
  res.destroy();
  assert.equal(harness.cloud.requests.length, 0);
});

test("changing a configured root symlink cannot retarget a live local-file grant", async (t) => {
  const fixture = await localCache(t);
  const approved = path.join(fixture, "approved");
  const outside = path.join(fixture, "outside");
  const root = path.join(fixture, "root");
  await mkdir(approved);
  await mkdir(outside);
  await writeFile(path.join(approved, "same.bin"), "safe");
  await writeFile(path.join(outside, "same.bin"), "leak");
  await symlink(approved, root);
  const harness = await localFileHarness(t, root, {
    file: { file_path: "/container-data/same.bin", file_size: 4 },
  });
  const file = await getFile(harness.proxyRoot, remoteToken, "file");
  assert.equal((await fetch(fileUrl(harness, remoteToken, file.file_path))).status, 200);
  await rm(root);
  await symlink(outside, root);
  assert.equal((await fetch(fileUrl(harness, remoteToken, file.file_path))).status, 404);
  assert.equal(harness.cloud.requests.length, 0);
});

test("cloud-affinity download cancellation reaches the upstream stream without retry", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const harness = await startHarness(t, {
    local: (request) => {
      if (request.method === "getFile") return json(400, { ok: false });
      if (request.method === "getUpdates") return json(200, {
        ok: true, result: [{ update_id: 1, message: { document: { file_id: "small-cloud", file_size: 1024 } } }],
      });
      return healthyGetMe(request);
    },
    cloud: (request) => {
      if (request.method === "getFile") return json(200, { ok: true, result: { file_path: "cloud/small.bin", file_size: 1024 } });
      if (request.kind === "file") return { stream(req, res) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(65536);
        const pump = () => { while (!res.destroyed && res.write(chunk)) {} };
        res.on("drain", pump);
        res.once("close", upstreamClosed);
        pump();
      } };
      return healthyGetMe(request);
    },
  });
  await getUpdates(harness.proxyRoot, remoteToken, 0);
  const file = await getFile(harness.proxyRoot, remoteToken, "small-cloud");
  const req = http.get(fileUrl(harness, remoteToken, file.file_path));
  req.on("error", () => {});
  const [res] = await once(req, "response");
  res.on("error", () => {});
  res.pause();
  await new Promise((resolve) => setTimeout(resolve, 30));
  req.destroy();
  res.destroy();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream stream survived downstream cancellation")), 2000).unref())]);
  assert.equal(harness.cloud.requests.filter((r) => r.kind === "file").length, 1);
  assert.equal(harness.local.requests.filter((r) => r.kind === "file").length, 0);
});

test("upstream mid-body reset aborts the remote response without a crash or post-header fallback", async (t) => {
  const harness = await startHarness(t, {
    local: (request) => {
      if (request.kind === "file") return { stream(req, res) {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1024" });
        res.write("short");
        setTimeout(() => res.destroy(), 30);
      } };
      return healthyGetMe(request);
    },
    cloud: () => json(500, { ok: false }),
  });
  const response = await fetch(fileUrl(harness, remoteToken, "relative/file.bin"));
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer());
  assert.equal(harness.child.exitCode, null);
  assert.equal(harness.cloud.requests.length, 0);
  const healthy = await fetch(`${harness.proxyRoot}/bot${remoteToken}/getMe`);
  assert.equal(healthy.status, 200);
});
