import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGetUpdatesTimeoutCap,
  bodyWithOffset,
  bodyWithOffsetAndTimeout,
  bodyWithTimeout,
  canonicalMethodName,
  canBufferRequest,
  contentType,
  copyHeaders,
  exactSafeNonNegativeInteger,
  filePathFromPathname,
  isMultipartUploadRequest,
  methodFromPath,
  numericOffset,
  requestOffsetFloor,
  requestOffsetValue,
  requestFileId,
  requestTimeoutValue,
  requestWithUrl,
  streamingKind,
  telegramRouteFromPath,
  tokenFromPath,
} from "../src/request-parsing.mjs";

function request(url = "/", options = {}) {
  return {
    method: options.method || "GET",
    headers: options.headers || {},
    url,
    ...options.extra,
  };
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

test("Telegram path helpers preserve token, method, and decoded file path behavior", () => {
  assert.equal(tokenFromPath("/bot123:secret/getUpdates"), "123:secret");
  assert.equal(tokenFromPath("/bot123%3Asecret/%67etUpdates"), "123:secret");
  assert.equal(tokenFromPath("/file/bot123:secret/voice/a.ogg"), "123:secret");
  assert.equal(tokenFromPath("/health"), "");

  assert.equal(methodFromPath("/bot123:secret/getUpdates"), "getUpdates");
  assert.equal(methodFromPath("/bot123%3Asecret/%67etUpdates"), "getUpdates");
  assert.equal(methodFromPath("/bot123:secret/GETUPDATES"), "getUpdates");
  assert.equal(methodFromPath("/bot123:secret/gEtFiLe"), "getFile");
  assert.equal(methodFromPath("/bot123:secret/SETWEBHOOK"), "setWebhook");
  assert.equal(methodFromPath("/bot123:secret/test/getUpdates"), "getUpdates");
  assert.equal(methodFromPath("/bot123:secret/sendMessage?chat_id=1"), "sendMessage");
  assert.equal(methodFromPath("/file/bot123:secret/voice/a.ogg"), "file");
  assert.equal(methodFromPath("/bot123:secret/"), "unknown");
  assert.equal(canonicalMethodName("LOGOUT"), "logOut");
  assert.equal(canonicalMethodName("customMethod"), "customMethod");
  assert.deepEqual(
    telegramRouteFromPath("/bot123:secret/bad%E0%A4%A"),
    {
      decodedPathname: null,
      missingPathMethod: false,
      method: "unknown",
      token: "",
      unsupportedTestDc: false,
      validEncoding: false,
    },
  );
  assert.deepEqual(
    telegramRouteFromPath("/bot123%3Asecret/test/getUpdates"),
    {
      decodedPathname: "/bot123:secret/test/getUpdates",
      missingPathMethod: false,
      method: "getUpdates",
      token: "123:secret",
      unsupportedTestDc: true,
      validEncoding: true,
    },
  );
  assert.deepEqual(
    telegramRouteFromPath("/bot123:secret/?method=getUpdates"),
    {
      decodedPathname: "/bot123:secret/?method=getUpdates",
      missingPathMethod: true,
      method: "unknown",
      token: "123:secret",
      unsupportedTestDc: false,
      validEncoding: true,
    },
  );

  assert.equal(filePathFromPathname("/file/bot123:secret/folder%20name/a.ogg"), "folder name/a.ogg");
  assert.equal(filePathFromPathname("/file/bot123:secret/bad%E0%A4%A"), "bad%E0%A4%A");
  assert.equal(filePathFromPathname("/bot123:secret/getFile"), "");
});

test("content type and multipart detection stay case-insensitive", () => {
  const multipart = request("/", { headers: { "content-type": "Multipart/Form-Data; boundary=x" } });
  assert.equal(contentType(multipart), "multipart/form-data; boundary=x");
  assert.equal(isMultipartUploadRequest(multipart), true);
  assert.equal(contentType(null), "");
  assert.equal(isMultipartUploadRequest(request("/")), false);
});

test("legacy offsets remain permissive while durable integers stay exact and safe", () => {
  assert.equal(numericOffset("42tail"), 42);
  assert.equal(numericOffset("1e3"), 1);
  assert.equal(numericOffset("-9"), -9);
  assert.equal(numericOffset("not-a-number"), null);
  assert.equal(numericOffset(null), null);

  assert.equal(exactSafeNonNegativeInteger("0"), 0);
  assert.equal(exactSafeNonNegativeInteger("42"), 42);
  assert.equal(exactSafeNonNegativeInteger("01"), null);
  assert.equal(exactSafeNonNegativeInteger("-1"), null);
  assert.equal(exactSafeNonNegativeInteger("9007199254740992"), null);
});

test("offset and timeout extraction prefers query then supports JSON and form bodies", () => {
  const queryReq = request("/bot1:x/getUpdates?offset=12tail&timeout=7tail", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  assert.equal(requestOffsetValue(queryReq, jsonBody({ offset: 99 })), 12);
  assert.equal(requestOffsetFloor(queryReq, jsonBody({ offset: 99 })), 11);
  assert.equal(requestTimeoutValue(queryReq, jsonBody({ timeout: 99 })), 7);

  const jsonReq = request("/bot1:x/getUpdates", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(requestOffsetValue(jsonReq, jsonBody({ offset: -3 })), -3);
  assert.equal(requestTimeoutValue(jsonReq, jsonBody({ timeout: 0 })), 0);

  const formReq = request("/bot1:x/getUpdates", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const form = Buffer.from("offset=33&timeout=4");
  assert.equal(requestOffsetValue(formReq, form), 33);
  assert.equal(requestTimeoutValue(formReq, form), 4);

  assert.equal(requestOffsetValue(jsonReq, Buffer.from("{bad-json")), null);
  assert.equal(requestTimeoutValue(request("/bot1:x/getUpdates"), Buffer.alloc(0)), null);
});

test("getFile file_id extraction prefers query then supports JSON and form bodies", () => {
  assert.equal(
    requestFileId(
      request("/bot1:x/getFile?file_id=query-id", {
        headers: { "content-type": "application/json" },
      }),
      jsonBody({ file_id: "body-id" }),
    ),
    "query-id",
  );
  assert.equal(
    requestFileId(
      request("/bot1:x/getFile", {
        headers: { "content-type": "application/json" },
      }),
      jsonBody({ file_id: "json-id" }),
    ),
    "json-id",
  );
  assert.equal(
    requestFileId(
      request("/bot1:x/getFile", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      Buffer.from("file_id=form-id"),
    ),
    "form-id",
  );
  assert.equal(
    requestFileId(
      request("/bot1:x/getFile", {
        headers: { "content-type": "application/json" },
      }),
      Buffer.from("{bad-json"),
    ),
    "",
  );
});

test("offset and timeout rewrites preserve JSON, form, and query behavior", () => {
  const jsonReq = request("/bot1:x/getUpdates?keep=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const jsonOffset = bodyWithOffset(jsonReq, jsonBody({ offset: 1, keep: true }), 20);
  assert.equal(jsonOffset.reqUrl, jsonReq.url);
  assert.deepEqual(JSON.parse(jsonOffset.body), { offset: 20, keep: true });

  const jsonBoth = bodyWithOffsetAndTimeout(jsonReq, jsonBody({ keep: true }), 21, 0);
  assert.equal(jsonBoth.reqUrl, jsonReq.url);
  assert.deepEqual(JSON.parse(jsonBoth.body), { keep: true, offset: 21, timeout: 0 });

  const formReq = request("/bot1:x/getUpdates", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const formTimeout = bodyWithTimeout(formReq, Buffer.from("timeout=90&keep=yes"), 10);
  assert.equal(formTimeout.reqUrl, formReq.url);
  assert.equal(formTimeout.body.toString(), "timeout=10&keep=yes");

  const original = Buffer.from("opaque");
  const query = bodyWithOffsetAndTimeout(request("/bot1:x/getUpdates?keep=yes"), original, 30, 0);
  assert.equal(query.reqUrl, "/bot1:x/getUpdates?keep=yes&offset=30&timeout=0");
  assert.equal(query.body, original);

  const invalidJson = Buffer.from("{bad-json");
  const fallback = bodyWithTimeout(jsonReq, invalidJson, 5);
  assert.equal(fallback.reqUrl, "/bot1:x/getUpdates?keep=1&timeout=5");
  assert.equal(fallback.body, invalidJson);
});

test("requestWithUrl preserves identity only when URL is unchanged", () => {
  const req = request("/before", {
    method: "POST",
    headers: { x: "1" },
    extra: { socketOnly: true },
  });
  assert.equal(requestWithUrl(req, "/before"), req);
  assert.deepEqual(requestWithUrl(req, "/after"), {
    method: "POST",
    headers: req.headers,
    url: "/after",
  });
});

test("getUpdates timeout cap is explicit and leaves other methods untouched", () => {
  const untouchedReq = request("/bot1:x/sendMessage?timeout=99");
  const untouchedBody = Buffer.alloc(0);
  assert.deepEqual(applyGetUpdatesTimeoutCap(untouchedReq, "sendMessage", untouchedBody, 10), {
    req: untouchedReq,
    body: untouchedBody,
    capped: false,
    timeout: null,
  });

  const withinCapReq = request("/bot1:x/getUpdates?timeout=-1");
  const withinCap = applyGetUpdatesTimeoutCap(withinCapReq, "getUpdates", Buffer.alloc(0), 10);
  assert.equal(withinCap.req, withinCapReq);
  assert.equal(withinCap.capped, false);
  assert.equal(withinCap.timeout, -1);

  const overCapReq = request("/bot1:x/getUpdates?timeout=90");
  const overCap = applyGetUpdatesTimeoutCap(overCapReq, "getUpdates", Buffer.alloc(0), 10);
  assert.equal(overCap.req.url, "/bot1:x/getUpdates?timeout=10");
  assert.equal(overCap.capped, true);
  assert.equal(overCap.timeout, 10);
});

test("copyHeaders removes hop-by-hop and host headers without changing other values", () => {
  assert.deepEqual(copyHeaders({
    Connection: "close",
    HOST: "example.test",
    "Keep-Alive": "timeout=5",
    "Content-Type": "application/json",
    "x-custom": ["a", "b"],
  }), {
    "Content-Type": "application/json",
    "x-custom": ["a", "b"],
  });
});

test("buffering and streaming classification preserve current boundary behavior", () => {
  assert.equal(canBufferRequest(request("/file/bot1:x/a.bin"), 8), false);
  assert.equal(canBufferRequest(request("/bot1:x/sendDocument", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
  }), 1024), false);
  assert.equal(canBufferRequest(request("/bot1:x/sendMessage", {
    method: "POST",
    headers: { "content-length": "8tail", "content-type": "application/octet-stream" },
  }), 8), true);
  assert.equal(canBufferRequest(request("/bot1:x/sendMessage", {
    method: "POST",
    headers: { "content-length": "9", "content-type": "application/json" },
  }), 8), false);
  assert.equal(canBufferRequest(request("/bot1:x/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
  }), 8), true);
  assert.equal(canBufferRequest(request("/bot1:x/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
  }), 8), false);

  const upload = request("/bot1:x/sendDocument", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
  });
  assert.equal(streamingKind(upload, "sendDocument"), "upload");
  assert.equal(streamingKind(request("/file/bot1:x/a.bin"), "file"), "download");
  assert.equal(streamingKind(request("/bot1:x/getMe"), "getMe"), "download");
  assert.equal(streamingKind(request("/bot1:x/sendMessage", { method: "POST" }), "sendMessage"), "passthrough");
});
