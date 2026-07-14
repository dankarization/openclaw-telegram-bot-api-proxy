#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { URL } from "node:url";

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
// Контейнерный префикс absolute file_path, который Docker Bot API возвращает в --local.
const localFilePathRewriteFrom = trimPathPrefix(process.env.LOCAL_FILE_PATH_REWRITE_FROM || "");
// Host-префикс того же volume, доступный OpenClaw для прямого чтения файла.
const localFilePathRewriteTo = trimPathPrefix(process.env.LOCAL_FILE_PATH_REWRITE_TO || "");
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
// Разрешает аварийный cloud fallback именно для getUpdates после local retry.
const cloudGetUpdatesFallbackEnabled = parseBoolean(process.env.ENABLE_CLOUD_GETUPDATES_FALLBACK, true);
// Максимальная длительность local getUpdates long poll в секундах; 0 превращает polling в short poll.
const localGetUpdatesTimeoutSeconds = parseNonNegativeInteger(process.env.LOCAL_GETUPDATES_TIMEOUT_SECONDS, 10);
// Количество попыток local getUpdates перед тем, как отдать ошибку или уйти в cloud fallback.
const localGetUpdatesMaxAttempts = parsePositiveInteger(process.env.LOCAL_GETUPDATES_MAX_ATTEMPTS, 4);
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

// Служебные методы local/cloud Bot API, которые не отправляют пользовательский контент.
const localAdminMethods = new Set(["getMe", "getUpdates", "getWebhookInfo", "deleteWebhook"]);
// Методы, которые можно отправить в cloud fallback без передачи тяжелых файловых тел.
const safeCloudFallbackMethods = new Set([
  ...localAdminMethods,
  "getFile",
  "sendMessage",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
  "deleteMessage",
  "answerCallbackQuery",
  "sendChatAction",
  "setMyCommands",
  "deleteMyCommands",
  "setMyDescription",
  "setMyShortDescription",
  "setMyName",
  "setChatMenuButton",
]);
// Методы владения token/webhook не фолбечим в cloud автоматически.
const localOnlyMethods = new Set(["close", "logOut", "logout", "setWebhook"]);
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
// Отдельный cloud cursor по каждому botId для безопасного fallback getUpdates.
const cloudUpdateStateByBotId = new Map();
// Перевод local update_id в виртуальную шкалу после cloud getUpdates fallback.
const localUpdateStateByBotId = new Map();
// Кэш getFile metadata: размер ограничивает cloud download, source сохраняет upstream affinity.
const fileInfoByBotIdAndPath = new Map();
// Кэш pending_update_count из cloud getWebhookInfo по каждому botId.
const cloudPendingProbeByBotId = new Map();
// Последний ack старых local update_id, чтобы не долбить локальный Bot API одинаковым offset.
const localDroppedAckByBotId = new Map();

// Убираем завершающие слэши у root URL, чтобы дальше безопасно склеивать root + req.url.
function trimRoot(value) {
  return String(value || "").replace(/\/+$/u, "");
}

// Убираем хвостовые слэши у префиксов путей, чтобы сопоставление было стабильным.
function trimPathPrefix(value) {
  return String(value || "").replace(/\/+$/u, "");
}

