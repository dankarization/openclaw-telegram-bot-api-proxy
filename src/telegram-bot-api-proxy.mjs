#!/usr/bin/env node
import http from "node:http";
import { URL } from "node:url";

import { createFallbackPolicy } from "./fallback-policy.mjs";
import { createFileRouter } from "./file-routing.mjs";
import { PerBotPollCoordinator } from "./per-bot-poll-coordinator.mjs";
import {
  applyGetUpdatesTimeoutCap,
  bodyWithOffsetAndTimeout,
  canBufferRequest,
  copyHeaders,
  numericOffset,
  requestFileId,
  streamingKind,
  telegramRouteFromPath,
} from "./request-parsing.mjs";
import { runtimeHooks } from "./runtime-hooks.mjs";
import {
  botIdFromToken,
  createLegacyUpdateBridge,
} from "./update-bridge.mjs";
import { createUpstreamClient } from "./upstream-client.mjs";

// Хост, на котором proxy принимает запросы от OpenClaw.
const listenHost = process.env.LISTEN_HOST || "127.0.0.1";
// Порт proxy; в OpenClaw этот адрес указывается как Telegram apiRoot.
const listenPort = Number.parseInt(process.env.PORT || "8082", 10);
// Основной upstream: локальный telegram-bot-api, обычно Docker-контейнер.
const localRoot = trimRoot(process.env.LOCAL_API_ROOT || "http://127.0.0.1:8081");
// Резервный upstream: официальный Telegram Bot API.
const cloudRoot = trimRoot(process.env.CLOUD_API_ROOT || "https://api.telegram.org");
// Флаг, разрешающий аварийный переход с local API на cloud API.
const cloudFallbackEnabled = parseBoolean(process.env.ENABLE_CLOUD_FALLBACK, false);
// Каталог с OpenClaw offset-файлами, по которым защищаем getUpdates от отката.
const telegramOffsetDir = process.env.TELEGRAM_OFFSET_DIR || "telegram";
// Максимальный известный размер файла, который разрешено скачать через cloud fallback.
const cloudFileFallbackMaxBytes = Number.parseInt(process.env.CLOUD_FILE_FALLBACK_MAX_BYTES || String(20 * 1024 * 1024), 10);
// TTL связи file_path с upstream, который вернул успешный getFile.
const fileInfoCacheTtlMs = parsePositiveInteger(process.env.FILE_INFO_CACHE_TTL_MS, 5 * 60 * 1000);
// TTL provenance/size metadata, собранной из getUpdates по botId + file_id.
const fileUpdateInfoCacheTtlMs = parsePositiveInteger(
  process.env.FILE_UPDATE_INFO_CACHE_TTL_MS,
  30 * 60 * 1000,
);
// Контейнерный префикс absolute file_path, который Docker Bot API возвращает в --local.
const localFilePathRewriteFrom = process.env.LOCAL_FILE_PATH_REWRITE_FROM || "";
// Host-префикс того же volume, доступный OpenClaw для прямого чтения файла.
const localFilePathRewriteTo = process.env.LOCAL_FILE_PATH_REWRITE_TO || "";
// Максимальный размер запроса, который proxy может буферизовать для повторной отправки.
const bufferLimitBytes = Number.parseInt(process.env.BUFFER_LIMIT_BYTES || String(8 * 1024 * 1024), 10);
// Время, на которое успешная проверка local API считается свежей.
const localHealthTtlMs = Number.parseInt(process.env.LOCAL_HEALTH_TTL_MS || "5000", 10);
// Пауза после ошибки local API перед новой health-check попыткой.
const localUnhealthyCooldownMs = Number.parseInt(process.env.LOCAL_UNHEALTHY_COOLDOWN_MS || "5000", 10);
// Таймаут health-check запроса getMe к local API.
const localHealthTimeoutMs = Number.parseInt(process.env.LOCAL_HEALTH_TIMEOUT_MS || "2000", 10);
// Общий таймаут запроса к upstream API.
const upstreamTimeoutMs = Number.parseInt(process.env.UPSTREAM_TIMEOUT_MS || "130000", 10);
// Ограниченный local retry для getFile не зависит от короткого health-check.
const localGetFileMaxAttempts = parsePositiveInteger(process.env.LOCAL_GETFILE_MAX_ATTEMPTS, 3);
const localGetFileRetryBaseMs = parseNonNegativeInteger(process.env.LOCAL_GETFILE_RETRY_BASE_MS, 250);
const localGetFileUpstreamTimeoutMs = parsePositiveInteger(
  process.env.LOCAL_GETFILE_UPSTREAM_TIMEOUT_MS,
  15000,
);
// Разрешает аварийный cloud fallback именно для getUpdates после local retry.
const cloudGetUpdatesFallbackEnabled = parseBoolean(process.env.ENABLE_CLOUD_GETUPDATES_FALLBACK, true);
// Разрешает rescue cloud backlog после успешного пустого local getUpdates; только явный opt-in.
const cloudGetUpdatesOnLocalEmptyEnabled = parseBoolean(process.env.ENABLE_CLOUD_GETUPDATES_ON_LOCAL_EMPTY, false);
// Максимальная длительность local getUpdates long poll в секундах; 0 превращает polling в short poll.
const localGetUpdatesTimeoutSeconds = parseNonNegativeInteger(process.env.LOCAL_GETUPDATES_TIMEOUT_SECONDS, 10);
// Количество попыток local getUpdates перед тем, как отдать ошибку или уйти в cloud fallback.
const localGetUpdatesMaxAttempts = parsePositiveInteger(process.env.LOCAL_GETUPDATES_MAX_ATTEMPTS, 4);
// Ограничиваем retained FIFO queue по публичному bot ID, чтобы body burst не рос без границы.
const maxQueuedGetUpdatesPerBot = parseNonNegativeInteger(
  process.env.MAX_QUEUED_GETUPDATES_PER_BOT,
  4,
);
// Базовая пауза между retry local getUpdates. Пауза растет экспоненциально.
const localGetUpdatesRetryBaseMs = parseNonNegativeInteger(process.env.LOCAL_GETUPDATES_RETRY_BASE_MS, 300);
// Отдельный сетевой timeout для local getUpdates, чтобы оборванный long poll не висел по общему upstream timeout.
const localGetUpdatesUpstreamTimeoutMs = parsePositiveInteger(
  process.env.LOCAL_GETUPDATES_UPSTREAM_TIMEOUT_MS,
  Math.max(5000, (localGetUpdatesTimeoutSeconds + 5) * 1000),
);
// TTL проверки cloud pending updates, чтобы не дергать getWebhookInfo на каждом long poll.
const cloudPendingProbeTtlMs = Number.parseInt(process.env.CLOUD_PENDING_PROBE_TTL_MS || "5000", 10);
// Минимальный возраст cloud pending backlog перед fallback, если local API здоров и просто пуст.
const cloudPendingFallbackDelayMs = Number.parseInt(process.env.CLOUD_PENDING_FALLBACK_DELAY_MS || "60000", 10);
// Максимальный возраст cloud update, который можно виртуально поднять над local offset.
const cloudFreshUpdateMaxAgeMs = Number.parseInt(process.env.CLOUD_FRESH_UPDATE_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10);
// Минимальная разница между OpenClaw offset и local update_id, при которой считаем, что id из разных пространств.
const localVirtualOffsetSkewMin = parsePositiveInteger(process.env.LOCAL_VIRTUAL_OFFSET_SKEW_MIN, 1000000);
// Необязательные botId:localFloor:virtualFloor anchors сохраняют affine bridge через restart.
const localUpdateStateSeed = process.env.LOCAL_UPDATE_STATE_SEED || "";

