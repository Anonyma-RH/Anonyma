import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { uid, now, fail, credits, splitCharge } from "./core.js";

const imageType = (bytes) =>
  bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ? "image/png"
    : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
      ? "image/jpeg"
      : bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
          bytes.subarray(8, 12).toString("latin1") === "WEBP"
        ? "image/webp"
        : bytes.subarray(0, 4).toString("latin1") === "GIF8"
          ? "image/gif"
          : null;
// Private media files on disk plus their rows, with signed temporary URLs
// for API callers.
export function createMediaStore(db, cfg) {
  function mediaJSON(m) {
    return {
      id: m.id,
      kind: m.kind,
      mime: m.mime,
      prompt: m.prompt,
      model: m.model,
      cost: credits(m.cost),
      created: m.created,
      url: "/api/media/" + m.id,
      expires: m.expires,
    };
  }
  function signMedia(id, expires) {
    return createHmac("sha256", cfg.secret)
      .update(`${id}:${expires}`)
      .digest("hex");
  }
  async function saveMedia(user, kind, source, meta = {}) {
    let bytes, mime;
    if (typeof source === "string" && source.startsWith("data:")) {
      const match = source.match(
        /^data:(image\/(?:png|jpeg|webp|gif)|video\/mp4);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match) fail(502, "Unsupported generated media format.");
      bytes = Buffer.from(match[2], "base64");
      // Providers return raw base64 without a type, so trust the bytes.
      mime = match[1].startsWith("image/")
        ? (imageType(bytes) ?? match[1])
        : match[1];
    } else if (Buffer.isBuffer(source)) {
      bytes = source;
      mime = meta.mime;
    } else {
      let url;
      try {
        url = new URL(source);
      } catch {
        fail(502, "Provider returned an invalid media URL.");
      }
      if (
        url.protocol !== "https:" ||
        !cfg.mediaHosts.includes(url.hostname) ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443")
      )
        fail(
          502,
          "Generated media host is not on the configured download allowlist.",
        );
      const response = await fetch(url, {
        redirect: "error",
        signal: meta.signal
          ? AbortSignal.any([meta.signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      });
      if (!response.ok) fail(502, "Could not download generated media.");
      mime = response.headers.get("content-type")?.split(";")[0];
      if (
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "video/mp4",
        ].includes(mime)
      )
        fail(502, "Provider returned unsupported media.");
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > 100 * 1024 * 1024)
          fail(502, "Generated file exceeds 100 MB.");
        parts.push(part);
      }
      bytes = Buffer.concat(parts);
    }
    if (bytes.length > 100 * 1024 * 1024)
      fail(502, "Generated file too large.");
    const id = uid("asset_"),
      ext =
        {
          "video/mp4": "mp4",
          "audio/mpeg": "mp3",
          "audio/x-wav": "wav",
          "audio/mp4": "m4a",
        }[mime] || mime.split("/")[1];
    const filename = id + "." + ext;
    writeFileSync(join(cfg.mediaPath, filename), bytes, { mode: 0o600 });
    db.prepare(
      "INSERT INTO media(id,user_id,kind,mime,filename,prompt,model,cost,created,expires) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      user,
      kind,
      mime,
      filename,
      meta.prompt || "",
      meta.model || "",
      meta.cost || 0,
      now(),
      meta.expires || null,
    );
    const old = db
      .prepare(
        "SELECT * FROM media WHERE user_id=? AND kind=? AND expires IS NULL AND id NOT IN (SELECT id FROM media WHERE user_id=? AND kind=? AND expires IS NULL ORDER BY created DESC,rowid DESC LIMIT ?)",
      )
      .all(user, kind, user, kind, kind === "image" ? 100 : 60);
    for (const item of old) deleteMedia(item);
    const result = mediaJSON(
      db.prepare("SELECT * FROM media WHERE id=?").get(id),
    );
    if (meta.expires)
      result.url =
        (cfg.publicUrl || cfg.origin) +
        result.url +
        `?expires=${meta.expires}&sig=${signMedia(id, meta.expires)}`;
    return result;
  }
  function deleteMedia(m) {
    try {
      unlinkSync(join(cfg.mediaPath, m.filename));
    } catch (error) {
      if (error.code !== "ENOENT")
        fail(
          503,
          "Could not remove a saved file. Please retry deletion.",
          "media_delete_failed",
        );
    }
    db.prepare("DELETE FROM media WHERE id=?").run(m.id);
  }
  // Record each item's share of a settled charge.
  function assignCosts(ids, charged, user) {
    const costs = splitCharge(charged, ids.length);
    ids.forEach((id, index) =>
      db
        .prepare("UPDATE media SET cost=? WHERE id=? AND user_id=?")
        .run(costs[index], id, user),
    );
    return costs;
  }
  return { mediaJSON, signMedia, saveMedia, deleteMedia, assignCosts };
}