// Переписываем container path в host path для getFile от local Docker Bot API.
function rewriteLocalFilePath(filePath) {
  if (!localFilePathRewriteFrom || !localFilePathRewriteTo || typeof filePath !== "string") return filePath;
  if (filePath === localFilePathRewriteFrom) return localFilePathRewriteTo;
  if (filePath.startsWith(`${localFilePathRewriteFrom}/`)) {
    return `${localFilePathRewriteTo}${filePath.slice(localFilePathRewriteFrom.length)}`;
  }
  return filePath;
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

// Достаём bot token из Telegram API path вида /bot<TOKEN>/... или /file/bot<TOKEN>/...
function tokenFromPath(pathname) {
  const match = pathname.match(/^\/(?:file\/)?bot([^/]+)/u);
  return match ? match[1] : "";
}

// Нормализуем имя Telegram API метода, чтобы одна политика работала для buffered и streaming путей.
function methodFromPath(pathname) {
  const botMatch = pathname.match(/^\/bot[^/]+\/([^/?#]+)/u);
  if (botMatch) return botMatch[1] || "unknown";
  if (pathname.startsWith("/file/bot")) return "file";
  return "unknown";
}

// Вытаскиваем file_path из /file/bot<TOKEN>/<file_path> для проверки размера перед cloud fallback.
function filePathFromPathname(pathname) {
  const match = pathname.match(/^\/file\/bot[^/]+\/(.+)$/u);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

// Методы из safeCloudFallbackMethods можно повторить через cloud, если local вернул серверную ошибку.
function isSafeMethodForStatusFallback(method) {
  return safeCloudFallbackMethods.has(method);
}

// Cloud getUpdates может вернуть file_id, который local Bot API ещё не видел.
// В этом случае local getFile отвечает 400, но cloud API всё ещё может его разрешить.
function shouldRetryCloudAfterLocalStatus(method, statusCode) {
  if (statusCode === 401 || statusCode === 404) return true;
  if (method === "getFile" && statusCode === 400) return true;
  return false;
}

// Ключ кэша привязан к botId, но не содержит секретную часть token.
function fileInfoKey(token, filePath) {
  return `${botIdFromToken(token)}:${filePath}`;
}

function pruneExpiredFileInfo(now = Date.now()) {
  for (const [key, info] of fileInfoByBotIdAndPath) {
    if (now - info.cachedAt >= fileInfoCacheTtlMs) fileInfoByBotIdAndPath.delete(key);
  }
}

function cacheFileInfo(token, filePath, fileSize, source) {
  const botId = botIdFromToken(token);
  if (!botId || !filePath || (source !== "local" && source !== "cloud")) return;
  const now = Date.now();
  pruneExpiredFileInfo(now);
  fileInfoByBotIdAndPath.set(fileInfoKey(token, filePath), {
    fileSize: numericOffset(fileSize),
    source,
    cachedAt: now,
  });
}

function cachedFileInfo(token, filePath) {
  const key = fileInfoKey(token, filePath);
  const info = fileInfoByBotIdAndPath.get(key);
  if (!info) return null;
  if (Date.now() - info.cachedAt >= fileInfoCacheTtlMs) {
    fileInfoByBotIdAndPath.delete(key);
    return null;
  }
  return info;
}

function processGetFileResult(method, token, upstream, target) {
  if (method !== "getFile" || upstream.statusCode !== 200 || !upstream.body?.length) return upstream;
  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    const filePath = payload?.result?.file_path;
    if (!payload?.ok || typeof filePath !== "string" || !filePath) return upstream;
    const rewrittenFilePath = target === "local" ? rewriteLocalFilePath(filePath) : filePath;
    cacheFileInfo(token, filePath, payload.result.file_size, target);
    if (rewrittenFilePath !== filePath) {
      cacheFileInfo(token, rewrittenFilePath, payload.result.file_size, target);
      return {
        ...upstream,
        headers: {
          ...upstream.headers,
          "content-type": "application/json",
        },
        body: Buffer.from(JSON.stringify({
          ...payload,
          result: {
            ...payload.result,
            file_path: rewrittenFilePath,
          },
        })),
      };
    }
  } catch {
    // Игнорируем не-JSON и неожиданные ответы getFile.
  }
  return upstream;
}

function contentType(req) {
  return String(req?.headers?.["content-type"] || "").toLowerCase();
}

function isMultipartUploadRequest(req) {
  return contentType(req).includes("multipart/form-data");
}

function cloudFallbackPolicy(method, token, pathname = "", req = null) {
  if (!cloudFallbackEnabled) return { allowed: false, reason: "fallback-disabled" };
  if (method === "getUpdates" && !cloudGetUpdatesFallbackEnabled) {
    return { allowed: false, reason: "cloud-getupdates-fallback-disabled" };
  }
  if (localOnlyMethods.has(method)) return { allowed: false, reason: "local-only-method" };
  if (req && isMultipartUploadRequest(req)) return { allowed: false, reason: "multipart-upload-local-only" };

  if (method !== "file") {
    if (safeCloudFallbackMethods.has(method)) return { allowed: true, reason: "safe-method" };
    return { allowed: true, reason: "default-non-file-method" };
  }

  const filePath = filePathFromPathname(pathname);
  const info = cachedFileInfo(token, filePath);
  if (info?.fileSize == null) return { allowed: false, reason: "file-size-unknown" };
  if (info.source === "local") return { allowed: false, reason: "file-source-local", source: "local" };
  if (info.fileSize > cloudFileFallbackMaxBytes) return { allowed: false, reason: "file-too-large" };
  if (info.source !== "cloud") return { allowed: false, reason: "file-source-unknown" };
  return { allowed: true, reason: "file-source-cloud", source: "cloud" };
}

function canUseCloudFallback(method, token, pathname = "", req = null) {
  return cloudFallbackPolicy(method, token, pathname, req).allowed;
}

function botIdFromToken(token) {
  return String(token || "").split(":", 1)[0] || "";
}

function numericOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Ищем timestamp update в основных типах Telegram update, чтобы не оживлять совсем старые cloud сообщения.
function updateDateMs(update) {
  const seconds = numericOffset(
    update?.message?.date
      ?? update?.edited_message?.date
      ?? update?.channel_post?.date
      ?? update?.edited_channel_post?.date
      ?? update?.callback_query?.message?.date
      ?? update?.my_chat_member?.date
      ?? update?.chat_member?.date
      ?? update?.chat_join_request?.date
      ?? null,
  );
  return seconds == null ? null : seconds * 1000;
}

// Cloud fallback может поднимать только свежие updates; без даты считаем update допустимым.
function isFreshCloudUpdate(update) {
  const dateMs = updateDateMs(update);
  if (dateMs == null) return true;
  return Date.now() - dateMs <= cloudFreshUpdateMaxAgeMs;
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

function bodyWithTimeout(req, body, timeoutValue) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (body?.length && type.includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      return {
        reqUrl: req.url,
        body: Buffer.from(JSON.stringify({ ...payload, timeout: timeoutValue })),
      };
    } catch {
      // Если JSON не разобрался, попробуем перенести timeout в query string.
    }
  }
  if (body?.length && type.includes("x-www-form-urlencoded")) {
    const form = new URLSearchParams(body.toString("utf8"));
    form.set("timeout", String(timeoutValue));
    return { reqUrl: req.url, body: Buffer.from(form.toString()) };
  }

  const url = new URL(req.url || "/", "http://proxy.local");
  url.searchParams.set("timeout", String(timeoutValue));
  return { reqUrl: `${url.pathname}${url.search}`, body };
}

// Для служебного ack local getUpdates ставим timeout=0, чтобы не ждать long polling.
function bodyWithOffsetAndTimeout(req, body, offset, timeoutValue) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (body?.length && type.includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      return {
        reqUrl: req.url,
        body: Buffer.from(JSON.stringify({ ...payload, offset, timeout: timeoutValue })),
      };
    } catch {
      // Если JSON не разобрался, попробуем перенести offset и timeout в query string.
    }
  }
  if (body?.length && type.includes("x-www-form-urlencoded")) {
    const form = new URLSearchParams(body.toString("utf8"));
    form.set("offset", String(offset));
    form.set("timeout", String(timeoutValue));
    return { reqUrl: req.url, body: Buffer.from(form.toString()) };
  }

  const url = new URL(req.url || "/", "http://proxy.local");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("timeout", String(timeoutValue));
  return { reqUrl: `${url.pathname}${url.search}`, body };
}

function requestTimeoutValue(req, body) {
  const url = new URL(req.url || "/", "http://proxy.local");
  const queryTimeout = numericOffset(url.searchParams.get("timeout"));
  if (queryTimeout != null) return queryTimeout;

  if (!body?.length) return null;
  const type = String(req.headers["content-type"] || "").toLowerCase();
  try {
    if (type.includes("application/json")) {
      const payload = JSON.parse(body.toString("utf8"));
      return numericOffset(payload?.timeout);
    }
    if (type.includes("x-www-form-urlencoded")) {
      const form = new URLSearchParams(body.toString("utf8"));
      return numericOffset(form.get("timeout"));
    }
  } catch {
    return null;
  }
  return null;
}

function requestWithUrl(req, reqUrl) {
  if (reqUrl === req.url) return req;
  return {
    method: req.method,
    headers: req.headers,
    url: reqUrl,
  };
}

function applyGetUpdatesTimeoutCap(req, method, body) {
  if (method !== "getUpdates") return { req, body, capped: false, timeout: null };
  const currentTimeout = requestTimeoutValue(req, body);
  if (currentTimeout != null && currentTimeout <= localGetUpdatesTimeoutSeconds) {
    return { req, body, capped: false, timeout: currentTimeout };
  }
  const updated = bodyWithTimeout(req, body, localGetUpdatesTimeoutSeconds);
  return {
    req: requestWithUrl(req, updated.reqUrl),
    body: updated.body,
    capped: currentTimeout !== localGetUpdatesTimeoutSeconds,
    timeout: localGetUpdatesTimeoutSeconds,
  };
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

function localRequestForGetUpdates(req, method, token, body) {
  if (method !== "getUpdates") return { req: requestWithUrl(req, req.url), body, translated: false };
  const botId = botIdFromToken(token);
  const state = botId ? localUpdateStateByBotId.get(botId) : null;
  if (!state || state.localFloor == null || state.virtualFloor == null) {
    return { req: requestWithUrl(req, req.url), body, translated: false };
  }

  const requestedOffset = requestOffsetValue(req, body);
  let localOffset = state.localFloor + 1;
  if (requestedOffset != null && requestedOffset > state.virtualFloor) {
    localOffset = state.localFloor + (requestedOffset - state.virtualFloor);
  }
  const translated = bodyWithOffset(req, body, localOffset);
  return {
    req: requestWithUrl(req, translated.reqUrl),
    body: translated.body,
    translated: true,
  };
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

function guardedCloudGetUpdates(req, method, token, body, upstream, options = {}) {
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

    // Когда local API здоров, но пуст, а cloud держит свежие updates с меньшими id,
    // виртуально переносим cloud id выше local offset, чтобы OpenClaw не откатил cursor.
    if (!state && options.virtualizeLowerIds && botId && localFloor != null && maxCloudUpdateId != null) {
      const fresh = payload.result.filter(isFreshCloudUpdate);
      const freshUpdateIds = fresh.map((update) => numericOffset(update?.update_id)).filter((id) => id != null);
      if (freshUpdateIds.length === 0) {
        cloudUpdateStateByBotId.set(botId, { cloudFloor: maxCloudUpdateId, virtualFloor: localFloor });
        log(`method=getUpdates target=cloud action=virtualized-update-id result=0 dropped=${payload.result.length} floor=${localFloor} reason=stale-cloud-updates`);
        return {
          upstream: jsonCloudResponse(upstream, { ...payload, result: [] }),
          dropped: payload.result.length,
          floor: localFloor,
          translated: true,
        };
      }

      const cloudBase = Math.min(...freshUpdateIds) - 1;
      const virtualBase = localFloor;
      let nextCloudFloor = cloudBase;
      let nextVirtualFloor = virtualBase;
      const result = fresh.map((update) => {
        const cloudUpdateId = numericOffset(update?.update_id);
        const virtualUpdateId = virtualBase + (cloudUpdateId - cloudBase);
        nextCloudFloor = Math.max(nextCloudFloor, cloudUpdateId);
        nextVirtualFloor = Math.max(nextVirtualFloor, virtualUpdateId);
        return { ...update, update_id: virtualUpdateId };
      });
      cloudUpdateStateByBotId.set(botId, { cloudFloor: nextCloudFloor, virtualFloor: nextVirtualFloor });
      log(`method=getUpdates target=cloud action=virtualized-update-id count=${result.length} dropped=${payload.result.length - result.length} cloudFloor=${nextCloudFloor} virtualFloor=${nextVirtualFloor}`);
      return {
        upstream: jsonCloudResponse(upstream, { ...payload, result }),
        dropped: payload.result.length - result.length,
        floor: localFloor,
        translated: true,
      };
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
      log(`method=getUpdates target=cloud action=virtualized-update-id count=${result.length} dropped=${payload.result.length - result.length} cloudFloor=${nextCloudFloor} virtualFloor=${nextVirtualFloor}`);
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

// Проверяем, что local getUpdates ответил штатно, но без новых сообщений.
function emptySuccessfulGetUpdates(method, upstream) {
  if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) return false;
  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    return Boolean(payload?.ok && Array.isArray(payload.result) && payload.result.length === 0);
  } catch {
    return false;
  }
}

function shouldBridgeLocalUpdateIds(floor, localUpdateId, updates) {
  if (floor == null || localUpdateId == null || floor <= localUpdateId) return false;
  if (floor - localUpdateId < localVirtualOffsetSkewMin) return false;
  return updates.some(isFreshCloudUpdate);
}

function bridgeLocalUpdateIds(botId, localFloor, virtualFloor) {
  if (!botId || localFloor == null || virtualFloor == null) return false;
  const previous = localUpdateStateByBotId.get(botId);
  if (previous && previous.localFloor === localFloor && previous.virtualFloor === virtualFloor) return false;
  localUpdateStateByBotId.set(botId, { localFloor, virtualFloor });
  log(`method=getUpdates target=local action=bridge-local-update-ids localFloor=${localFloor} virtualFloor=${virtualFloor}`);
  return true;
}

function translateLocalUpdatesWithBridge(token, payload) {
  const botId = botIdFromToken(token);
  const state = botId ? localUpdateStateByBotId.get(botId) : null;
  if (!state || state.localFloor == null || state.virtualFloor == null) return null;

  const result = [];
  let dropped = 0;
  let maxDroppedUpdateId = null;
  let nextLocalFloor = state.localFloor;
  let nextVirtualFloor = state.virtualFloor;
  for (const update of payload.result) {
    const localUpdateId = numericOffset(update?.update_id);
    if (localUpdateId == null) {
      dropped += 1;
      continue;
    }
    if (localUpdateId <= state.localFloor) {
      dropped += 1;
      maxDroppedUpdateId = Math.max(maxDroppedUpdateId ?? localUpdateId, localUpdateId);
      continue;
    }
    const virtualUpdateId = state.virtualFloor + (localUpdateId - state.localFloor);
    result.push({ ...update, update_id: virtualUpdateId });
    nextLocalFloor = Math.max(nextLocalFloor, localUpdateId);
    nextVirtualFloor = Math.max(nextVirtualFloor, virtualUpdateId);
  }

  if (nextLocalFloor !== state.localFloor || nextVirtualFloor !== state.virtualFloor) {
    localUpdateStateByBotId.set(botId, { localFloor: nextLocalFloor, virtualFloor: nextVirtualFloor });
    log(`method=getUpdates target=local action=virtualized-local-update-id count=${result.length} dropped=${dropped} localFloor=${nextLocalFloor} virtualFloor=${nextVirtualFloor}`);
  }

  return {
    result,
    dropped,
    floor: state.virtualFloor,
    ackOffset: maxDroppedUpdateId == null ? null : maxDroppedUpdateId + 1,
    translated: result.length > 0,
  };
}

// Отбрасываем local updates ниже сохраненного OpenClaw offset, чтобы Docker Bot API не оживлял старые сессии.
function guardedLocalGetUpdates(req, method, token, body, upstream) {
  if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) {
    return { upstream, dropped: 0, floor: null, ackOffset: null, translated: false, bridged: false };
  }
  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    if (!payload?.ok || !Array.isArray(payload.result)) {
      return { upstream, dropped: 0, floor: null, ackOffset: null, translated: false, bridged: false };
    }
    const floor = localOffsetFloor(req, token, body);
    if (floor == null) return { upstream, dropped: 0, floor: null, ackOffset: null, translated: false, bridged: false };

    const translated = translateLocalUpdatesWithBridge(token, payload);
    if (translated) {
      return {
        upstream: translated.translated ? jsonCloudResponse(upstream, { ...payload, result: translated.result }) : upstream,
        dropped: translated.dropped,
        floor: translated.floor,
        ackOffset: translated.ackOffset,
        translated: translated.translated,
        bridged: false,
      };
    }

    const botId = botIdFromToken(token);
    let maxDroppedUpdateId = null;
    const result = payload.result.filter((update) => {
      const updateId = numericOffset(update?.update_id);
      if (updateId == null || updateId > floor) return true;
      maxDroppedUpdateId = Math.max(maxDroppedUpdateId ?? updateId, updateId);
      return false;
    });
    const dropped = payload.result.length - result.length;
    const bridged = result.length === 0 && shouldBridgeLocalUpdateIds(floor, maxDroppedUpdateId, payload.result)
      ? bridgeLocalUpdateIds(botId, maxDroppedUpdateId, floor)
      : false;
    return {
      upstream: dropped > 0 ? jsonCloudResponse(upstream, { ...payload, result }) : upstream,
      dropped,
      floor,
      ackOffset: maxDroppedUpdateId == null ? null : maxDroppedUpdateId + 1,
      translated: false,
      bridged,
    };
  } catch {
    return { upstream, dropped: 0, floor: null, ackOffset: null, translated: false, bridged: false };
  }
}

// Подтверждаем local Bot API, что старые update_id можно пропустить, иначе он будет возвращать их снова.
async function acknowledgeDroppedLocalUpdates(req, token, body, ackOffset) {
  if (ackOffset == null) return;
  const botId = botIdFromToken(token);
  if (!botId) return;
  const now = Date.now();
  const cached = localDroppedAckByBotId.get(botId);
  if (cached && cached.offset === ackOffset && now - cached.sentAt < 2000) return;
  localDroppedAckByBotId.set(botId, { offset: ackOffset, sentAt: now });
  const ackRequest = bodyWithOffsetAndTimeout(req, body, ackOffset, 0);
  try {
    await forwardBuffered(req, localRoot, ackRequest.body, ackRequest.reqUrl);
    log(`method=getUpdates target=local action=ack-dropped offset=${ackOffset}`);
  } catch (error) {
    logError(`method=getUpdates target=local action=ack-dropped ${errorLogFields(error)}`);
  }
}

// Для getUpdates fallback проверяем cloud backlog отдельно: local API может быть здоровым, но пустым.
async function probeCloudPendingUpdates(token) {
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
    markLocalUnhealthy(errorReason(error));
    log(`method=getMe target=local action=healthcheck-failed ${errorLogFields(error)}`);
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
  const type = contentType(req);
  if (type.includes("multipart/form-data")) return false;
  const lengthHeader = req.headers["content-length"];
  if (lengthHeader) {
    const length = Number.parseInt(String(lengthHeader), 10);
    return Number.isFinite(length) && length <= bufferLimitBytes;
  }
  return req.method === "GET" || req.method === "HEAD" || !type || type.includes("json") || type.includes("x-www-form-urlencoded");
}

function streamingKind(req, method) {
  if (isMultipartUploadRequest(req)) return "upload";
  if (method === "file" || req.method === "GET" || req.method === "HEAD") return "download";
  return "passthrough";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getUpdatesRetryDelayMs(attempt) {
  return localGetUpdatesRetryBaseMs * (2 ** Math.max(0, attempt - 1));
}

async function forwardBuffered(req, root, body, reqUrl = req.url, options = {}) {
  const url = `${root}${reqUrl}`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? upstreamTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

async function forwardLocalBuffered(req, method, token, body) {
  if (method !== "getUpdates") {
    return { upstream: await forwardBuffered(req, localRoot, body), req, body, attempts: 1, timeoutCapped: false, timeout: null };
  }

  const translatedRequest = localRequestForGetUpdates(req, method, token, body);
  const localRequest = applyGetUpdatesTimeoutCap(translatedRequest.req, method, translatedRequest.body);
  let lastHttpUpstream = null;
  for (let attempt = 1; attempt <= localGetUpdatesMaxAttempts; attempt += 1) {
    try {
      const upstream = await forwardBuffered(
        localRequest.req,
        localRoot,
        localRequest.body,
        localRequest.req.url,
        { timeoutMs: localGetUpdatesUpstreamTimeoutMs },
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
      await sleep(waitMs);
    } catch (error) {
      if (!isClearlyLocalUnavailable(error) || attempt >= localGetUpdatesMaxAttempts) throw error;
      const waitMs = getUpdatesRetryDelayMs(attempt);
      log(`method=getUpdates target=local action=retry attempt=${attempt} ${errorLogFields(error)} waitMs=${waitMs} timeout=${localRequest.timeout ?? "none"}`);
      await sleep(waitMs);
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
  const cloudFallback = cloudFallbackPolicy(method, token, pathname, req);
  const cloudFallbackAllowed = cloudFallback.allowed;
  if (method !== "getUpdates" && !localIsHealthy && cloudFallbackAllowed) {
    const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
    const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
    const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
    const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudProcessed);
    const cloud = cloudResult.upstream;
    writeBufferedResponse(res, cloud);
    log(`method=${method} target=cloud reason=local-unhealthy status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
    return;
  }

  try {
    const localAttempt = await forwardLocalBuffered(req, method, token, body);
    const localReq = localAttempt.req;
    const localBody = localAttempt.body;
    const localRaw = localAttempt.upstream;
    const localProcessed = processGetFileResult(method, token, localRaw, "local");
    const localGuard = guardedLocalGetUpdates(localReq, method, token, localBody, localProcessed);
    const local = localGuard.upstream;
    if (localGuard.dropped > 0) {
      log(`method=getUpdates target=local action=dropped-local-update dropped=${localGuard.dropped} floor=${localGuard.floor ?? "none"} ackOffset=${localGuard.ackOffset ?? "none"}`);
      await acknowledgeDroppedLocalUpdates(localReq, token, localBody, localGuard.ackOffset);
    }
    if (cloudFallbackAllowed && shouldRetryCloudAfterLocalStatus(method, local.statusCode) && body.length <= bufferLimitBytes) {
      const cloudRequest = cloudRequestForGetUpdates(localReq, method, token, localBody);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(localReq, method, token, localBody, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudFallbackAllowed && local.statusCode >= 500 && isSafeMethodForStatusFallback(method)) {
      const cloudRequest = cloudRequestForGetUpdates(localReq, method, token, localBody);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(localReq, method, token, localBody, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} localAttempts=${localAttempt.attempts} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudFallbackAllowed && cloudGetUpdatesFallbackEnabled && localGuard.dropped === 0 && emptySuccessfulGetUpdates(method, local)) {
      let pendingProbe = null;
      try {
        pendingProbe = await probeCloudPendingUpdates(token);
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
        const cloudRequest = cloudRequestForGetUpdates(localReq, method, token, localBody);
        const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
        const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
        const cloudResult = guardedCloudGetUpdates(localReq, method, token, localBody, cloudProcessed, { virtualizeLowerIds: true });
        const cloud = cloudResult.upstream;
        writeBufferedResponse(res, cloud);
        log(`method=${method} target=cloud reason=local-empty-cloud-pending pending=${pendingProbe.pending} cached=${pendingProbe.cached ? "yes" : "no"} pendingAgeMs=${pendingProbe.pendingAgeMs} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
        return;
      }
    }
    writeBufferedResponse(res, local);
    log(`method=${method} target=local status=${local.statusCode}${localAttempt.attempts > 1 ? ` attempts=${localAttempt.attempts}` : ""}${localAttempt.timeoutCapped ? ` timeoutCapped=${localAttempt.timeout}` : ""}${localAttempt.translatedOffset ? " translatedOffset=yes" : ""}${localGuard.dropped ? ` dropped=${localGuard.dropped} floor=${localGuard.floor ?? "none"}` : ""}${localGuard.translated ? " translatedLocal=yes" : ""}${localGuard.bridged ? " bridgedLocal=yes" : ""} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(errorReason(error));
      const fallbackRequest = applyGetUpdatesTimeoutCap(req, method, body);
      const cloudRequest = cloudRequestForGetUpdates(fallbackRequest.req, method, token, fallbackRequest.body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(fallbackRequest.req, method, token, fallbackRequest.body, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud ${errorLogFields(error)} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (!cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(errorReason(error));
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
    const result = await forwardStreaming(req, res, initialRoot);
    log(`method=${method} target=${initialTarget}${affinityTarget ? " reason=file-source-affinity" : ""} stream=${streamKind} status=${result.statusCode} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && initialTarget === "local" && isClearlyLocalUnavailable(error) && (req.method === "GET" || req.method === "HEAD")) {
      markLocalUnhealthy(errorReason(error));
      const result = await forwardStreaming(req, res, cloudRoot);
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
    logError(`method=${method} ${errorLogFields(error)}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, description: "Telegram Bot API proxy upstream failure" }));
    } else {
      res.destroy(error);
    }
  }
});

// Запускаем listener только после полной инициализации правил fallback и in-memory state.
server.listen(listenPort, listenHost, () => {
  log(`listening=${listenHost}:${listenPort} local=${localRoot} cloud=${cloudRoot} cloudFallback=${cloudFallbackEnabled ? "enabled" : "disabled"} cloudGetUpdatesFallback=${cloudGetUpdatesFallbackEnabled ? "enabled" : "disabled"} cloudPendingFallbackDelayMs=${cloudPendingFallbackDelayMs} localGetUpdatesTimeout=${localGetUpdatesTimeoutSeconds} localGetUpdatesAttempts=${localGetUpdatesMaxAttempts} localVirtualOffsetSkewMin=${localVirtualOffsetSkewMin} cloudFileMaxBytes=${cloudFileFallbackMaxBytes} fileInfoCacheTtlMs=${fileInfoCacheTtlMs}`);
});

// При остановке systemd закрываем listener штатно, но не зависаем дольше пяти секунд.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
