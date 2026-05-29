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
// TTL проверки cloud pending updates, чтобы не дергать getWebhookInfo на каждом long poll.
const cloudPendingProbeTtlMs = Number.parseInt(process.env.CLOUD_PENDING_PROBE_TTL_MS || "5000", 10);
// Максимальный возраст cloud update, который можно виртуально поднять над local offset.
const cloudFreshUpdateMaxAgeMs = Number.parseInt(process.env.CLOUD_FRESH_UPDATE_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10);

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
// Кэш file_path -> file_size из getFile, чтобы решать, можно ли фолбечить /file.
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

// Ключ кэша размера файла привязан к botId, потому что file_path уникален в рамках бота.
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

function processGetFileResult(method, token, upstream, target) {
  if (method !== "getFile" || upstream.statusCode !== 200 || !upstream.body?.length) return upstream;
  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    const filePath = payload?.result?.file_path;
    if (!payload?.ok || typeof filePath !== "string" || !filePath) return upstream;
    const rewrittenFilePath = target === "local" ? rewriteLocalFilePath(filePath) : filePath;
    cacheFileInfo(token, filePath, payload.result.file_size);
    if (rewrittenFilePath !== filePath) {
      cacheFileInfo(token, rewrittenFilePath, payload.result.file_size);
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
  if (localOnlyMethods.has(method)) return { allowed: false, reason: "local-only-method" };
  if (req && isMultipartUploadRequest(req)) return { allowed: false, reason: "multipart-upload-local-only" };

  if (method !== "file") {
    if (safeCloudFallbackMethods.has(method)) return { allowed: true, reason: "safe-method" };
    return { allowed: true, reason: "default-non-file-method" };
  }

  const filePath = filePathFromPathname(pathname);
  const info = cachedFileInfo(token, filePath);
  if (info?.fileSize == null) return { allowed: false, reason: "file-size-unknown" };
  if (info.fileSize > cloudFileFallbackMaxBytes) return { allowed: false, reason: "file-too-large" };
  return { allowed: true, reason: "file-size-within-cloud-limit" };
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

// Отбрасываем local updates ниже сохраненного OpenClaw offset, чтобы Docker Bot API не оживлял старые сессии.
function guardedLocalGetUpdates(req, method, token, body, upstream) {
  if (method !== "getUpdates" || upstream.statusCode !== 200 || !upstream.body?.length) {
    return { upstream, dropped: 0, floor: null, ackOffset: null };
  }
  try {
    const payload = JSON.parse(upstream.body.toString("utf8"));
    if (!payload?.ok || !Array.isArray(payload.result)) return { upstream, dropped: 0, floor: null, ackOffset: null };
    const floor = localOffsetFloor(req, token, body);
    if (floor == null) return { upstream, dropped: 0, floor: null, ackOffset: null };
    let maxDroppedUpdateId = null;
    const result = payload.result.filter((update) => {
      const updateId = numericOffset(update?.update_id);
      if (updateId == null || updateId > floor) return true;
      maxDroppedUpdateId = Math.max(maxDroppedUpdateId ?? updateId, updateId);
      return false;
    });
    const dropped = payload.result.length - result.length;
    return {
      upstream: dropped > 0 ? jsonCloudResponse(upstream, { ...payload, result }) : upstream,
      dropped,
      floor,
      ackOffset: maxDroppedUpdateId == null ? null : maxDroppedUpdateId + 1,
    };
  } catch {
    return { upstream, dropped: 0, floor: null, ackOffset: null };
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
    logError(`method=getUpdates target=local action=ack-dropped error=${error?.code || error?.name || "unknown"} message=${error?.message || String(error)}`);
  }
}

// Для getUpdates fallback проверяем cloud backlog отдельно: local API может быть здоровым, но пустым.
async function probeCloudPendingUpdates(token) {
  const botId = botIdFromToken(token);
  if (!botId) return { pending: 0, cached: false };
  const now = Date.now();
  const cached = cloudPendingProbeByBotId.get(botId);
  if (cached && now - cached.checkedAt < cloudPendingProbeTtlMs) {
    log(`method=getWebhookInfo target=cloud action=cloud-pending-probe pending=${cached.pending} cached=yes`);
    return { pending: cached.pending, cached: true };
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
  cloudPendingProbeByBotId.set(botId, { pending, checkedAt: now });
  log(`method=getWebhookInfo target=cloud action=cloud-pending-probe pending=${pending} cached=no`);
  return { pending, cached: false };
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
  const cloudFallback = cloudFallbackPolicy(method, token, pathname, req);
  const cloudFallbackAllowed = cloudFallback.allowed;
  if (!localIsHealthy && cloudFallbackAllowed) {
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
    const localRaw = await forwardBuffered(req, localRoot, body);
    const localProcessed = processGetFileResult(method, token, localRaw, "local");
    const localGuard = guardedLocalGetUpdates(req, method, token, body, localProcessed);
    const local = localGuard.upstream;
    if (localGuard.dropped > 0) {
      log(`method=getUpdates target=local action=dropped-local-update dropped=${localGuard.dropped} floor=${localGuard.floor ?? "none"} ackOffset=${localGuard.ackOffset ?? "none"}`);
      await acknowledgeDroppedLocalUpdates(req, token, body, localGuard.ackOffset);
    }
    if (cloudFallbackAllowed && (local.statusCode === 401 || local.statusCode === 404) && body.length <= bufferLimitBytes) {
      const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudFallbackAllowed && local.statusCode >= 500 && isSafeMethodForStatusFallback(method)) {
      const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=local-${local.statusCode} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (cloudFallbackAllowed && emptySuccessfulGetUpdates(method, local)) {
      const pendingProbe = await probeCloudPendingUpdates(token);
      if (pendingProbe.pending > 0) {
        const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
        const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
        const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
        const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudProcessed, { virtualizeLowerIds: true });
        const cloud = cloudResult.upstream;
        writeBufferedResponse(res, cloud);
        log(`method=${method} target=cloud reason=local-empty-cloud-pending pending=${pendingProbe.pending} cached=${pendingProbe.cached ? "yes" : "no"} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
        return;
      }
    }
    writeBufferedResponse(res, local);
    log(`method=${method} target=local status=${local.statusCode}${localGuard.dropped ? ` dropped=${localGuard.dropped} floor=${localGuard.floor ?? "none"}` : ""} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(error.code);
      const cloudRequest = cloudRequestForGetUpdates(req, method, token, body);
      const cloudRaw = await forwardBuffered(req, cloudRoot, cloudRequest.body, cloudRequest.reqUrl);
      const cloudProcessed = processGetFileResult(method, token, cloudRaw, "cloud");
      const cloudResult = guardedCloudGetUpdates(req, method, token, body, cloudProcessed);
      const cloud = cloudResult.upstream;
      writeBufferedResponse(res, cloud);
      log(`method=${method} target=cloud reason=${error.code} status=${cloud.statusCode} dropped=${cloudResult.dropped} floor=${cloudResult.floor ?? "none"} translated=${cloudRequest.translated || cloudResult.translated ? "yes" : "no"} ms=${Date.now() - startedAt}`);
      return;
    }
    if (!cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(error.code);
      log(`method=${method} target=local action=fallback-blocked reason=${cloudFallback.reason} error=${error.code} ms=${Date.now() - startedAt}`);
    }
    throw error;
  }
}

async function handleStreaming(req, res, method, token, startedAt) {
  const pathname = new URL(req.url || "/", "http://proxy.local").pathname;
  const localIsHealthy = await checkLocalHealth(token);
  const cloudFallback = cloudFallbackPolicy(method, token, pathname, req);
  const cloudFallbackAllowed = cloudFallback.allowed;
  const initialRoot = localIsHealthy || !cloudFallbackAllowed ? localRoot : cloudRoot;
  const initialTarget = localIsHealthy || !cloudFallbackAllowed ? "local" : "cloud";
  const streamKind = streamingKind(req, method);
  beginStreaming(streamKind);
  try {
    const result = await forwardStreaming(req, res, initialRoot);
    log(`method=${method} target=${initialTarget} stream=${streamKind} status=${result.statusCode} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
  } catch (error) {
    if (cloudFallbackAllowed && initialTarget === "local" && isClearlyLocalUnavailable(error) && (req.method === "GET" || req.method === "HEAD")) {
      markLocalUnhealthy(error.code);
      const result = await forwardStreaming(req, res, cloudRoot);
      log(`method=${method} target=cloud reason=${error.code} stream=${streamKind} status=${result.statusCode} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
      return;
    }
    if (!cloudFallbackAllowed && isClearlyLocalUnavailable(error)) {
      markLocalUnhealthy(error.code);
      log(`method=${method} target=local action=fallback-blocked reason=${cloudFallback.reason} stream=${streamKind} error=${error.code} ${streamingCounterFields()} ms=${Date.now() - startedAt}`);
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
    logError(`method=${method} error=${error?.code || error?.name || "unknown"} message=${error?.message || String(error)}`);
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
  log(`listening=${listenHost}:${listenPort} local=${localRoot} cloud=${cloudRoot} cloudFallback=${cloudFallbackEnabled ? "enabled" : "disabled"} cloudFileMaxBytes=${cloudFileFallbackMaxBytes}`);
});

// При остановке systemd закрываем listener штатно, но не зависаем дольше пяти секунд.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
