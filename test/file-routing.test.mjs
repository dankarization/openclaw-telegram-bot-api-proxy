import assert from "node:assert/strict";
import test from "node:test";

import {
  FileRouter,
  createFileRouter,
} from "../src/file-routing.mjs";

const CLOUD_FILE_LIMIT = 20 * 1024 * 1024;

function getFileResponse({
  filePath,
  fileSize,
  headers = { "x-upstream": "kept" },
  ok = true,
  statusCode = 200,
} = {}) {
  return {
    statusCode,
    headers,
    body: Buffer.from(JSON.stringify({
      ok,
      result: {
        file_path: filePath,
        file_size: fileSize,
      },
    })),
  };
}

test("local getFile rewrites the path and keeps both local aliases local", () => {
  const router = createFileRouter({
    localFilePathRewriteFrom: "/container-data///",
    localFilePathRewriteTo: "/host-data/",
  });
  assert(router instanceof FileRouter);

  const token = "111111:local-secret-value";
  const upstream = getFileResponse({
    filePath: "/container-data/media/voice.ogg",
    fileSize: 1024,
  });
  const processed = router.processGetFileResult(
    "GETFILE",
    token,
    upstream,
    "local",
  );

  assert.notEqual(processed, upstream);
  assert.equal(processed.headers["x-upstream"], "kept");
  assert.equal(processed.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(processed.body), {
    ok: true,
    result: {
      file_path: "/host-data/media/voice.ogg",
      file_size: 1024,
    },
  });
  assert.deepEqual(
    router.cloudFileFallbackDecision(
      token,
      "/file/bot111111:local-secret-value/%2Fcontainer-data%2Fmedia%2Fvoice.ogg",
    ),
    {
      allowed: false,
      reason: "file-source-local",
      source: "local",
    },
  );
  assert.deepEqual(
    router.cloudFileFallbackDecision(
      token,
      "/file/bot111111:local-secret-value/%2Fhost-data%2Fmedia%2Fvoice.ogg",
    ),
    {
      allowed: false,
      reason: "file-source-local",
      source: "local",
    },
  );

  assert.equal(
    router.rewriteLocalFilePath("/container-database/media/voice.ogg"),
    "/container-database/media/voice.ogg",
  );
  assert.equal(router.rewriteLocalFilePath("/container-data"), "/host-data");
});

test("cloud size and source decisions remain bot-scoped", () => {
  const router = createFileRouter({
    cloudFileFallbackMaxBytes: CLOUD_FILE_LIMIT,
  });
  const sharedPath = "documents/shared.pdf";
  const firstToken = "222222:first-secret-value";
  const rotatedToken = "222222:rotated-secret-value";
  const otherToken = "333333:other-secret-value";

  const boundary = getFileResponse({
    filePath: sharedPath,
    fileSize: CLOUD_FILE_LIMIT,
  });
  assert.equal(
    router.processGetFileResult(
      "getFile",
      firstToken,
      boundary,
      "cloud",
    ),
    boundary,
  );

  assert.deepEqual(
    router.cloudFileFallbackDecision(
      rotatedToken,
      `/file/bot${rotatedToken}/${sharedPath}`,
    ),
    {
      allowed: true,
      reason: "file-source-cloud",
      source: "cloud",
    },
  );
  assert.deepEqual(
    router.cloudFileFallbackDecision(
      otherToken,
      `/file/bot${otherToken}/${sharedPath}`,
    ),
    { allowed: false, reason: "file-size-unknown" },
  );

  router.processGetFileResult(
    "getFile",
    otherToken,
    getFileResponse({
      filePath: sharedPath,
      fileSize: CLOUD_FILE_LIMIT + 1,
    }),
    "cloud",
  );
  assert.deepEqual(
    router.cloudFileFallbackDecision(
      otherToken,
      `/file/bot${otherToken}/${sharedPath}`,
    ),
    { allowed: false, reason: "file-too-large" },
  );
});

test("file affinity expires exactly at the injected TTL boundary", () => {
  let currentTime = 10_000;
  const router = createFileRouter({
    fileInfoCacheTtlMs: 1_000,
    now: () => currentTime,
  });
  const token = "444444:ttl-secret-value";
  const filePath = "cloud/expiring.bin";

  router.processGetFileResult(
    "getFile",
    token,
    getFileResponse({ filePath, fileSize: 100 }),
    "cloud",
  );

  currentTime = 10_999;
  assert.equal(
    router.cloudFileFallbackDecision(
      token,
      `/file/bot${token}/${filePath}`,
    ).allowed,
    true,
  );

  currentTime = 11_000;
  assert.deepEqual(
    router.cloudFileFallbackDecision(
      token,
      `/file/bot${token}/${filePath}`,
    ),
    { allowed: false, reason: "file-size-unknown" },
  );
});

test("unexpected getFile responses are returned unchanged and add no affinity", () => {
  const router = createFileRouter();
  const token = "555555:unexpected-secret-value";
  const pathname = `/file/bot${token}/cloud/untrusted.bin`;
  const cases = [
    {
      method: "sendMessage",
      upstream: getFileResponse({
        filePath: "cloud/untrusted.bin",
        fileSize: 1,
      }),
    },
    {
      method: "getFile",
      upstream: getFileResponse({
        filePath: "cloud/untrusted.bin",
        fileSize: 1,
        statusCode: 201,
      }),
    },
    {
      method: "getFile",
      upstream: {
        statusCode: 200,
        headers: {},
        body: Buffer.from("{not-json"),
      },
    },
    {
      method: "getFile",
      upstream: getFileResponse({
        filePath: "cloud/untrusted.bin",
        fileSize: 1,
        ok: false,
      }),
    },
  ];

  for (const { method, upstream } of cases) {
    assert.equal(
      router.processGetFileResult(method, token, upstream, "cloud"),
      upstream,
    );
  }
  assert.deepEqual(
    router.cloudFileFallbackDecision(token, pathname),
    { allowed: false, reason: "file-size-unknown" },
  );
});

test("missing file size preserves the legacy unknown-size decision", () => {
  const router = createFileRouter();
  const token = "666666:no-size-secret-value";
  const filePath = "cloud/no-size.bin";

  router.processGetFileResult(
    "getFile",
    token,
    getFileResponse({ filePath, fileSize: undefined }),
    "cloud",
  );

  assert.deepEqual(
    router.cloudFileFallbackDecision(
      token,
      `/file/bot${token}/${filePath}`,
    ),
    { allowed: false, reason: "file-size-unknown" },
  );
});
