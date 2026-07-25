import assert from "node:assert/strict";
import test from "node:test";

import {
  FallbackPolicy,
  createFallbackPolicy,
} from "../src/fallback-policy.mjs";

function createPolicy({
  cloudFallbackEnabled = true,
  cloudGetUpdatesFallbackEnabled = true,
  fileDecision = {
    allowed: true,
    reason: "file-source-cloud",
    source: "cloud",
  },
  onFileDecision = () => {},
} = {}) {
  return createFallbackPolicy({
    cloudFallbackEnabled,
    cloudGetUpdatesFallbackEnabled,
    fileRouter: {
      cloudFileFallbackDecision(token, pathname) {
        onFileDecision(token, pathname);
        return fileDecision;
      },
    },
  });
}

test("constructor requires a file decision provider", () => {
  assert.throws(
    () => new FallbackPolicy({
      cloudFallbackEnabled: true,
      cloudGetUpdatesFallbackEnabled: true,
      fileRouter: null,
    }),
    /fileRouter\.cloudFileFallbackDecision is required/u,
  );
});

test("global and getUpdates flags keep their legacy precedence", () => {
  const disabled = createPolicy({ cloudFallbackEnabled: false });
  assert.deepEqual(
    disabled.cloudFallbackPolicy(
      "close",
      "111111:secret",
      "",
      {
        headers: {
          "content-type": "multipart/form-data; boundary=x",
        },
      },
    ),
    { allowed: false, reason: "fallback-disabled" },
  );

  const getUpdatesDisabled = createPolicy({
    cloudGetUpdatesFallbackEnabled: false,
  });
  assert.deepEqual(
    getUpdatesDisabled.cloudFallbackPolicy(
      "getUpdates",
      "111111:secret",
    ),
    {
      allowed: false,
      reason: "cloud-getupdates-fallback-disabled",
    },
  );
  assert.deepEqual(
    getUpdatesDisabled.cloudFallbackPolicy(
      "getMe",
      "111111:secret",
    ),
    { allowed: true, reason: "safe-method" },
  );
});

test("local-only methods precede multipart and safe/default routing", () => {
  const policy = createPolicy();
  const multipart = {
    headers: {
      "content-type": "Multipart/Form-Data; boundary=x",
    },
  };

  for (const method of ["close", "logOut", "logout", "setWebhook"]) {
    assert.deepEqual(
      policy.cloudFallbackPolicy(
        method,
        "222222:secret",
        "",
        multipart,
      ),
      { allowed: false, reason: "local-only-method" },
    );
  }
  assert.deepEqual(
    policy.cloudFallbackPolicy(
      "sendMessage",
      "222222:secret",
      "",
      multipart,
    ),
    {
      allowed: false,
      reason: "multipart-upload-local-only",
    },
  );
});

test("named safe methods and default non-file methods preserve reasons", () => {
  const policy = createPolicy();

  for (const method of [
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
  ]) {
    assert.equal(policy.isSafeMethodForStatusFallback(method), true, method);
    assert.deepEqual(
      policy.cloudFallbackPolicy(method, "333333:secret"),
      { allowed: true, reason: "safe-method" },
      method,
    );
  }

  assert.equal(
    policy.isSafeMethodForStatusFallback("sendDocument"),
    false,
  );
  assert.deepEqual(
    policy.cloudFallbackPolicy("sendDocument", "333333:secret"),
    { allowed: true, reason: "default-non-file-method" },
  );
  assert.equal(
    policy.canUseCloudFallback("sendDocument", "333333:secret"),
    true,
  );
});

test("file downloads delegate the exact token and pathname to the router", () => {
  const calls = [];
  const decision = {
    allowed: false,
    reason: "file-source-local",
    source: "local",
  };
  const policy = createPolicy({
    fileDecision: decision,
    onFileDecision(token, pathname) {
      calls.push({ token, pathname });
    },
  });
  const token = "444444:delegated-secret";
  const pathname = `/file/bot${token}/voice/a.ogg`;

  assert.equal(
    policy.cloudFallbackPolicy("file", token, pathname),
    decision,
  );
  assert.deepEqual(calls, [{ token, pathname }]);
  assert.equal(
    policy.canUseCloudFallback("file", token, pathname),
    false,
  );
  assert.deepEqual(calls, [
    { token, pathname },
    { token, pathname },
  ]);
});

test("local status retry rules stay method- and status-specific", () => {
  const policy = createPolicy();

  for (const statusCode of [401, 404]) {
    assert.equal(
      policy.shouldRetryCloudAfterLocalStatus(
        "sendMessage",
        statusCode,
      ),
      true,
    );
    assert.equal(
      policy.shouldRetryCloudAfterLocalStatus(
        "getUpdates",
        statusCode,
      ),
      false,
    );
  }
  assert.equal(
    policy.shouldRetryCloudAfterLocalStatus("getFile", 400),
    true,
  );
  assert.equal(
    policy.shouldRetryCloudAfterLocalStatus("sendMessage", 400),
    false,
  );
  assert.equal(
    policy.shouldRetryCloudAfterLocalStatus("getFile", 500),
    false,
  );
});
