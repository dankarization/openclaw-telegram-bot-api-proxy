import assert from "node:assert/strict";
import test from "node:test";

import {
  createDebugLogger,
  parseDebugLogConfig,
  parseRequestParams,
  summarizeParams,
  truncate,
} from "../src/debug-log.mjs";

function jsonUpstream(statusCode, payload) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(payload)),
  };
}

const sendMessageBody = Buffer.from(JSON.stringify({
  chat_id: 42,
  text: "секретный текст пользователя",
  disable_notification: true,
  parse_mode: "HTML",
  reply_markup: { inline_keyboard: [] },
}));

test("debug log is off by default and rejects unknown modes", () => {
  assert.equal(parseDebugLogConfig({}).mode, "off");
  const invalid = parseDebugLogConfig({ TELEGRAM_PROXY_DEBUG_LOG: "verbose" });
  assert.equal(invalid.mode, "off");
  assert.equal(invalid.invalidMode, true);
  const logger = createDebugLogger(parseDebugLogConfig({}));
  assert.equal(logger.enabled, false);
  assert.equal(logger.format({ method: "sendMessage", reqUrl: "/bot1:x/sendMessage", contentType: "application/json", body: sendMessageBody, upstream: jsonUpstream(200, { ok: true }) }), null);
});

test("minimal mode logs flags and lengths but never message text", () => {
  const logger = createDebugLogger(parseDebugLogConfig({ TELEGRAM_PROXY_DEBUG_LOG: "minimal" }));
  const line = logger.format({
    method: "sendMessage",
    reqUrl: "/bot123:abc/sendMessage",
    contentType: "application/json",
    body: sendMessageBody,
    upstream: jsonUpstream(200, { ok: true, result: { message_id: 7, chat: { id: 42 }, text: "секретный текст пользователя" } }),
    ms: 12,
  });
  assert.match(line, /^debug=minimal method=sendMessage status=200 ms=12 /u);
  assert.match(line, /disable_notification=true/u);
  assert.match(line, /parse_mode="HTML"/u);
  assert.match(line, /text=<str:28>/u);
  assert.match(line, /reply_markup=<obj:inline_keyboard>/u);
  assert.match(line, /res=\{ok=true,message_id=7,chat_id=42\}/u);
  assert.doesNotMatch(line, /секретный/u);
});

test("full mode logs payload and response with secrets redacted and size capped", () => {
  const logger = createDebugLogger(parseDebugLogConfig({ TELEGRAM_PROXY_DEBUG_LOG: "full", TELEGRAM_PROXY_DEBUG_MAX_CHARS: "80" }));
  const line = logger.format({
    method: "setWebhook",
    reqUrl: "/bot123:abc/setWebhook",
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ url: "https://example.test/hook", secret_token: "s3cr3t", padding: "x".repeat(200) })),
    upstream: jsonUpstream(400, { ok: false, error_code: 400, description: "Bad Request: bad webhook" }),
  });
  assert.match(line, /^debug=full method=setWebhook status=400 /u);
  assert.match(line, /"secret_token":"<redacted>"/u);
  assert.doesNotMatch(line, /s3cr3t/u);
  assert.match(line, /…\(\+\d+ chars\)/u);
  assert.match(line, /"error_code":400/u);
});

test("getUpdates: empty polls are silent, non-empty polls log only count and types", () => {
  const logger = createDebugLogger(parseDebugLogConfig({ TELEGRAM_PROXY_DEBUG_LOG: "full" }));
  const base = { method: "getUpdates", reqUrl: "/bot1:x/getUpdates?offset=5", contentType: "", body: Buffer.alloc(0) };
  assert.equal(logger.format({ ...base, upstream: jsonUpstream(200, { ok: true, result: [] }) }), null);
  const line = logger.format({
    ...base,
    upstream: jsonUpstream(200, { ok: true, result: [{ update_id: 1, message: { text: "hi" } }, { update_id: 2, message_reaction: {} }] }),
  });
  assert.equal(line, "debug=full method=getUpdates status=200 count=2 types=message|message_reaction");
});

test("method allowlist and skip list filter debug lines", () => {
  const logger = createDebugLogger(parseDebugLogConfig({
    TELEGRAM_PROXY_DEBUG_LOG: "minimal",
    TELEGRAM_PROXY_DEBUG_METHODS: "sendMessage, sendVoice",
    TELEGRAM_PROXY_DEBUG_SKIP_METHODS: "sendVoice",
  }));
  assert.equal(logger.shouldLog("sendMessage"), true);
  assert.equal(logger.shouldLog("sendVoice"), false);
  assert.equal(logger.shouldLog("getMe"), false);
});

test("request params are read from query, urlencoded and JSON bodies", () => {
  assert.deepEqual(parseRequestParams("/bot1:x/getFile?file_id=abc", "", null).params, { file_id: "abc" });
  assert.deepEqual(
    parseRequestParams("/bot1:x/sendMessage", "application/x-www-form-urlencoded", Buffer.from("chat_id=5&disable_notification=true")).params,
    { chat_id: "5", disable_notification: "true" },
  );
  assert.equal(parseRequestParams("/bot1:x/sendMessage", "application/json", Buffer.from("{oops")).unparsed, "json-invalid bytes=5");
  assert.equal(summarizeParams({}), "none");
  assert.equal(truncate("abcdef", 3), "abc…(+3 chars)");
});