// Легкие счетчики живых streaming-запросов для operational logs.
const streamingCounters = {
  active: 0,
  upload: 0,
  download: 0,
  passthrough: 0,
};

// Момент, до которого local API считается здоровым без повторной проверки.
let localHealthyUntil = 0;
// Момент, до которого local API считается нездоровым после сетевой ошибки.
let localUnhealthyUntil = 0;
// Последнее залогированное состояние health-check, чтобы не шуметь одинаковыми строками.
let lastHealthLogState = "";
// Кэш pending_update_count из cloud getWebhookInfo по каждому botId.
const cloudPendingProbeByBotId = new Map();
// Последний ack старых local update_id, чтобы не долбить локальный Bot API одинаковым offset.
const localDroppedAckByBotId = new Map();
const updateBridge = createLegacyUpdateBridge({
  now: runtimeHooks.now,
  logger: log,
  config: {
    telegramOffsetDir,
    cloudFreshUpdateMaxAgeMs,
    localVirtualOffsetSkewMin,
    localUpdateStateSeed,
  },
});
const seededLocalUpdateStateCount = updateBridge.seededLocalUpdateStateCount;
const cloudRequestForGetUpdates = updateBridge.cloudRequestForGetUpdates.bind(updateBridge);
const localRequestForGetUpdates = updateBridge.localRequestForGetUpdates.bind(updateBridge);
const emptySuccessfulGetUpdates = updateBridge.emptySuccessfulGetUpdates.bind(updateBridge);
// Один bot получает ровно один полный getUpdates cycle; разные bot ID не блокируют друг друга.
const pollCoordinator = new PerBotPollCoordinator({
  maxPendingPerBot: maxQueuedGetUpdatesPerBot,
  now: runtimeHooks.now,
  onEvent(event) {
    if (event.type === "started" && event.queueWaitMs > 0) {
      log(`method=getUpdates action=poll-queue-start queueWaitMs=${event.queueWaitMs}`);
    }
    if (event.type === "queue-full") {
      log(`method=getUpdates action=poll-queue-rejected pending=${event.pending} maxPending=${event.maxPending}`);
    }
  },
});
const {
  forwardBuffered,
  forwardStreaming,
  probeUpstream,
} = createUpstreamClient({
  hooks: runtimeHooks,
  upstreamTimeoutMs,
});
const fileRouter = createFileRouter({
  cloudFileFallbackMaxBytes,
  fileInfoCacheTtlMs,
  fileUpdateInfoCacheTtlMs,
  localFilePathRewriteFrom,
  localFilePathRewriteTo,
  now: runtimeHooks.now,
});
const fallbackPolicy = createFallbackPolicy({
  cloudFallbackEnabled,
  cloudGetUpdatesFallbackEnabled,
  fileRouter,
});
function guardedCloudGetUpdates(req, method, token, body, upstream, options = {}) {
  const result = updateBridge.guardedCloudGetUpdates(
    req,
    method,
    token,
    body,
    upstream,
    options,
  );
  if (method === "getUpdates") {
    fileRouter.observeGetUpdatesResult(token, result.upstream, "cloud");
  }
  return result;
}

