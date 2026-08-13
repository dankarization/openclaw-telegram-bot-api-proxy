import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import { copyHeaders } from "./request-parsing.mjs";
import { runtimeHooks } from "./runtime-hooks.mjs";

function targetUrl(root, reqUrl) {
  return new URL(`${root}${reqUrl}`);
}

export function createUpstreamClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const hooks = options.hooks || runtimeHooks;
  const httpModule = options.httpModule || http;
  const httpsModule = options.httpsModule || https;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? 130_000;

  async function probeUpstream(root, reqUrl, requestOptions = {}) {
    const controller = new AbortController();
    const timeoutMs = requestOptions.timeoutMs ?? upstreamTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const traceContext = {
      method: requestOptions.method || "unknown",
      target: requestOptions.target || "unknown",
    };
    try {
      const signal = requestOptions.signal
        ? AbortSignal.any([requestOptions.signal, controller.signal])
        : controller.signal;
      await hooks.fault("before-upstream-request", traceContext);
      const response = await fetchImpl(`${root}${reqUrl}`, {
        method: "GET",
        signal,
      });
      try {
        const cancellation = response.body?.cancel();
        void cancellation?.catch(() => {});
      } catch {
        // Health is decided by response headers, matching the legacy probe.
      }
      await hooks.fault("after-upstream-response", {
        ...traceContext,
        statusCode: response.status,
      });
      return { statusCode: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function forwardBuffered(req, root, body, reqUrl = req.url, requestOptions = {}) {
    const url = `${root}${reqUrl}`;
    const controller = new AbortController();
    const timeoutMs = requestOptions.timeoutMs ?? upstreamTimeoutMs;
    const timeout = setTimeout(() => {
      controller.abort(Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    timeout.unref?.();
    try {
      const signal = requestOptions.signal
        ? AbortSignal.any([requestOptions.signal, controller.signal])
        : controller.signal;
      const headers = copyHeaders(req.headers);
      if (body.length === 0) delete headers["content-length"];
      else headers["content-length"] = String(body.length);
      const traceContext = {
        method: requestOptions.method || "unknown",
        target: requestOptions.target || "unknown",
      };
      await hooks.fault("before-upstream-request", traceContext);
      const response = await fetchImpl(url, {
        method: req.method,
        headers,
        body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        signal,
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      await hooks.fault("after-upstream-response", {
        ...traceContext,
        statusCode: response.status,
      });
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  function forwardStreaming(req, res, root, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      const url = targetUrl(root, req.url);
      const client = url.protocol === "https:" ? httpsModule : httpModule;
      const traceContext = {
        method: requestOptions.method || "unknown",
        target: requestOptions.target || "unknown",
      };
      let settled = false;
      let upstreamReq;

      const cleanup = () => requestOptions.signal?.removeEventListener("abort", onAbort);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onAbort = () => {
        upstreamReq?.destroy(requestOptions.signal.reason);
      };

      Promise.resolve(hooks.fault("before-upstream-request", traceContext)).then(() => {
        if (requestOptions.signal?.aborted) throw requestOptions.signal.reason;
        upstreamReq = client.request({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: req.method,
          headers: {
            ...copyHeaders(req.headers),
            host: url.host,
          },
          timeout: requestOptions.timeoutMs ?? upstreamTimeoutMs,
        }, (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, copyHeaders(upstreamRes.headers));
          upstreamRes.pipe(res);
          upstreamRes.on("end", async () => {
            try {
              await hooks.fault("after-upstream-response", {
                ...traceContext,
                statusCode: upstreamRes.statusCode || 0,
              });
              finish(resolve, { statusCode: upstreamRes.statusCode || 0 });
            } catch (error) {
              finish(reject, error);
            }
          });
        });
        requestOptions.signal?.addEventListener("abort", onAbort, { once: true });
        upstreamReq.on("timeout", () => {
          upstreamReq.destroy(Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" }));
        });
        upstreamReq.on("error", (error) => finish(reject, error));
        req.pipe(upstreamReq);
      }).catch((error) => finish(reject, error));
    });
  }

  return Object.freeze({
    forwardBuffered,
    forwardStreaming,
    probeUpstream,
  });
}
