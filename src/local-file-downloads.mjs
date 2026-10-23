import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { exactSafeNonNegativeInteger } from "./request-parsing.mjs";

function canonicalPath(value) {
  return typeof value === "string"
    && value.startsWith("/")
    && !/[\x00-\x1f\x7f\\]/u.test(value)
    && value.split("/").slice(1).every((part) => part && part !== "." && part !== "..");
}

function beneath(root, filename) {
  return filename.startsWith(`${root}/`);
}

function grantKey(token, filename) {
  // Do not retain credentials or authorize a guessed/rotated secret merely
  // because it shares the public bot ID used by the affinity cache.
  return createHash("sha256").update(token).update("\0").update(filename).digest("hex");
}

function unavailable(res, status = 404) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ ok: false, error_code: status, description: "Local file unavailable; obtain a fresh getFile result" }));
  return { statusCode: status };
}

/** Linux host-local files exposed only after an authenticated local getFile.
 * The configured rewrite destination is the only readable root. Grants are
 * bounded, process-local and exact-token/path scoped.
 */
export class LocalFileDownloads {
  #root;
  #realRoot;
  #ttlMs;
  #now;
  #maxGrants;
  #grants = new Map();

  constructor({ root = "", ttlMs = 300_000, now = Date.now, maxGrants = 10_000 } = {}) {
    const normalized = root ? path.resolve(root) : "";
    this.#root = normalized !== "/" && canonicalPath(normalized) ? normalized : "";
    this.#realRoot = this.#root ? realpath(this.#root).catch(() => null) : Promise.resolve(null);
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#maxGrants = maxGrants;
  }

  observe(token, upstream) {
    if (!this.#root || !token || upstream.statusCode !== 200) return;
    try {
      const payload = JSON.parse(upstream.body.toString("utf8"));
      const filename = payload?.result?.file_path;
      const rawSize = payload?.result?.file_size;
      const size = rawSize == null ? null : exactSafeNonNegativeInteger(rawSize);
      if (payload?.ok !== true || !canonicalPath(filename) || !beneath(this.#root, filename)
        || (rawSize != null && (typeof rawSize !== "number" || size == null))) return;
      const now = this.#now();
      for (const [key, grant] of this.#grants) {
        if (now - grant.at >= this.#ttlMs) this.#grants.delete(key);
      }
      const key = grantKey(token, filename);
      this.#grants.delete(key);
      while (this.#grants.size >= this.#maxGrants) this.#grants.delete(this.#grants.keys().next().value);
      this.#grants.set(key, { at: now, size });
    } catch {
      // Invalid metadata never grants filesystem access or alters getFile.
    }
  }

  async serve(req, res, token, filename, { signal, timeoutMs = 7_200_000, idleTimeoutMs = 130_000 } = {}) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("allow", "GET, HEAD");
      return unavailable(res, 405);
    }
    const key = grantKey(token, filename);
    const grant = this.#grants.get(key);
    if (!grant || this.#now() - grant.at >= this.#ttlMs) {
      this.#grants.delete(key);
      return unavailable(res);
    }
    if (!this.#root || !canonicalPath(filename) || !beneath(this.#root, filename)) return unavailable(res);

    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("local file download timeout")), timeoutMs);
    timer.unref?.();
    const onIdle = () => controller.abort(new Error("local file download idle timeout"));
    res.setTimeout(idleTimeoutMs, onIdle);
    let handle;
    try {
      combinedSignal.throwIfAborted();
      const root = await this.#realRoot;
      if (!root || root === "/" || await realpath(this.#root) !== root) return unavailable(res);
      const resolved = await realpath(filename);
      // Root itself may be a configured symlink, but no alias below that root
      // may redirect an authorized pathname to another bot/cache file.
      const expected = path.join(root, path.relative(this.#root, filename));
      if (!beneath(root, resolved) || resolved !== expected) return unavailable(res);
      // O_NONBLOCK prevents a substituted FIFO from pinning this process.
      handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // Verify the opened descriptor too: ancestor renames/symlinks must not
      // turn an approved cache pathname into an escape.
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      const stat = await handle.stat();
      if (opened !== resolved || !beneath(root, opened) || !stat.isFile()
        || !Number.isSafeInteger(stat.size) || (grant.size != null && stat.size !== grant.size)) return unavailable(res);
      combinedSignal.throwIfAborted();
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(stat.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD" || stat.size === 0) res.end();
      else {
        // Bound by the validated size even if the upstream cache file grows.
        const source = handle.createReadStream({ autoClose: false, end: stat.size - 1 });
        let sent = 0;
        const integrity = new Transform({
          transform(chunk, encoding, callback) { sent += chunk.length; callback(null, chunk); },
          flush(callback) {
            callback(sent === stat.size ? null : new Error("local file size changed during transfer"));
          },
        });
        await pipeline(source, integrity, res, { signal: combinedSignal });
      }
      return { statusCode: 200 };
    } catch (error) {
      if (!res.headersSent && !combinedSignal.aborted && !res.destroyed) return unavailable(res);
      throw error;
    } finally {
      clearTimeout(timer);
      res.removeListener("timeout", onIdle);
      if (!res.destroyed) res.setTimeout(0);
      await handle?.close();
    }
  }
}