function guardedLocalGetUpdates(req, method, token, body, upstream) {
  const result = updateBridge.guardedLocalGetUpdates(
    req,
    method,
    token,
    body,
    upstream,
  );
  if (method === "getUpdates") {
    fileRouter.observeGetUpdatesResult(token, result.upstream, "local");
  }
  return result;
}

const processGetFileResult = fileRouter.processGetFileResult.bind(fileRouter);
const cloudFallbackPolicy = fallbackPolicy.cloudFallbackPolicy.bind(fallbackPolicy);
const canUseCloudFallback = fallbackPolicy.canUseCloudFallback.bind(fallbackPolicy);
const isSafeMethodForStatusFallback = fallbackPolicy.isSafeMethodForStatusFallback.bind(fallbackPolicy);
const shouldRetryCloudAfterLocalStatus = fallbackPolicy.shouldRetryCloudAfterLocalStatus.bind(fallbackPolicy);

// Убираем завершающие слэши у root URL, чтобы дальше безопасно склеивать root + req.url.
function trimRoot(value) {
  return String(value || "").replace(/\/+$/u, "");
}

// Читаем булевы env-флаги в привычных вариантах: 1/true/yes/on.
function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/iu.test(String(value).trim());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Маскируем Telegram bot token в любых лог-строках, включая неожиданные тексты ошибок.
function sanitizeLogMessage(message) {
  return String(message)
    .replace(/\/((?:file\/)?bot)(\d+):[^/\s]+/gu, "/$1$2:<hidden-token>")
    .replace(/\b(\d{5,}):[A-Za-z0-9_-]{20,}\b/gu, "$1:<hidden-token>");
}

// Пишем обычный operational log в stdout; systemd складывает его в файл.
function log(message) {
  process.stdout.write(`${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`);
}

// Ошибки идут в stderr, но systemd unit направляет stderr в тот же proxy log.
function logError(message) {
  process.stderr.write(`${new Date().toISOString()} ${sanitizeLogMessage(message)}\n`);
}

// Подтверждаем local Bot API, что старые update_id можно пропустить, иначе он будет возвращать их снова.
async function acknowledgeDroppedLocalUpdates(req, token, body, ackOffset, signal) {
  if (ackOffset == null) return;
  const botId = botIdFromToken(token);
  if (!botId) return;
  const now = Date.now();
  const cached = localDroppedAckByBotId.get(botId);
  if (cached && cached.offset === ackOffset && now - cached.sentAt < 2000) return;
  localDroppedAckByBotId.set(botId, { offset: ackOffset, sentAt: now });
  const ackRequest = bodyWithOffsetAndTimeout(req, body, ackOffset, 0);
  try {
    await forwardBuffered(req, localRoot, ackRequest.body, ackRequest.reqUrl, {
      method: "getUpdates",
      signal,
      target: "local",
    });
    log(`method=getUpdates target=local action=ack-dropped offset=${ackOffset}`);
  } catch (error) {
    logError(`method=getUpdates target=local action=ack-dropped ${errorLogFields(error)}`);
  }
}

