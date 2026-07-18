import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
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

async function startUpstream(target, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const request = { target, ...parseUpstreamRequest(req) };
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
  const local = await startUpstream("local", options.local);
  const cloud = await startUpstream("cloud", options.cloud);
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
    proxyRoot: `http://127.0.0.1:${port}`,
  };
}

async function getFile(proxyRoot, token, fileId) {
  const response = await fetch(`${proxyRoot}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true, JSON.stringify(payload));
  return payload.result;
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

function healthyGetMe(request, healthy = true) {
  if (request.kind === "api" && request.method === "getMe") {
    return healthy
      ? json(200, { ok: true, result: { id: Number(request.token.split(":", 1)[0]) } })
      : json(503, { ok: false, description: "local unhealthy" });
  }
  return null;
}

test("local getFile keeps a rewritten local download on local", async (t) => {
  const token = "111111:local-secret-value-1234567890";
  let localHealthy = true;
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request, localHealthy);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        return json(200, {
          ok: true,
          result: { file_path: "/container-data/media/local.ogg", file_size: 1024 },
        });
      }
      if (request.kind === "file") return text(200, `local:${request.filePath}`);
      return null;
    },
    cloud: (request) => request.kind === "file" ? text(200, "wrong-cloud") : healthyGetMe(request),
  });

  const file = await getFile(harness.proxyRoot, token, "local-file");
  assert.equal(file.file_path, "/host-data/media/local.ogg");
  localHealthy = false;
  await new Promise((resolve) => setTimeout(resolve, 10));

  const download = await downloadFile(harness.proxyRoot, token, file.file_path);
  assert.deepEqual(download, { status: 200, body: "local:/host-data/media/local.ogg" });
  assert.equal(harness.cloud.requests.filter((request) => request.kind === "file").length, 0);
});

test("local 400 followed by cloud getFile keeps the download on cloud", async (t) => {
  const token = "222222:cloud-secret-value-1234567890";
  const cloudPath = "documents/from-cloud.pdf";
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        return json(400, { ok: false, description: "Bad Request: file not found" });
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

  const file = await getFile(harness.proxyRoot, token, "cloud-file");
  assert.equal(file.file_path, cloudPath);
  const download = await downloadFile(harness.proxyRoot, token, file.file_path);
  assert.deepEqual(download, { status: 200, body: `cloud:${cloudPath}` });
  assert.equal(harness.local.requests.filter((request) => request.kind === "file").length, 0);
});

test("the 20 MB cloud ceiling overrides affinity while large local files stay local", async (t) => {
  const token = "333333:limit-secret-value-1234567890";
  const fileById = {
    boundary: { source: "cloud", file_path: "cloud/boundary.bin", file_size: CLOUD_FILE_LIMIT },
    over: { source: "cloud", file_path: "cloud/over.bin", file_size: CLOUD_FILE_LIMIT + 1 },
    localLarge: { source: "local", file_path: "/container-data/local/large.bin", file_size: CLOUD_FILE_LIMIT + 1 },
  };
  const harness = await startHarness(t, {
    local: (request) => {
      const health = healthyGetMe(request);
      if (health) return health;
      if (request.kind === "api" && request.method === "getFile") {
        const file = fileById[request.fileId];
        if (file?.source === "local") return json(200, { ok: true, result: file });
        return json(400, { ok: false, description: "Bad Request: file not found" });
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

  const boundary = await getFile(harness.proxyRoot, token, "boundary");
  assert.deepEqual(await downloadFile(harness.proxyRoot, token, boundary.file_path), {
    status: 200,
    body: "cloud:cloud/boundary.bin",
  });

  const over = await getFile(harness.proxyRoot, token, "over");
  assert.deepEqual(await downloadFile(harness.proxyRoot, token, over.file_path), {
    status: 200,
    body: "local:cloud/over.bin",
  });

  const localLarge = await getFile(harness.proxyRoot, token, "localLarge");
  assert.equal(localLarge.file_path, "/host-data/local/large.bin");
  assert.deepEqual(await downloadFile(harness.proxyRoot, token, localLarge.file_path), {
    status: 200,
    body: "local:/host-data/local/large.bin",
  });

  const cloudDownloads = harness.cloud.requests.filter((request) => request.kind === "file");
  assert.deepEqual(cloudDownloads.map((request) => request.filePath), ["cloud/boundary.bin"]);
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

test("a bridge seed can re-anchor above durable high-water with a stale client cursor", async (t) => {
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
  // issuing the first new virtual ID above the durable high-water (1200).
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
