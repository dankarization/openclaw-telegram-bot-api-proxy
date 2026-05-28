#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL } from "node:url";

const listenHost = process.env.LISTEN_HOST || "127.0.0.1";
const listenPort = Number.parseInt(process.env.PORT || "8082", 10);
const localRoot = trimRoot(process.env.LOCAL_API_ROOT || "http://127.0.0.1:8081");
const cloudRoot = trimRoot(process.env.CLOUD_API_ROOT || "https://api.telegram.org");
const cloudFallbackEnabled = parseBoolean(process.env.ENABLE_CLOUD_FALLBACK, false);
const telegramOffsetDir = process.env.TELEGRAM_OFFSET_DIR || "telegram";
const cloudFileFallbackMaxBytes = Number.parseInt(process.env.CLOUD_FILE_FALLBACK_MAX_BYTES || String(20 * 1024 * 1024), 10);
const bufferLimitBytes = Number.parseInt(process.env.BUFFER_LIMIT_BYTES || String(8 * 1024 * 1024), 10);
const localHealthTtlMs = Number.parseInt(process.env.LOCAL_HEALTH_TTL_MS || "5000", 10);
const localUnhealthyCooldownMs = Number.parseInt(process.env.LOCAL_UNHEALTHY_COOLDOWN_MS || "5000", 10);
const localHealthTimeoutMs = Number.parseInt(process.env.LOCAL_HEALTH_TIMEOUT_MS || "2000", 10);
const upstreamTimeoutMs = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || "130000", 10);

let localHealthyUntil = 0;
let localUnhealthyUntil = 0;
let lastHealthLogState = "";
const cloudUpdateStateByBotId = new Map();
const fileInfoByBotIdAndPath = new Map();

function trimRoot(value) {
  return String(value || "").replace(/\/+$/u, "");
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/iu.test(String(value).trim());
}

