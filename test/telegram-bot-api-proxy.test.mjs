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

function parseUpstreamRequest(req) {
  const url = new URL(req.url || "/", "http://upstream.test");
  const apiMatch = url.pathname.match(/^\/bot([^/]+)\/([^/]+)$/u);
  if (apiMatch) {
    return {
      kind: "api",
      token: apiMatch[1],
      method: apiMatch[2],
      fileId: url.searchParams.get("file_id"),
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
      TELEGRAM_OFFSET_DIR: "/path/that/does/not/exist",
      LOCAL_HEALTH_TTL_MS: "1",
      LOCAL_UNHEALTHY_COOLDOWN_MS: "1",
      LOCAL_HEALTH_TIMEOUT_MS: "1000",
      UPSTREAM_TIMEOUT_MS: "2000",
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
