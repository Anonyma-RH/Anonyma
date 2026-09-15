import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCatalog } from "../server/catalog.js";

test("catalog joins chat and dedicated media feeds atomically and preserves cache on partial failure", async (t) => {
  let mediaFails = false;
  const server = createServer((req, res) => {
    const media = req.url.includes("type=image,video");
    res.writeHead(media && mediaFails ? 503 : 200, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        data: [
          {
            id: media ? "live-video" : "live-chat",
            type: media ? "video" : "chat",
            pricing: { base_price: 0.4 },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "anonyma-feeds-"));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true });
  });
  const cfg = {
    gateway: `http://127.0.0.1:${server.address().port}`,
    catalogPath: join(dir, "catalog.json"),
  };
  const snapshot = await syncCatalog(cfg, {
    data: [{ id: "old", type: "video", status: "live" }],
  });
  assert.equal(snapshot.data.find((m) => m.id === "live-video").status, "live");
  assert.equal(snapshot.data.find((m) => m.id === "live-chat").status, "live");
  assert.equal(snapshot.data.find((m) => m.id === "old").status, "unavailable");
  const before = readFileSync(cfg.catalogPath, "utf8");
  mediaFails = true;
  await assert.rejects(syncCatalog(cfg, snapshot), /503/);
  assert.equal(readFileSync(cfg.catalogPath, "utf8"), before);
});
