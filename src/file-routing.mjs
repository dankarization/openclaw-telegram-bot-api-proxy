import {
  canonicalMethodName,
  exactSafeNonNegativeInteger,
  filePathFromPathname,
  numericOffset,
} from "./request-parsing.mjs";

const DEFAULT_FILE_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_FILE_UPDATE_INFO_CACHE_TTL_MS = 30 * 60 * 1000;
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
  #fileUpdateInfoByBotIdAndId = new Map();
  #fileUpdateInfoCacheTtlMs;
  #localFilePathRewriteFrom;
  #localFilePathRewriteTo;
  #now;

  constructor({
    cloudFileFallbackMaxBytes = DEFAULT_CLOUD_FILE_FALLBACK_MAX_BYTES,
    fileInfoCacheTtlMs = DEFAULT_FILE_INFO_CACHE_TTL_MS,
    fileUpdateInfoCacheTtlMs = DEFAULT_FILE_UPDATE_INFO_CACHE_TTL_MS,
    localFilePathRewriteFrom = "",
    localFilePathRewriteTo = "",
    now = Date.now,
  } = {}) {
    this.#cloudFileFallbackMaxBytes = cloudFileFallbackMaxBytes;
    this.#fileInfoCacheTtlMs = fileInfoCacheTtlMs;
    this.#fileUpdateInfoCacheTtlMs = fileUpdateInfoCacheTtlMs;
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
      canonicalMethodName(method) !== "getFile"
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

  observeGetUpdatesResult(token, upstream, source) {
    if (
      upstream?.statusCode !== 200
      || !upstream?.body?.length
      || (source !== "local" && source !== "cloud")
    ) {
      return;
    }
    try {
      const payload = JSON.parse(upstream.body.toString("utf8"));
      if (!payload?.ok || !Array.isArray(payload.result)) return;
      const files = this.#collectUpdateFileInfo(payload.result);
      const botId = botIdFromToken(token);
      if (!botId) return;
      const now = this.#now();
      this.#pruneExpiredUpdateFileInfo(now);
      for (const [fileId, info] of files) {
        this.#cacheUpdateFileInfo(
          botId,
          fileId,
          info.fileSize,
          source,
          now,
        );
      }
    } catch {
      // Metadata capture is best-effort and never changes the update response.
    }
  }

  cloudGetFileFallbackDecision(token, fileId) {
    if (!fileId) return { allowed: false, reason: "file-id-unknown" };
    const info = this.#cachedUpdateFileInfo(token, fileId);
    if (info?.fileSize != null && info.fileSize > this.#cloudFileFallbackMaxBytes) {
      return {
        allowed: false,
        reason: "file-too-large",
        source: info.source,
        fileSize: info.fileSize,
      };
    }
    if (info?.source === "cloud") {
      return {
        allowed: true,
        reason: "file-id-source-cloud",
        source: "cloud",
        fileSize: info.fileSize,
      };
    }
    if (info?.fileSize != null) {
      return {
        allowed: true,
        reason: "file-id-confirmed-small",
        source: info.source,
        fileSize: info.fileSize,
      };
    }
    if (info?.source === "local") {
      return {
        allowed: false,
        reason: "file-id-source-local-size-unknown",
        source: "local",
      };
    }
    return { allowed: false, reason: "file-id-source-unknown" };
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

  #cacheUpdateFileInfo(botId, fileId, fileSize, source, now) {
    if (!botId || !fileId || (source !== "local" && source !== "cloud")) return;
    const key = `${botId}:${fileId}`;
    const previous = this.#fileUpdateInfoByBotIdAndId.get(key);
    const parsedFileSize = exactSafeNonNegativeInteger(fileSize);
    this.#fileUpdateInfoByBotIdAndId.set(key, {
      fileSize: parsedFileSize ?? previous?.fileSize ?? null,
      source,
      cachedAt: now,
    });
  }

  #cachedUpdateFileInfo(token, fileId) {
    const key = `${botIdFromToken(token)}:${fileId}`;
    const info = this.#fileUpdateInfoByBotIdAndId.get(key);
    if (!info) return null;
    if (this.#now() - info.cachedAt >= this.#fileUpdateInfoCacheTtlMs) {
      this.#fileUpdateInfoByBotIdAndId.delete(key);
      return null;
    }
    return info;
  }

  #collectUpdateFileInfo(value, files = new Map(), visited = new Set()) {
    if (!value || typeof value !== "object" || visited.has(value)) return files;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) this.#collectUpdateFileInfo(item, files, visited);
      return files;
    }

    const fileId = typeof value.file_id === "string" ? value.file_id : "";
    if (fileId) {
      const fileSize = exactSafeNonNegativeInteger(value.file_size);
      const previous = files.get(fileId);
      files.set(fileId, { fileSize: fileSize ?? previous?.fileSize ?? null });
    }
    for (const child of Object.values(value)) {
      this.#collectUpdateFileInfo(child, files, visited);
    }
    return files;
  }

  #pruneExpiredFileInfo(now) {
    for (const [key, info] of this.#fileInfoByBotIdAndPath) {
      if (now - info.cachedAt >= this.#fileInfoCacheTtlMs) {
        this.#fileInfoByBotIdAndPath.delete(key);
      }
    }
  }

  #pruneExpiredUpdateFileInfo(now) {
    for (const [key, info] of this.#fileUpdateInfoByBotIdAndId) {
      if (now - info.cachedAt >= this.#fileUpdateInfoCacheTtlMs) {
        this.#fileUpdateInfoByBotIdAndId.delete(key);
      }
    }
  }
}

export function createFileRouter(options) {
  return new FileRouter(options);
}
