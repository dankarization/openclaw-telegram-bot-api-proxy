import { URL } from "node:url";

const CANONICAL_METHOD_BY_LOWERCASE = new Map([
  "getMe",
  "getUpdates",
  "getWebhookInfo",
  "deleteWebhook",
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
  "close",
  "logOut",
  "setWebhook",
].map((method) => [method.toLowerCase(), method]));

export function canonicalMethodName(method) {
  const raw = String(method || "");
  return CANONICAL_METHOD_BY_LOWERCASE.get(raw.toLowerCase()) || raw;
}

// tdlib percent-decodes the HTTP path before splitting token and Bot API method.
// Parse both values from that one upstream-equivalent representation so encoded
// aliases cannot create a second coordinator lane or bypass method policy.
export function telegramRouteFromPath(pathname) {
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(String(pathname || ""));
  } catch {
    return {
      decodedPathname: null,
      missingPathMethod: false,
      method: "unknown",
      token: "",
      unsupportedTestDc: false,
      validEncoding: false,
    };
  }

  const tokenMatch = decodedPathname.match(/^\/(?:file\/)?bot([^/]+)/u);
  const botRouteMatch = decodedPathname.match(/^\/bot[^/]+(?:\/(.*))?$/u);
  let methodSegment = botRouteMatch?.[1] || "";
  let unsupportedTestDc = false;
  if (methodSegment.startsWith("test/")) {
    unsupportedTestDc = true;
    methodSegment = methodSegment.slice("test/".length);
  }
  const methodMatch = methodSegment.match(/^([^/?#]+)/u);
  const isFileRoute = decodedPathname.startsWith("/file/bot");
  const missingPathMethod = Boolean(
    tokenMatch
    && !isFileRoute
    && !methodMatch,
  );
  return {
    decodedPathname,
    missingPathMethod,
    method: methodMatch
      ? canonicalMethodName(methodMatch[1] || "unknown")
      : isFileRoute
        ? "file"
        : "unknown",
    token: tokenMatch ? tokenMatch[1] : "",
    unsupportedTestDc,
    validEncoding: true,
  };
}

// Достаём bot token из Telegram API path вида /bot<TOKEN>/... или /file/bot<TOKEN>/....
export function tokenFromPath(pathname) {
  return telegramRouteFromPath(pathname).token;
}

// Нормализуем имя Telegram API метода одинаково для buffered и streaming путей.
export function methodFromPath(pathname) {
  return telegramRouteFromPath(pathname).method;
}

// Вытаскиваем file_path из /file/bot<TOKEN>/<file_path>.
export function filePathFromPathname(pathname) {
  const match = pathname.match(/^\/file\/bot[^/]+\/(.+)$/u);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function contentType(req) {
  return String(req?.headers?.["content-type"] || "").toLowerCase();
}

export function isMultipartUploadRequest(req) {
  return contentType(req).includes("multipart/form-data");
}

// Сохраняет permissive parseInt-семантику legacy request path.
export function numericOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Строгая проверка нужна там, где offset становится durable/operator state.
export function exactSafeNonNegativeInteger(value) {
  const raw = String(value ?? "");
  if (!/^(0|[1-9]\d*)$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function requestOffsetValue(req, body) {
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

export function requestOffsetFloor(req, body) {
  const offset = requestOffsetValue(req, body);
  return offset == null ? null : offset - 1;
}

export function bodyWithOffset(req, body, offset) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (body?.length && type.includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      return { reqUrl: req.url, body: Buffer.from(JSON.stringify({ ...payload, offset })) };
    } catch {
      // Если JSON не разобрался, переносим offset в query string.
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

export function bodyWithTimeout(req, body, timeoutValue) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (body?.length && type.includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      return {
        reqUrl: req.url,
        body: Buffer.from(JSON.stringify({ ...payload, timeout: timeoutValue })),
      };
    } catch {
      // Если JSON не разобрался, переносим timeout в query string.
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

// Для служебного ack local getUpdates вызывающий код передаёт timeout=0.
export function bodyWithOffsetAndTimeout(req, body, offset, timeoutValue) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (body?.length && type.includes("application/json")) {
    try {
      const payload = JSON.parse(body.toString("utf8"));
      return {
        reqUrl: req.url,
        body: Buffer.from(JSON.stringify({ ...payload, offset, timeout: timeoutValue })),
      };
    } catch {
      // Если JSON не разобрался, переносим offset и timeout в query string.
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

export function requestTimeoutValue(req, body) {
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

export function requestWithUrl(req, reqUrl) {
  if (reqUrl === req.url) return req;
  return {
    method: req.method,
    headers: req.headers,
    url: reqUrl,
  };
}

export function applyGetUpdatesTimeoutCap(req, method, body, timeoutCapSeconds) {
  if (canonicalMethodName(method) !== "getUpdates") {
    return { req, body, capped: false, timeout: null };
  }
  const currentTimeout = requestTimeoutValue(req, body);
  if (currentTimeout != null && currentTimeout <= timeoutCapSeconds) {
    return { req, body, capped: false, timeout: currentTimeout };
  }
  const updated = bodyWithTimeout(req, body, timeoutCapSeconds);
  return {
    req: requestWithUrl(req, updated.reqUrl),
    body: updated.body,
    capped: currentTimeout !== timeoutCapSeconds,
    timeout: timeoutCapSeconds,
  };
}

export function copyHeaders(headers) {
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

export function canBufferRequest(req, bufferLimitBytes) {
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

export function streamingKind(req, method) {
  if (isMultipartUploadRequest(req)) return "upload";
  if (method === "file" || req.method === "GET" || req.method === "HEAD") return "download";
  return "passthrough";
}