function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function logError(message) {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function tokenFromPath(pathname) {
  const match = pathname.match(/^\/(?:file\/)?bot([^/]+)/u);
  return match ? match[1] : "";
}

function methodFromPath(pathname) {
  const botMatch = pathname.match(/^\/bot[^/]+\/([^/?#]+)/u);
  if (botMatch) return botMatch[1] || "unknown";
  if (pathname.startsWith("/file/bot")) return "file";
  return "unknown";
}

function filePathFromPathname(pathname) {
  const match = pathname.match(/^\/file\/bot[^/]+\/(.+)$/u);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isSafeMethodForStatusFallback(method) {
  return new Set([
    "getMe",
    "getUpdates",
    "getWebhookInfo",
    "deleteWebhook",
    "setMyCommands",
    "deleteMyCommands",
    "setMyDescription",
    "setMyShortDescription",
    "setMyName",
    "setChatMenuButton",
    "sendChatAction",
  ]).has(method);
}

function fileInfoKey(token, filePath) {
  return `${botIdFromToken(token)}:${filePath}`;
}

function cacheFileInfo(token, filePath, fileSize) {
  const botId = botIdFromToken(token);
  if (!botId || !filePath) return;
  fileInfoByBotIdAndPath.set(fileInfoKey(token, filePath), {
    fileSize: numericOffset(fileSize),
    cachedAt: Date.now(),
  });
}

function cachedFileInfo(token, filePath) {
  return fileInfoByBotIdAndPath.get(fileInfoKey(token, filePath)) || null;
}

function cacheGetFileResult(method, token, upstream) {
  if (method !== "getFile" || upstream.statusCode !== 200 || !upstream.body?.length) return;
  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    const filePath = payload?.result?.file_path;
    if (!payload?.ok || typeof filePath !== "string" || !filePath) return;
    cacheFileInfo(token, filePath, payload.result.file_size);
  } catch {
    // Игнорируем не-JSON и неожиданные ответы getFile.
  }
}

function canUseCloudFallback(method, token, pathname = "") {
  if (!cloudFallbackEnabled) return false;
  if (method !== "file") return true;

  const filePath = filePathFromPathname(pathname);
  const info = cachedFileInfo(token, filePath);
  return info?.fileSize != null && info.fileSize <= cloudFileFallbackMaxBytes;
}

function botIdFromToken(token) {
  return String(token || "").split(":", 1)[0] || "";
}

function numericOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function requestOffsetValue(req, body) {
  const url = new URL(req.url || "/", "http://proxy.local");
  const queryOffset = numericOffset(url.searchParams.get("offset"));
  if (queryOffset != null) return queryOffset;

  if (!body?.length) return null;
  const type = String(req.headers["content-type"] || "").toLowerCase();
  try {
    if (type.includes("application/json")) {
      const payload = JSON.parse(body.toString("utf8"));
      const jsonOffset = numericOffset(payload?.offset);
      return jsonOffset;
    }
    if (type.includes("x-www-form-urlencoded")) {
      const form = new URLSearchParams(body.toString("utf8"));
      const formOffset = numericOffset(form.get("offset"));
      return formOffset;
    }
  } catch {
    return null;
  }
  return null;
}

function requestOffsetFloor(req, body) {
  const offset = requestOffsetValue(req, body);
  return offset == null ? null : offset - 1;
}

function persistedOffsetFloor(token) {
  const botId = botIdFromToken(token);
  if (!botId) return null;
  try {
    let floor = null;
    for (const name of fs.readdirSync(telegramOffsetDir)) {
      if (!/^update-offset-.+\.json$/u.test(name)) continue;
      const raw = fs.readFileSync(`${telegramOffsetDir}/${name}`, "utf8");
      const state = JSON.parse(raw);
      if (String(state?.botId || "") !== botId) continue;
      const lastUpdateId = numericOffset(state?.lastUpdateId);
      if (lastUpdateId != null) floor = Math.max(floor ?? lastUpdateId, lastUpdateId);
    }
    return floor;
  } catch {
    return null;
  }
}

function localOffsetFloor(req, token, body) {
  const requestFloor = requestOffsetFloor(req, body);
  const persistedFloor = persistedOffsetFloor(token);
  const floor = Math.max(requestFloor ?? Number.NEGATIVE_INFINITY, persistedFloor ?? Number.NEGATIVE_INFINITY);
  return Number.isFinite(floor) ? floor : null;
}

function bodyWithOffset(req, body, offset) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (body?.length && type.includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      return { reqUrl: req.url, body: Buffer.from(JSON.stringify({ ...payload, offset })) };
    } catch {
      // Если JSON не разобрался, попробуем перенести offset в query string.
    }
  }
  if (body?.length && type.includes("x-www-form-urlencoded")) {
    const form = new URLSearchParams(body.toString("utf8"));
    form.set("offset", String(offset));
    return { reqUrl: req.url, body: Buffer.from(form.toString()) };
  }

  const url = new URL(req.url || "/", "http://proxy.local");
  url.searchParams.set("offset", String(offset));
  return { reqUrl: `${url.pathname}${url.search}`, body };
}

function cloudRequestForGetUpdates(req, method, token, body) {
  if (method !== "getUpdates") return { reqUrl: req.url, body, translated: false };
  const botId = botIdFromToken(token);
  const state = botId ? cloudUpdateStateByBotId.get(botId) : null;
  if (!state) return { reqUrl: req.url, body, translated: false };

  const requestedOffset = requestOffsetValue(req, body);
  let cloudOffset = null;
  if (state.cloudFloor != null && state.virtualFloor != null) {
    if (requestedOffset != null && requestedOffset > state.virtualFloor) {
      cloudOffset = state.cloudFloor + (requestedOffset - state.virtualFloor);
    } else {
      cloudOffset = state.cloudFloor + 1;
    }
  }
  if (cloudOffset == null) return { reqUrl: req.url, body, translated: false };
  return { ...bodyWithOffset(req, body, cloudOffset), translated: true };
}

function jsonCloudResponse(upstream, payload) {
  return {
    ...upstream,
    headers: {
      ...upstream.headers,
      "content-type": "application/json",
    },
    body: Buffer.from(JSON.stringify(payload)),
  };
}

function guardedCloudGetUpdates(req, method, token, body, upstream) {
  if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) {
    return { upstream, dropped: 0, floor: null, translated: false };
  }

  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    if (!payload?.ok || !Array.isArray(payload.result)) return { upstream, dropped: 0, floor: null, translated: false };

    const botId = botIdFromToken(token);
    const localFloor = localOffsetFloor(req, token, body);
    const state = botId ? cloudUpdateStateByBotId.get(botId) : null;
    const updateIds = payload.result.map((update) => numericOffset(update?.update_id)).filter((id) => id != null);
    const maxCloudUpdateId = updateIds.length > 0 ? Math.max(...updateIds) : null;

    if (!state && payload.result.length === 0 && botId && localFloor != null) {
      cloudUpdateStateByBotId.set(botId, { cloudFloor: null, virtualFloor: localFloor });
      return { upstream, dropped: 0, floor: localFloor, translated: false };
    }

    if (!state && localFloor != null && maxCloudUpdateId != null && maxCloudUpdateId <= localFloor) {
      if (botId) cloudUpdateStateByBotId.set(botId, { cloudFloor: maxCloudUpdateId, virtualFloor: localFloor });
      return {
        upstream: jsonCloudResponse(upstream, { ...payload, result: [] }),
        dropped: payload.result.length,
        floor: localFloor,
        translated: false,
      };
    }

    if (!state) {
      if (localFloor == null) return { upstream, dropped: 0, floor: null, translated: false };
      const result = payload.result.filter((update) => numericOffset(update?.update_id) > localFloor);
      const dropped = payload.result.length - result.length;
      return {
        upstream: dropped > 0 ? jsonCloudResponse(upstream, { ...payload, result }) : upstream,
        dropped,
        floor: localFloor,
        translated: false,
      };
    }

    const cloudBase = state.cloudFloor ?? ((updateIds.length > 0 ? Math.min(...updateIds) : 1) - 1);
    const virtualBase = state.virtualFloor ?? (localFloor ?? cloudBase);
    const result = [];
    let nextCloudFloor = state.cloudFloor ?? cloudBase;
    let nextVirtualFloor = state.virtualFloor ?? virtualBase;

    for (const update of payload.result) {
      const cloudUpdateId = numericOffset(update?.update_id);
      if (cloudUpdateId == null || cloudUpdateId <= cloudBase) continue;
      const virtualUpdateId = virtualBase + (cloudUpdateId - cloudBase);
      result.push({ ...update, update_id: virtualUpdateId });
      nextCloudFloor = Math.max(nextCloudFloor, cloudUpdateId);
      nextVirtualFloor = Math.max(nextVirtualFloor, virtualUpdateId);
    }

    if (botId && nextCloudFloor !== state.cloudFloor) {
      cloudUpdateStateByBotId.set(botId, { cloudFloor: nextCloudFloor, virtualFloor: nextVirtualFloor });
    }

    return {
      upstream: jsonCloudResponse(upstream, { ...payload, result }),
      dropped: payload.result.length - result.length,
      floor: state.virtualFloor ?? localFloor,
      translated: true,
    };
  } catch {
    return { upstream, dropped: 0, floor: null, translated: false };
  }
}