// Для getUpdates fallback проверяем cloud backlog отдельно: local API может быть здоровым, но пустым.
async function probeCloudPendingUpdates(token, signal) {
  const botId = botIdFromToken(token);
  if (!botId) return { pending: 0, cached: false, pendingAgeMs: 0 };
  const now = Date.now();
  const cached = cloudPendingProbeByBotId.get(botId);
  if (cached && now - cached.checkedAt < cloudPendingProbeTtlMs) {
    const pendingAgeMs = cached.pending > 0 && cached.firstPendingAt ? now - cached.firstPendingAt : 0;
    log(`method=getWebhookInfo target=cloud action=cloud-pending-probe pending=${cached.pending} cached=yes pendingAgeMs=${pendingAgeMs}`);
    return { pending: cached.pending, cached: true, pendingAgeMs };
  }

  const raw = await forwardBuffered(
    { method: "GET", headers: {}, url: `/bot${token}/getWebhookInfo` },
    cloudRoot,
    Buffer.alloc(0),
    undefined,
    { method: "getWebhookInfo", signal, target: "cloud" },
  );
  let pending = 0;
  try {
    const payload = JSON.parse(raw.body.toString("utf8"));
    pending = numericOffset(payload?.result?.pending_update_count) ?? 0;
  } catch {
    pending = 0;
  }
  const firstPendingAt = pending > 0
    ? (cached?.pending > 0 && cached.firstPendingAt ? cached.firstPendingAt : now)
    : null;
  const pendingAgeMs = pending > 0 && firstPendingAt ? now - firstPendingAt : 0;
  cloudPendingProbeByBotId.set(botId, { pending, checkedAt: now, firstPendingAt });
  log(`method=getWebhookInfo target=cloud action=cloud-pending-probe pending=${pending} cached=no pendingAgeMs=${pendingAgeMs}`);
  return { pending, cached: false, pendingAgeMs };
}

function errorChain(error) {
  const chain = [];
  let current = error;
  let guard = 0;
  while (current && guard < 5) {
    chain.push(current);
    current = current.cause;
    guard += 1;
  }
  return chain;
}

function errorReason(error) {
  for (const item of errorChain(error)) {
    const code = String(item?.code || "").toUpperCase();
    if (code) return code;
  }
  for (const item of errorChain(error)) {
    const name = String(item?.name || "");
    if (name) return name;
  }
  return "unknown";
}

function errorCauseReason(error) {
  return error?.cause ? errorReason(error.cause) : "none";
}

function errorMessage(error) {
  return String(error?.message || error?.cause?.message || error || "unknown").replace(/\s+/gu, " ").slice(0, 220);
}

function errorLogFields(error) {
  return `reason=${errorReason(error)} cause=${errorCauseReason(error)} message=${JSON.stringify(errorMessage(error))}`;
}

