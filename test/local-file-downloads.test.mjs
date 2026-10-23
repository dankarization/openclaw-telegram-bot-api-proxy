import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { LocalFileDownloads } from "../src/local-file-downloads.mjs";

test("bounded local grants evict oldest authorization, expire exactly and isolate credentials", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bounded-local-grants-"));
  let now = 1000;
  const downloads = new LocalFileDownloads({ root, ttlMs: 100, now: () => now, maxGrants: 2 });
  for (const name of ["one", "two", "three"]) await writeFile(path.join(root, name), name);
  const observe = (token, name) => downloads.observe(token, {
    statusCode: 200,
    body: Buffer.from(JSON.stringify({ ok: true, result: { file_path: path.join(root, name), file_size: name.length } })),
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://test");
    try {
      await downloads.serve(req, res, url.searchParams.get("token"), path.join(root, url.searchParams.get("file")));
    } catch (error) { res.destroy(error); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true }); });
  async function status(token, file) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/?token=${token}&file=${file}`);
    await res.text();
    return res.status;
  }
  observe("1:secret", "one");
  observe("1:secret", "two");
  observe("1:secret", "three");
  assert.equal(await status("1:secret", "one"), 404);
  assert.equal(await status("1:secret", "two"), 200);
  assert.equal(await status("1:wrong-secret", "two"), 404);
  assert.equal(await status("2:secret", "two"), 404);
  now += 100;
  assert.equal(await status("1:secret", "two"), 404);
  observe("1:secret", "two");
  assert.equal(await status("1:secret", "two"), 200);
});
