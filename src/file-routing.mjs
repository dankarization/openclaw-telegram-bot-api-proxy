import {
  filePathFromPathname,
  numericOffset,
} from "./request-parsing.mjs";

const DEFAULT_FILE_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CLOUD_FILE_FALLBACK_MAX_BYTES = 20 * 1024 * 1024;

function trimPathPrefix(value) {
  return String(value || "").replace(/\/+$/u, "");
}

function botIdFromToken(token) {
  return String(token || "").split(":", 1)[0] || "";
}

/**
 * Keeps short-lived getFile metadata scoped to the public bot ID.
 *
 * Full bot tokens are accepted only at method boundaries, reduced immediately
 * to their bot ID, and never retained in the cache.
 */
export class FileRouter {
  #cloudFileFallbackMaxBytes;
  #fileInfoByBotIdAndPath = new Map();
  #fileInfoCacheTtlMs;
  #localFilePathRewriteFrom;
  #localFilePathRewriteTo;
  #now;

  constructor({
    cloudFileFallbackMaxBytes = DEFAULT_CLOUD_FILE_FALLBACK_MAX_BYTES,
    fileInfoCacheTtlMs = DEFAULT_FILE_INFO_CACHE_TTL_MS,
    localFilePathRewriteFrom = "",
    localFilePathRewriteTo = "",
    now = Date.now,
  } = {}) {
    this.#cloudFileFallbackMaxBytes = cloudFileFallbackMaxBytes;
    this.#fileInfoCacheTtlMs = fileInfoCacheTtlMs;
    this.#localFilePathRewriteFrom = trimPathPrefix(localFilePathRewriteFrom);
    this.#localFilePathRewriteTo = trimPathPrefix(localFilePathRewriteTo);
    this.#now = now;
  }

  rewriteLocalFilePath(filePath) {
    if (
      !this.#localFilePathRewriteFrom
      || !this.#localFilePathRewriteTo
      || typeof filePath !== "string"
    ) {
      return filePath;
    }
    if (filePath === this.#localFilePathRewriteFrom) {
      return this.#localFilePathRewriteTo;
    }
    if (filePath.startsWith(`${this.#localFilePathRewriteFrom}/`)) {
      return `${this.#localFilePathRewriteTo}${filePath.slice(this.#localFilePathRewriteFrom.length)}`;
    }
    return filePath;
  }

  processGetFileResult(method, token, upstream, target) {
    if (
      method !== "getFile"
      || upstream.statusCode !== 200
      || !upstream.body?.length
    ) {
      return upstream;
    }

    try {
      const payload = JSON.parse(upstream.body.toString("utf8"));
      const filePath = payload?.result?.file_path;
      if (!payload?.ok || typeof filePath !== "string" || !filePath) {
        return upstream;
      }

      const botId = botIdFromToken(token);
      const rewrittenFilePath = target === "local"
        ? this.rewriteLocalFilePath(filePath)
        : filePath;
      this.#cacheFileInfo(botId, filePath, payload.result.file_size, target);

      if (rewrittenFilePath !== filePath) {
        this.#cacheFileInfo(
          botId,
          rewrittenFilePath,
          payload.result.file_size,
          target,
        );
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
      // Legacy behavior ignores non-JSON and unexpected getFile responses.
    }

    return upstream;
  }

  cloudFileFallbackDecision(token, pathname = "") {
    const botId = botIdFromToken(token);
    const filePath = filePathFromPathname(pathname);
    const info = this.#cachedFileInfo(botId, filePath);

    if (info?.fileSize == null) {
      return { allowed: false, reason: "file-size-unknown" };
    }
    if (info.source === "local") {
      return {
        allowed: false,
        reason: "file-source-local",
        source: "local",
      };
    }
    if (info.fileSize > this.#cloudFileFallbackMaxBytes) {
      return { allowed: false, reason: "file-too-large" };
    }
    if (info.source !== "cloud") {
      return { allowed: false, reason: "file-source-unknown" };
    }
    return {
      allowed: true,
      reason: "file-source-cloud",
      source: "cloud",
    };
  }

  #cacheFileInfo(botId, filePath, fileSize, source) {
    if (
      !botId
      || !filePath
      || (source !== "local" && source !== "cloud")
    ) {
      return;
    }

    const now = this.#now();
    this.#pruneExpiredFileInfo(now);
    this.#fileInfoByBotIdAndPath.set(`${botId}:${filePath}`, {
      fileSize: numericOffset(fileSize),
      source,
      cachedAt: now,
    });
  }

  #cachedFileInfo(botId, filePath) {
    const key = `${botId}:${filePath}`;
    const info = this.#fileInfoByBotIdAndPath.get(key);
    if (!info) return null;

    if (this.#now() - info.cachedAt >= this.#fileInfoCacheTtlMs) {
      this.#fileInfoByBotIdAndPath.delete(key);
      return null;
    }
    return info;
  }

  #pruneExpiredFileInfo(now) {
    for (const [key, info] of this.#fileInfoByBotIdAndPath) {
      if (now - info.cachedAt >= this.#fileInfoCacheTtlMs) {
        this.#fileInfoByBotIdAndPath.delete(key);
      }
    }
  }
}

export function createFileRouter(options) {
  return new FileRouter(options);
}