function isClearlyLocalUnavailable(error) {
  const codes = errorChain(error).map((item) => String(item?.code || "").toUpperCase()).filter(Boolean);
  if (codes.some((code) => ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_SOCKET"].includes(code))) {
    return true;
  }
  const names = errorChain(error).map((item) => String(item?.name || "").toLowerCase()).filter(Boolean);
  if (names.some((name) => ["aborterror", "timeouterror"].includes(name))) return true;
  const message = errorChain(error).map((item) => `${item?.message || ""}`).join(" ").toLowerCase();
  return /\b(fetch failed|network request failed|socket hang up|connection reset|connection refused|network is unreachable|host is unreachable|timeout|timed out|aborted)\b/u.test(message);
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

async function checkLocalHealth(token, signal) {
  const now = Date.now();
  if (now < localHealthyUntil) return true;
  if (now < localUnhealthyUntil) return false;
  if (!token) return true;

  try {
    await probeUpstream(
      localRoot,
      `/bot${token}/getMe`,
      {
        method: "getMe",
        signal,
        target: "local",
        timeoutMs: localHealthTimeoutMs,
      },
    );
    markLocalHealthy();
    return true;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    markLocalUnhealthy(errorReason(error));
    log(`method=getMe target=local action=healthcheck-failed ${errorLogFields(error)}`);
    return false;
  }
}

function beginStreaming(kind) {
  streamingCounters.active += 1;
  streamingCounters[kind] += 1;
}

function endStreaming(kind) {
  streamingCounters.active = Math.max(0, streamingCounters.active - 1);
  streamingCounters[kind] = Math.max(0, streamingCounters[kind] - 1);
}

function streamingCounterFields() {
  return `activeStreaming=${streamingCounters.active} activeStreamingUploads=${streamingCounters.upload} activeStreamingDownloads=${streamingCounters.download} activeStreamingPassthrough=${streamingCounters.passthrough}`;
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

function sleep(ms, signal) {
  return runtimeHooks.sleep(ms, { signal });
}

function getUpdatesRetryDelayMs(attempt) {
  return localGetUpdatesRetryBaseMs * (2 ** Math.max(0, attempt - 1));
}

function getFileRetryDelayMs(attempt) {
  return localGetFileRetryBaseMs * (2 ** Math.max(0, attempt - 1));
}

async function forwardLocalBuffered(req, method, token, body, options = {}) {
  if (method === "getFile") {
    for (let attempt = 1; attempt <= localGetFileMaxAttempts; attempt += 1) {
      try {
        const upstream = await forwardBuffered(req, localRoot, body, req.url, {
          method,
          signal: options.signal,
          target: "local",
          timeoutMs: localGetFileUpstreamTimeoutMs,
        });
        if (upstream.statusCode < 500) markLocalHealthy();
        return {
          upstream,
          req,
          body,
          attempts: attempt,
          timeoutCapped: false,
          timeout: localGetFileUpstreamTimeoutMs,
        };
      } catch (error) {
        if (!isClearlyLocalUnavailable(error) || attempt >= localGetFileMaxAttempts) {
          throw error;
        }
        const waitMs = getFileRetryDelayMs(attempt);
        log(`method=getFile target=local action=retry attempt=${attempt} ${errorLogFields(error)} waitMs=${waitMs}`);
        await sleep(waitMs, options.signal);
      }
    }
  }

  if (method !== "getUpdates") {
    return {
      upstream: await forwardBuffered(req, localRoot, body, req.url, {
        method,
        signal: options.signal,
        target: "local",
      }),
      req,
      body,
      attempts: 1,
      timeoutCapped: false,
      timeout: null,
    };
  }

  const translatedRequest = localRequestForGetUpdates(req, method, token, body);
  const localRequest = applyGetUpdatesTimeoutCap(
    translatedRequest.req,
    method,
    translatedRequest.body,
    localGetUpdatesTimeoutSeconds,
  );
  let lastHttpUpstream = null;
  for (let attempt = 1; attempt <= localGetUpdatesMaxAttempts; attempt += 1) {
    try {
      const upstream = await forwardBuffered(
        localRequest.req,
        localRoot,
        localRequest.body,
        localRequest.req.url,
        {
          method,
          signal: options.signal,
          target: "local",
          timeoutMs: localGetUpdatesUpstreamTimeoutMs,
        },
      );
      if (upstream.statusCode < 500 || attempt >= localGetUpdatesMaxAttempts) {
        if (upstream.statusCode < 500) markLocalHealthy();
        return {
          upstream,
          req: localRequest.req,
          body: localRequest.body,
          attempts: attempt,
          timeoutCapped: localRequest.capped,
          timeout: localRequest.timeout,
          translatedOffset: translatedRequest.translated,
        };
      }
      lastHttpUpstream = upstream;
      const waitMs = getUpdatesRetryDelayMs(attempt);
      log(`method=getUpdates target=local action=retry attempt=${attempt} status=${upstream.statusCode} waitMs=${waitMs} timeout=${localRequest.timeout ?? "none"}`);
      await sleep(waitMs, options.signal);
    } catch (error) {
      if (!isClearlyLocalUnavailable(error) || attempt >= localGetUpdatesMaxAttempts) throw error;
      const waitMs = getUpdatesRetryDelayMs(attempt);
      log(`method=getUpdates target=local action=retry attempt=${attempt} ${errorLogFields(error)} waitMs=${waitMs} timeout=${localRequest.timeout ?? "none"}`);
      await sleep(waitMs, options.signal);
    }
  }

  return {
    upstream: lastHttpUpstream,
    req: localRequest.req,
    body: localRequest.body,
    attempts: localGetUpdatesMaxAttempts,
    timeoutCapped: localRequest.capped,
    timeout: localRequest.timeout,
    translatedOffset: translatedRequest.translated,
  };
}

function writeBufferedResponse(res, upstream) {
  const headers = copyHeaders(upstream.headers);
  headers["content-length"] = String(upstream.body.length);
  res.writeHead(upstream.statusCode, headers);
  res.end(upstream.body);
}

function writeGetFileFallbackBlocked(res, policy, localStatus) {
  const reason = policy?.reason || "policy-blocked";
  const description = `Telegram Bot API proxy: local getFile unavailable; cloud fallback blocked (${reason})`;
  const body = Buffer.from(JSON.stringify({
    ok: false,
    error_code: 503,
    description,
  }));
  res.writeHead(503, {
    "content-type": "application/json",
    "content-length": String(body.length),
  });
  res.end(body);
  return `fallbackReason=${reason} localStatus=${localStatus ?? "network-error"}`;
}

async function handleBuffered(req, res, method, token, startedAt, options = {}) {
  const signal = options.signal;
  const body = options.body ?? await readRequestBody(req);
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const localIsHealthy = await checkLocalHealth(token, signal);
  const baseCloudFallback = cloudFallbackPolicy(method, token, pathname, req);
  const cloudFallback = method === "getFile" && baseCloudFallback.allowed
    ? fileRouter.cloudGetFileFallbackDecision(token, requestFileId(req, body))
    : baseCloudFallback;
  const cloudFallbackAllowed = cloudFallback.allowed;
  if (
    method !== "getUpdates"
    && method !== "getFile"
    && !localIsHealthy
    && cloudFallbackAllowed
  ) {
    const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
    const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl, {
      method,
      signal,
      target: "cloud",
    });
    const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
    const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudProcessed);
    const cloud = cloudResult.upstream;
    writeBufferedResponse(res, cloud);
    log(`method=${method} target=cloud reason=local-unhealthy status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
    return;
  }

  try {
    const localAttempt = await forwardLocalBuffered(req, method, token, body, { signal });
    const localReq = localAttempt.req;
    const localBody = localAttempt.body;
    const localRaw = localAttempt.upstream;
    const localProcessed = processGetFileResult(method, token, localRaw, "local");
    const localGuard = guardedLocalGetUpdates(localReq, method, token, localBody, localProcessed);
    const local = localGuard.upstream;
    if (localGuard.dropped > 0) {
      log(`method=getUpdates target=local action=dropped-local-update dropped=${localGuard.dropped} floor=${localGuard.floor ?? "none"} ackOffset=${localGuard.ackOffset ?? "none"}`);
      await acknowledgeDroppedLocalUpdates(localReq, token, localBody, localGuard.ackOffset, signal);
    }
    const shouldRetryCloudForStatus = shouldRetryCloudAfterLocalStatus(
      method,
      local.statusCode,
    );
    if (
      method === "getFile"
      && !cloudFallbackAllowed
      && (
        local.statusCode >= 500
        || (
          shouldRetryCloudForStatus
          && local.statusCode !== 401
          && local.statusCode !== 404
        )
      )
    ) {
      const blockedFields = writeGetFileFallbackBlocked(
        res,
        cloudFallback,
        local.statusCode,
      );
      log(`method=getFile target=local action=fallback-blocked ${blockedFields} status=503 localAttempts=${localAttempt.attempts} ms=${Date.now() - startedAt}`);
      return;
    }
    if (
      cloudFallbackAllowed
      && shouldRetryCloudForStatus
      && body.length <= bufferLimitBytes
    ) {
      const cloudRequest = cloudRequestForGetUpdates(localReq, method, token, localBody);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl, {
        method,
        signal,
        target: "cloud",
      });
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(localReq, method, token, localBody, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudFallbackAllowed && local.statusCode >= 500 && isSafeMethodForStatusFallback(method)) {
      const cloudRequest = cloudRequestForGetUpdates(
        localReq,
        method,
        token,
        localBody,
        { requireUsableCursor: method === "getUpdates" },
      );
      if (cloudRequest.blocked) {
        writeBufferedResponse(res, local);
        log(`method=getUpdates target=local action=fallback-blocked fallbackReason=cloud-cursor-uninitialized reason=local-${local.statusCode} localAttempts=${localAttempt.attempts} status=${local.statusCode} ms=${Date.now() - startedAt}`);
        return;
      }
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl, {
        method,
        signal,
        target: "cloud",
      });
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(localReq, method, token, localBody, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud fallbackReason=local-5xx reason=local-${local.statusCode} localAttempts=${localAttempt.attempts} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudGetUpdatesOnLocalEmptyEnabled && cloudFallbackAllowed && cloudGetUpdatesFallbackEnabled && localGuard.dropped === 0 && emptySuccessfulGetUpdates(method, local)) {
      let pendingProbe = null;
      try {
        pendingProbe = await probeCloudPendingUpdates(token, signal);
      } catch (error) {
        writeBufferedResponse(res, local);
        log(`method=getWebhookInfo target=cloud action=cloud-pending-probe-failed ${errorLogFields(error)}`);
        log(`method=${method} target=local status=${local.statusCode}${localAttempt.attempts > 1 ? ` attempts=${localAttempt.attempts}` : ""}${localAttempt.timeoutCapped ? ` timeoutCapped=${localAttempt.timeout}` : ""} cloudProbe=failed ms=${Date.now() - startedAt}`);
        return;
      }
      if (pendingProbe.pending > 0) {
        if (pendingProbe.pendingAgeMs < cloudPendingFallbackDelayMs) {
          writeBufferedResponse(res, local);
          log(`method=getUpdates target=cloud action=cloud-pending-deferred pending=${pendingProbe.pending} cached=${pendingProbe.cached ? "yes" : "no"} pendingAgeMs=${pendingProbe.pendingAgeMs} minAgeMs=${cloudPendingFallbackDelayMs}`);
          log(`method=${method} target=local status=${local.statusCode}${localAttempt.attempts > 1 ? ` attempts=${localAttempt.attempts}` : ""}${localAttempt.timeoutCapped ? ` timeoutCapped=${localAttempt.timeout}` : ""} cloudProbe=deferred ms=${Date.now() - startedAt}`);
          return;
        }
        const cloudRequest = cloudRequestForGetUpdates(
          localReq,
          method,
          token,
          localBody,
          { bootstrapNativeOffset: true },
        );
        const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl, {
          method,
          signal,
          target: "cloud",
        });
        const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
        const cloudResult = guardedCloudGetUpdates(localReq, method, token, localBody, cloudProcessed, { virtualizeLowerIds: true });
        const cloud = cloudResult.upstream;
        writeBufferedResponse(res, cloud);
        log(`method=${method} target=cloud fallbackReason=local-empty-pending-rescue reason=local-empty-cloud-pending pending=${pendingProbe.pending} cached=${pendingProbe.cached ? "yes" : "no"} pendingAgeMs=${pendingProbe.pendingAgeMs} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
        return;
      }
    }
    writeBufferedResponse(res, local);
    log(`method=${method} target=local status=${local.statusCode}${localAttempt.attempts > 1 ? ` attempts=${localAttempt.attempts}` : ""}${localAttempt.timeoutCapped ? ` timeoutCapped=${localAttempt.timeout}` : ""}${localAttempt.translatedOffset ? " translatedOffset=yes" : ""}${localGuard.dropped ? ` dropped=${localGuard.dropped} floor=${localGuard.floor ?? "none"}` : ""}${localGuard.translated ? " translatedLocal=yes" : ""}${localGuard.bridged ? " bridgedLocal=yes" : ""} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(errorReason(error));
      const fallbackRequest = applyGetUpdatesTimeoutCap(req, method, body, localGetUpdatesTimeoutSeconds);
      const cloudRequest = cloudRequestForGetUpdates(
        fallbackRequest.req,
        method,
        token,
        fallbackRequest.body,
        { requireUsableCursor: method === "getUpdates" },
      );
      if (cloudRequest.blocked) {
        log(`method=getUpdates target=local action=fallback-blocked fallbackReason=cloud-cursor-uninitialized ${errorLogFields(error)} ms=${Date.now() - startedAt}`);
        throw error;
      }
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl, {
        method,
        signal,
        target: "cloud",
      });
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(fallbackRequest.req, method, token, fallbackRequest.body, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud fallbackReason=local-unavailable ${errorLogFields(error)} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (!cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(errorReason(error));
      if (method === "getFile") {
        const blockedFields = writeGetFileFallbackBlocked(res, cloudFallback, null);
        log(`method=getFile target=local action=fallback-blocked ${blockedFields} ${errorLogFields(error)} status=503 localAttempts=${localGetFileMaxAttempts} ms=${Date.now() - startedAt}`);
        return;
      }
      log(`method=${method} target=local action=fallback-blocked fallbackReason=${cloudFallback.reason} ${errorLogFields(error)} ms=${Date.now() - startedAt}`);
    }
    throw error;
  }
}

async function handleStreaming(req, res, method, token, startedAt) {
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const cloudFallback = cloudFallbackPolicy(method, token, pathname, req);
  const cloudFallbackAllowed = cloudFallback.allowed;
  const affinityTarget = method === "file" && cloudFallback.source === "local"
    ? "local"
    : method === "file" && cloudFallback.source === "cloud" && cloudFallbackAllowed
      ? "cloud"
      : null;
  const localIsHealthy = affinityTarget ? null : await checkLocalHealth(token);
  const initialTarget = affinityTarget || (localIsHealthy || !cloudFallbackAllowed ? "local" : "cloud");
  const initialRoot = initialTarget === "local" ? localRoot : cloudRoot;
  const streamKind = streamingKind(req, method);
  beginStreaming(streamKind);
  try {
    const result = await forwardStreaming(req, res, initialRoot, {
      method,
      target: initialTarget,
    });
    log(`method=${method} target=${initialTarget}${affinityTarget ? " reason=file-source-affinity" : ""} stream=${streamKind} status=${result.statusCode} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && initialTarget === "local" && isClearlyLocalUnavailable(error) && (req.method === "GET" || req.method === "HEAD")) {
      markLocalUnhealthy(errorReason(error));
      const result = await forwardStreaming(req, res, cloudRoot, {
        method,
        target: "cloud",
      });
      log(`method=${method} target=cloud ${errorLogFields(error)} stream=${streamKind} status=${result.statusCode} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
      return;
    }
    if (!cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(errorReason(error));
      log(`method=${method} target=local action=fallback-blocked fallbackReason=${cloudFallback.reason} stream=${streamKind} ${errorLogFields(error)} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
    }
    throw error;
  } finally {
    endStreaming(streamKind);
  }
}

// Верхнеуровневый HTTP-сервер принимает все запросы OpenClaw и выбирает buffered или streaming путь.
const server = http.createServer(async (req, res) => {
  const startedAt = runtimeHooks.now();
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const route = telegramRouteFromPath(pathname);
  const method = route.method;
  const token = route.token;
  const clientController = new AbortController();
  const abortClient = () => {
    if (!clientController.signal.aborted) {
      clientController.abort(new Error("downstream client disconnected"));
    }
  };
  const abortClosedResponse = () => {
    if (!res.writableEnded) abortClient();
  };
  req.once("aborted", abortClient);
  res.once("close", abortClosedResponse);
  try {
    if (!route.validEncoding) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        description: "Malformed percent-encoding in Telegram Bot API path",
      }));
      return;
    }
    if (route.unsupportedTestDc || route.missingPathMethod) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        description: route.unsupportedTestDc
          ? "Telegram Bot API test-DC routes are not supported by this proxy"
          : "Telegram Bot API method must be present in the request path",
      }));
      return;
    }
    if (method === "getUpdates") {
      // Buffer before lane acquisition: an incomplete or unauthenticated body
      // must not own upstream. Reserve bounded memory admission first so many
      // incomplete bodies cannot all reach BUFFER_LIMIT_BYTES concurrently.
      const botKey = botIdFromToken(token) || "unknown";
      const reservation = pollCoordinator.reserve(botKey);
      try {
        const body = await readRequestBody(req);
        await pollCoordinator.run(
          botKey,
          ({ signal }) => handleBuffered(
            req,
            res,
            method,
            token,
            startedAt,
            { body, signal },
          ),
          { reservation, signal: clientController.signal },
        );
      } finally {
        reservation.release();
      }
    } else if (canBufferRequest(req, bufferLimitBytes)) {
      await handleBuffered(req, res, method, token, startedAt);
    } else {
      await handleStreaming(req, res, method, token, startedAt);
    }
  } catch (error) {
    const queueFull = error?.code === "POLL_QUEUE_FULL";
    if (queueFull) {
      req.resume();
      log(`method=getUpdates action=poll-queue-rejected status=429`);
    } else {
      logError(`method=${method} ${errorLogFields(error)}`);
    }
    if (!res.headersSent && !res.destroyed && !res.writableEnded) {
      const statusCode = queueFull ? 429 : 502;
      res.writeHead(statusCode, {
        "content-type": "application/json",
        ...(queueFull ? { "retry-after": "1" } : {}),
      });
      res.end(JSON.stringify({
        ok: false,
        error_code: statusCode,
        description: queueFull
          ? "Too many concurrent getUpdates requests for this bot"
          : "Telegram Bot API proxy upstream failure",
      }));
    } else if (!res.destroyed && !res.writableEnded) {
      res.destroy(error);
    }
  } finally {
    req.removeListener("aborted", abortClient);
    res.removeListener("close", abortClosedResponse);
  }
});