function isClearlyLocalUnavailable(error) {
  return ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"].includes(error?.code);
}

function markLocalUnhealthy(reason) {
  localHealthyUntil = 0;
  localUnhealthyUntil = Date.now() + localUnhealthyCooldownMs;
  if (lastHealthLogState !== "down") {
    lastHealthLogState = "down";
    log(`local=down reason=${reason}`);
  }
}

function markLocalHealthy() {
  localHealthyUntil = Date.now() + localHealthTtlMs;
  localUnhealthyUntil = 0;
  if (lastHealthLogState !== "up") {
    lastHealthLogState = "up";
    log("local=up");
  }
}

async function checkLocalHealth(token) {
  const now = Date.now();
  if (now < localHealthyUntil) return true;
  if (now < localUnhealthyUntil) return false;
  if (!token) return true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), localHealthTimeoutMs);
  timeout.unref?.();
  try {
    await fetch(`${localRoot}/bot${token}/getMe`, {
      method: "GET",
      signal: controller.signal,
    });
    markLocalHealthy();
    return true;
  } catch (error) {
    markLocalUnhealthy(error?.code || error?.name || "healthcheck-failed");
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function copyHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"].includes(lower)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function canBufferRequest(req) {
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  if (pathname.startsWith("/file/")) return false;
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (type.includes("multipart/form-data")) return false;
  const lengthHeader = req.headers["content-length"];
  if (lengthHeader) {
    const length = Number.parseInt(String(lengthHeader), 10);
    return Number.isFinite(length) && length <= bufferLimitBytes;
  }
  return req.method === "GET" || req.method === "HEAD" || !type || type.includes("json") || type.includes("x-www-form-urlencoded");
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > bufferLimitBytes) {
      throw Object.assign(new Error("request body exceeds proxy buffer limit"), { code: "BODY_TOO_LARGE" });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function forwardBuffered(req, root, body, reqUrl = req.url) {
  const url = `${root}${reqUrl}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), upstreamTimeoutMs);
  timeout.unref?.();
  try {
    const headers = copyHeaders(req.headers);
    if (body.length === 0) delete headers["content-length"];
    else headers["content-length"] = String(body.length);
    const response = await fetch(url, {
      method: req.method,
      headers,
      body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      signal: controller.signal,
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function writeBufferedResponse(res, upstream) {
  const headers = copyHeaders(upstream.headers);
  headers["content-length"] = String(upstream.body.length);
  res.writeHead(upstream.statusCode, headers);
  res.end(upstream.body);
}

function targetUrl(root, reqUrl) {
  return new URL(`${root}${reqUrl}`);
}

function forwardStreaming(req, res, root) {
  return new Promise((resolve, reject) => {
    const url = targetUrl(root, req.url);
    const client = url.protocol === "https:" ? https : http;
    const upstreamReq = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers: {
        ...copyHeaders(req.headers),
        host: url.host,
      },
      timeout: upstreamTimeoutMs,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, copyHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
      upstreamRes.on("end", () => resolve({ statusCode: upstreamRes.statusCode || 0 }));
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" }));
    });
    upstreamReq.on("error", reject);
    req.pipe(upstreamReq);
  });
}

async function handleBuffered(req, res, method, token, startedAt) {
  const body = await readRequestBody(req);
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const localIsHealthy = await checkLocalHealth(token);
  const cloudFallbackAllowed = canUseCloudFallback(method, token, pathname);
  if (!localIsHealthy && cloudFallbackAllowed) {
    const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
    const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
    cacheGetFileResult(method, token, cloudRaw);
    const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudRaw);
    const cloud = cloudResult.upstream;
    writeBufferedResponse(res, cloud);
    log(`method=${method} target=cloud reason=local-unhealthy status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
    return;
  }

  try {
    const local = await forwardBuffered(req, localRoot, body);
    cacheGetFileResult(method, token, local);
    if (cloudFallbackAllowed && (local.statusCode === 401 || local.statusCode === 404) && body.length <= bufferLimitBytes) {
      const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      cacheGetFileResult(method, token, cloudRaw);
      const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudRaw);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudFallbackAllowed && local.statusCode >= 500 && isSafeMethodForStatusFallback(method)) {
      const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      cacheGetFileResult(method, token, cloudRaw);
      const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudRaw);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    writeBufferedResponse(res, local);
    log(`method=${method} target=local status=${local.statusCode} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(error.code);
      const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      cacheGetFileResult(method, token, cloudRaw);
      const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudRaw);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=${error.code} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    throw error;
  }
}

async function handleStreaming(req, res, method, token, startedAt) {
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const localIsHealthy = await checkLocalHealth(token);
  const cloudFallbackAllowed = canUseCloudFallback(method, token, pathname);
  const initialRoot = localIsHealthy || !cloudFallbackAllowed ? localRoot : cloudRoot;
  const initialTarget = localIsHealthy || !cloudFallbackAllowed ? "local" : "cloud";
  try {
    const result = await forwardStreaming(req, res, initialRoot);
    log(`method=${method} target=${initialTarget} status=${result.statusCode} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && initialTarget === "local" && isClearlyLocalUnavailable(error) && (req.method === "GET" || req.method === "HEAD")) {
      markLocalUnhealthy(error.code);
      const result = await forwardStreaming(req, res, cloudRoot);
      log(`method=${method} target=cloud reason=${error.code} status=${result.statusCode} ms=${Date.now() - startedAt}`);
      return;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const method = methodFromPath(pathname);
  const token = tokenFromPath(pathname);
  try {
    if (canBufferRequest(req)) {
      await handleBuffered(req, res, method, token, startedAt);
    } else {
      await handleStreaming(req, res, method, token, startedAt);
    }
  } catch (error) {
    logError(`method=${method} error=${error?.code || error?.name || "unknown"} message=${error?.message || String(error)}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, description: "Telegram Bot API proxy upstream failure" }));
    } else {
      res.destroy(error);
    }
  }
});

server.listen(listenPort, listenHost, () => {
  log(`listening=${listenHost}:${listenPort} local=${localRoot} cloud=${cloudRoot} cloudFallback=${cloudFallbackEnabled ? "enabled" : "disabled"} cloudFileMaxBytes=${cloudFileFallbackMaxBytes}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
