// Opt-in debug логирование Bot API запросов/ответов для buffered пути.
// По умолчанию выключено: operational log остаётся без текста сообщений.
//   minimal — только форма запроса: ключи, флаги, числа, длины строк; без текста.
//   full    — JSON payload и ответ, с маскировкой секретов и ограничением длины.

const MODES = new Set(["off", "minimal", "full"]);
// Значения этих ключей никогда не пишутся даже в full.
const SECRET_KEYS = new Set(["secret_token", "token", "provider_token", "password"]);
// Короткие служебные строки, которые безопасно показывать в minimal.
const SAFE_STRING_KEYS = new Set(["parse_mode", "action", "type", "chat_id", "emoji", "allowed_updates"]);
const SAFE_STRING_MAX = 64;

export function parseDebugLogConfig(env = {}) {
  const rawMode = String(env.TELEGRAM_PROXY_DEBUG_LOG || "off").trim().toLowerCase();
  const mode = MODES.has(rawMode) ? rawMode : "off";
  const methods = parseList(env.TELEGRAM_PROXY_DEBUG_METHODS);
  const skipMethods = parseList(env.TELEGRAM_PROXY_DEBUG_SKIP_METHODS);
  const maxChars = Number.parseInt(String(env.TELEGRAM_PROXY_DEBUG_MAX_CHARS ?? ""), 10);
  return {
    mode,
    invalidMode: rawMode !== mode,
    methods,
    skipMethods,
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1024,
  };
}

function parseList(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

// Достаём параметры из JSON, x-www-form-urlencoded body или query string.
export function parseRequestParams(reqUrl, contentType, body) {
  const params = {};
  const query = new URL(reqUrl || "/", "http://proxy.local").searchParams;
  for (const [key, value] of query) params[key] = value;
  const type = String(contentType || "").toLowerCase();
  if (body && body.length) {
    const textBody = body.toString("utf8");
    if (type.includes("json")) {
      try {
        const parsed = JSON.parse(textBody);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(params, parsed);
        else return { params, unparsed: `json-non-object bytes=${body.length}` };
      } catch {
        return { params, unparsed: `json-invalid bytes=${body.length}` };
      }
    } else if (type.includes("x-www-form-urlencoded")) {
      for (const [key, value] of new URLSearchParams(textBody)) params[key] = value;
    } else {
      return { params, unparsed: `ctype=${type || "none"} bytes=${body.length}` };
    }
  }
  return { params, unparsed: null };
}

function summarizeValue(key, value) {
  if (SECRET_KEYS.has(key)) return "<redacted>";
  if (value == null) return String(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (SAFE_STRING_KEYS.has(key) && value.length <= SAFE_STRING_MAX) return JSON.stringify(value);
    return `<str:${value.length}>`;
  }
  if (Array.isArray(value)) return `<arr:${value.length}>`;
  if (typeof value === "object") return `<obj:${Object.keys(value).sort().join("|")}>`;
  return `<${typeof value}>`;
}

// minimal: ключ=значение только для безопасных скаляров, остальное — длины/формы.
export function summarizeParams(params) {
  return Object.keys(params).sort().map((key) => `${key}=${summarizeValue(key, params[key])}`).join(",") || "none";
}

export function summarizeResponse(payload) {
  if (!payload || typeof payload !== "object") return "unparsed";
  const parts = [`ok=${payload.ok === true}`];
  if (payload.error_code != null) parts.push(`error_code=${payload.error_code}`);
  if (typeof payload.description === "string") parts.push(`description=${JSON.stringify(payload.description.slice(0, 200))}`);
  if (payload.parameters?.retry_after != null) parts.push(`retry_after=${payload.parameters.retry_after}`);
  const result = payload.result;
  if (Array.isArray(result)) {
    parts.push(`result=<arr:${result.length}>`);
  } else if (result && typeof result === "object") {
    if (result.message_id != null) parts.push(`message_id=${result.message_id}`);
    if (result.chat?.id != null) parts.push(`chat_id=${result.chat.id}`);
    if (result.message_id == null) parts.push(`result=<obj:${Object.keys(result).sort().join("|")}>`);
  } else if (result !== undefined) {
    parts.push(`result=${typeof result === "string" ? `<str:${result.length}>` : String(result)}`);
  }
  return parts.join(",");
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.has(key) ? "<redacted>" : redactSecrets(item)]));
  }
  return value;
}

export function truncate(text, maxChars) {
  const value = String(text);
  return value.length > maxChars ? `${value.slice(0, maxChars)}…(+${value.length - maxChars} chars)` : value;
}

function parseJsonBody(upstream) {
  const type = String(upstream?.headers?.["content-type"] || "").toLowerCase();
  if (!type.includes("json") || !upstream?.body) return null;
  try {
    return JSON.parse(upstream.body.toString("utf8"));
  } catch {
    return null;
  }
}

function updateTypes(result) {
  return [...new Set(result.flatMap((update) => Object.keys(update || {}).filter((key) => key !== "update_id")))].sort().join("|");
}

export function createDebugLogger(config) {
  const enabled = config.mode !== "off";
  function shouldLog(method) {
    if (!enabled) return false;
    if (config.methods.size && !config.methods.has(method)) return false;
    return !config.skipMethods.has(method);
  }

  // Возвращает строку для log() или null; token маскируется вызывающим log().
  function format({ method, reqUrl, contentType, body, upstream, ms }) {
    if (!shouldLog(method)) return null;
    const responsePayload = parseJsonBody(upstream);
    const status = upstream?.statusCode ?? "none";
    const timing = ms != null ? ` ms=${ms}` : "";
    if (method === "getUpdates") {
      // Пустые long poll не шумят; для непустых — только количество и типы.
      const result = Array.isArray(responsePayload?.result) ? responsePayload.result : null;
      if (result && result.length === 0 && responsePayload.ok === true) return null;
      if (result) return `debug=${config.mode} method=getUpdates status=${status} count=${result.length} types=${updateTypes(result) || "none"}${timing}`;
    }
    const { params, unparsed } = parseRequestParams(reqUrl, contentType, body);
    if (config.mode === "minimal") {
      const req = unparsed ? `${summarizeParams(params)} body=${unparsed}` : summarizeParams(params);
      return `debug=minimal method=${method} status=${status}${timing} req={${req}} res={${summarizeResponse(responsePayload)}}`;
    }
    const reqText = truncate(JSON.stringify(redactSecrets(params)) + (unparsed ? ` body=${unparsed}` : ""), config.maxChars);
    const resText = responsePayload
      ? truncate(JSON.stringify(redactSecrets(responsePayload)), config.maxChars)
      : `bytes=${upstream?.body?.length ?? 0} ctype=${upstream?.headers?.["content-type"] || "none"}`;
    return `debug=full method=${method} status=${status}${timing} req=${reqText} res=${resText}`;
  }

  return { enabled, mode: config.mode, shouldLog, format };
}