// Запускаем listener только после полной инициализации правил fallback и in-memory state.
server.listen(listenPort, listenHost, () => {
  log(`listening=${listenHost}:${listenPort} local=${localRoot} cloud=${cloudRoot} cloudFallback=${cloudFallbackEnabled ? "enabled" : "disabled"} cloudGetUpdatesFallback=${cloudGetUpdatesFallbackEnabled ? "enabled" : "disabled"} cloudGetUpdatesOnLocalEmpty=${cloudGetUpdatesOnLocalEmptyEnabled ? "enabled" : "disabled"} cloudPendingFallbackDelayMs=${cloudPendingFallbackDelayMs} localGetUpdatesTimeout=${localGetUpdatesTimeoutSeconds} localGetUpdatesAttempts=${localGetUpdatesMaxAttempts} maxQueuedGetUpdatesPerBot=${maxQueuedGetUpdatesPerBot} localGetFileTimeoutMs=${localGetFileUpstreamTimeoutMs} localGetFileAttempts=${localGetFileMaxAttempts} localVirtualOffsetSkewMin=${localVirtualOffsetSkewMin} localUpdateStateSeeds=${seededLocalUpdateStateCount} cloudFileMaxBytes=${cloudFileFallbackMaxBytes} fileInfoCacheTtlMs=${fileInfoCacheTtlMs} fileUpdateInfoCacheTtlMs=${fileUpdateInfoCacheTtlMs}`);
});

// При остановке systemd закрываем listener штатно, но не зависаем дольше пяти секунд.
process.on("SIGTERM", () => {
  pollCoordinator.close(new Error("proxy is shutting down"));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
