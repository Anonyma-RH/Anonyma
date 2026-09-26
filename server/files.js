import { inflateRawSync } from "node:zlib";
import { now, uid, fail, transaction, hash } from "./core.js";
import { isReleased } from "./releases.js";
import { filesRateLimit } from "./api-boost.js";
import {
  extractOffice,
  FILE_LIMIT,
  textBytes,
  OFFICE_EXTENSIONS,
} from "../src/file-formats.js";
import {
  buildDocumentBlock,
  DOCUMENT_KINDS,
  extensionOf,
} from "../src/documents.js";

const MAX_FILES = 50,
  TOTAL_BYTES = 50 * 1024 * 1024,
  MAX_SECONDS = 30 * 86400;
const audioTypes = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  webm: "audio/webm",
  m4a: "audio/mp4",
};
export function audioType(bytes, extension) {
  const head = Buffer.from(bytes.subarray(0, 16));
  const good = {
    wav:
      head.toString("ascii", 0, 4) === "RIFF" &&
      head.toString("ascii", 8, 12) === "WAVE",
    mp3:
      head.toString("ascii", 0, 3) === "ID3" ||
      (head[0] === 255 && (head[1] & 0xe0) === 0xe0),
    flac: head.toString("ascii", 0, 4) === "fLaC",
    ogg: head.toString("ascii", 0, 4) === "OggS",
    webm: head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    m4a: head.toString("ascii", 4, 8) === "ftyp",
  };
  return good[extension] ? audioTypes[extension] : null;
}
export async function inspectFile(name, bytes) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 180 ||
    /[\/\\\x00-\x1f\x7f]/.test(name)
  )
    fail(400, "Use a filename of 1–180 characters without paths.");
  if (!bytes.length || bytes.length > FILE_LIMIT)
    fail(400, "Files must be non-empty and at most 10 MB.");
  const extension = extensionOf(name).slice(1);
  try {
    if (OFFICE_EXTENSIONS.includes(extension))
      return {
        kind: "document",
        mime: "application/octet-stream",
        ...(await extractOffice(bytes, extension, (packed, length) =>
          inflateRawSync(packed, { maxOutputLength: Math.max(1, length) }),
        )),
      };
    if (DOCUMENT_KINDS["." + extension] === "text") {
      const text = textBytes(bytes);
      return {
        kind: "document",
        mime: "text/plain; charset=utf-8",
        text: text.slice(0, 100000),
        truncated: text.length > 100000,
      };
    }
    if (audioTypes[extension]) {
      const mime = audioType(bytes, extension);
      if (!mime) fail(400, "The audio contents do not match its filename.");
      return { kind: "audio", mime, text: null, truncated: false };
    }
  } catch (e) {
    if (e.status) throw e;
    fail(400, e.message || "The document could not be extracted.");
  }
  fail(
    400,
    "Reusable uploads support UTF-8 text/code, DOCX, XLSX, PPTX, WAV, MP3, FLAC, OGG, WebM and M4A. PDF remains a local chat attachment; legacy/macro Office files are unsupported.",
  );
}
// A bounded single-file multipart reader, rejecting duplicate/unknown fields.
// Buffers only the capped request. Filenames never become filesystem paths.
export async function fileMultipart(req) {
  const match =
    /^multipart\/form-data;\s*boundary=(?:"([a-zA-Z0-9'()+_,./:=?-]{1,70})"|([a-zA-Z0-9'()+_,./:=?-]{1,70}))$/i.exec(
      req.headers["content-type"] || "",
    );
  if (!match)
    fail(415, "Use multipart/form-data with one file and purpose=user_data.");
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > FILE_LIMIT + 16384) fail(413, "The upload exceeds 10 MB.");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks),
    boundary = Buffer.from("--" + (match[1] || match[2])),
    delimiter = Buffer.concat([Buffer.from("\r\n"), boundary]);
  const fields = Object.create(null);
  let file = null,
    at = 0,
    parts = 0;
  if (!body.subarray(0, boundary.length).equals(boundary))
    fail(400, "Malformed multipart body.");
  at = boundary.length;
  while (at < body.length) {
    if (body.subarray(at, at + 2).toString() === "--") {
      at += 2;
      if (body.subarray(at).toString() !== "\r\n" && at !== body.length)
        fail(400, "Unexpected multipart trailing content.");
      return { fields, file };
    }
    if (++parts > 4 || body.subarray(at, at + 2).toString() !== "\r\n")
      fail(400, "Malformed multipart body.");
    at += 2;
    const end = body.indexOf("\r\n\r\n", at);
    if (end < 0 || end - at > 4096) fail(400, "Invalid multipart headers.");
    const header = body.subarray(at, end).toString("latin1");
    const lines = header.split("\r\n");
    if (
      lines.length > 2 ||
      lines.filter((l) => /^content-disposition:/i.test(l)).length !== 1 ||
      lines.filter((l) => /^content-type:/i.test(l)).length > 1 ||
      lines.some((l) => !/^content-(disposition|type):/i.test(l))
    )
      fail(400, "Unsupported multipart headers.");
    const disposition =
      /^content-disposition: form-data; name="([^"\r\n]+)"(?:; filename="([^"\r\n]*)")?\s*$/im.exec(
        header,
      );
    if (!disposition) fail(400, "Malformed multipart disposition.");
    let next = body.indexOf(delimiter, end + 4);
    while (
      next >= 0 &&
      !["\r\n", "--"].includes(
        body
          .subarray(next + delimiter.length, next + delimiter.length + 2)
          .toString(),
      )
    )
      next = body.indexOf(delimiter, next + 1);
    if (next < 0) fail(400, "Missing multipart closing boundary.");
    const name = disposition[1],
      bytes = body.subarray(end + 4, next);
    if (name === "file" && disposition[2] !== undefined) {
      if (file) fail(400, "Send exactly one file.");
      file = { name: disposition[2], bytes };
    } else {
      if (
        disposition[2] !== undefined ||
        ![
          "purpose",
          "expires_after[anchor]",
          "expires_after[seconds]",
        ].includes(name) ||
        Object.hasOwn(fields, name) ||
        bytes.length > 100
      )
        fail(400, "Unsupported or duplicate multipart field.");
      fields[name] = bytes.toString("utf8");
    }
    at = next + delimiter.length;
  }
  fail(400, "Incomplete multipart body.");
}
export function fileRoutes(ctx) {
  const { app, db, cfg, requireUser, apiAuth, limit } = ctx;
  const cleanup = () =>
    db.prepare("DELETE FROM uploads WHERE expires<=?").run(now());
  const metadata = (row) => ({
    id: row.id,
    object: "file",
    bytes: row.bytes,
    created_at: Math.floor(row.created / 1000),
    filename: row.name,
    purpose: "user_data",
    expires_at: Math.floor(row.expires / 1000),
    status: "processed",
    anonyma: {
      kind: row.kind,
      characters: row.characters ?? row.text?.length ?? 0,
      truncated: !!row.truncated,
      transcribed: false,
    },
  });
  const columns =
    "id,user_id,name,bytes,kind,mime,text,truncated,created,expires";
  const owned = (id, user, content = false) => {
    const row = db
      .prepare(
        "SELECT " +
          columns +
          (content ? ",content" : "") +
          " FROM uploads WHERE id=? AND user_id=? AND expires>?",
      )
      .get(id, user, now());
    if (!row) fail(404, "File not found.");
    return row;
  };
  function policy(req) {
    if (
      req.body?.private === true ||
      req.body?.ephemeral === true ||
      req.body?.veil === true ||
      req.privateOnly === true
    )
      fail(
        400,
        "Saved uploads are unavailable in Private, off-the-record or Veil contexts. Attach locally instead.",
      );
    const key = req.apiKey;
    if (
      key &&
      (key.connection_id ||
        key.paused_at ||
        (key.allowance_expires != null && key.allowance_expires <= now()))
    )
      fail(
        403,
        "This key cannot access saved files. Use an active personal API key.",
      );
  }
  async function store(req, name, bytes, seconds) {
    policy(req);
    cleanup();
    if (!Number.isInteger(seconds) || seconds < 3600 || seconds > MAX_SECONDS)
      fail(400, "File retention must be between one hour and 30 days.");
    const parsed = await inspectFile(name, bytes);
    const row = {
      id: uid("file-"),
      user_id: req.user.id,
      name,
      bytes: bytes.length,
      kind: parsed.kind,
      mime: parsed.mime,
      text: parsed.text,
      truncated: parsed.truncated ? 1 : 0,
      created: now(),
      expires: now() + seconds * 1000,
    };
    // Authentication may change while multipart input/extraction is awaiting.
    // Recheck immediately before the synchronous quota check and insertion.
    transaction(db, () => {
      const currentUser = db
        .prepare("SELECT id FROM users WHERE id=? AND deleted IS NULL")
        .get(req.user.id);
      if (!currentUser) fail(401, "Account is unavailable.");
      if (req.apiKey) {
        const currentKey = db
          .prepare(
            "SELECT * FROM api_keys WHERE id=? AND user_id=? AND revoked IS NULL",
          )
          .get(req.apiKey.id, req.user.id);
        if (!currentKey)
          fail(401, "The API key is no longer active.", "invalid_api_key");
        req.apiKey = currentKey;
      } else {
        const activeSession = db
          .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires>?")
          .get(hash(req.cookies?.anonyma_session || ""), now());
        if (activeSession?.user_id !== req.user.id)
          fail(
            401,
            "Sign in again to save this file.",
            "authentication_required",
          );
      }
      policy(req);
      const usage = db
        .prepare(
          "SELECT count(*) n,coalesce(sum(bytes),0) bytes FROM uploads WHERE user_id=?",
        )
        .get(req.user.id);
      if (usage.n >= MAX_FILES || usage.bytes + bytes.length > TOTAL_BYTES)
        fail(
          400,
          "Saved files are limited to 50 files and 50 MB. Delete an older upload first.",
        );
      db.prepare(
        "INSERT INTO uploads(id,user_id,name,bytes,kind,mime,text,truncated,created,expires,content) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        row.id,
        row.user_id,
        row.name,
        row.bytes,
        row.kind,
        row.mime,
        row.text,
        row.truncated,
        row.created,
        row.expires,
        bytes,
      );
    });
    return metadata(row);
  }
  const guard = [requireUser, limit("files", 60, 60000)];
  const apiGuard = [
    apiAuth,
    // 60 a minute per account, raised by NYMA tier once API Boost is live.
    filesRateLimit(ctx),
    (req, res, next) => {
      policy(req);
      next();
    },
  ];
  function list(req, res) {
    cleanup();
    const take = Number(req.query.limit || 20),
      order = req.query.order || "desc",
      after = req.query.after;
    if (
      !Number.isInteger(take) ||
      take < 1 ||
      take > 50 ||
      !["asc", "desc"].includes(order) ||
      (req.query.purpose && req.query.purpose !== "user_data")
    )
      fail(400, "Use limit 1–50, order asc/desc and purpose=user_data.");
    let anchor = null;
    if (after) anchor = owned(String(after), req.user.id);
    const op = order === "asc" ? ">" : "<";
    const rows = db
      .prepare(
        `SELECT id,name,bytes,kind,mime,length(text) characters,truncated,created,expires FROM uploads WHERE user_id=? AND expires>? ${anchor ? `AND (created ${op} ? OR (created=? AND id ${op} ?))` : ""} ORDER BY created ${order},id ${order} LIMIT ?`,
      )
      .all(
        req.user.id,
        now(),
        ...(anchor ? [anchor.created, anchor.created, anchor.id] : []),
        take + 1,
      );
    const data = rows.slice(0, take).map(metadata);
    res.json({
      object: "list",
      data,
      first_id: data[0]?.id || null,
      last_id: data.at(-1)?.id || null,
      has_more: rows.length > take,
    });
  }
  for (const [prefix, guards] of [
    ["/api/files", guard],
    ["/v1/files", apiGuard],
  ]) {
    app.get(prefix, ...guards, list);
    app.get(prefix + "/:id", ...guards, (req, res) =>
      res.json(metadata(owned(req.params.id, req.user.id))),
    );
    app.get(prefix + "/:id/content", ...guards, (req, res) => {
      const row = owned(req.params.id, req.user.id, true);
      res
        .set({
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
          "X-Content-Type-Options": "nosniff",
        })
        .send(Buffer.from(row.content));
    });
    app.delete(prefix + "/:id", ...guards, (req, res) => {
      const row = owned(req.params.id, req.user.id);
      db.prepare("DELETE FROM uploads WHERE id=?").run(row.id);
      res.json({ id: row.id, object: "file", deleted: true });
    });
  }
  app.get("/api/files/:id/text", ...guard, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    if (row.kind !== "document")
      fail(
        400,
        "Audio needs an explicit transcription request before it can be attached as text.",
      );
    res.json({
      name: row.name,
      text: row.text,
      chars: row.text.length,
      truncated: !!row.truncated,
    });
  });
  app.post("/api/files", ...guard, async (req, res) => {
    if (req.body.consent !== true)
      fail(400, "Confirm saving the original file to your account for reuse.");
    const value = req.body.data;
    if (
      typeof value !== "string" ||
      value.length > Math.ceil(FILE_LIMIT / 3) * 4 ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    )
      fail(400, "Send valid base64 file bytes.");
    res
      .status(201)
      .json(
        await store(
          req,
          req.body.filename,
          Buffer.from(value, "base64"),
          req.body.retention_seconds ?? 7 * 86400,
        ),
      );
  });
  app.post("/v1/files", ...apiGuard, async (req, res) => {
    const { file, fields } = await fileMultipart(req);
    if (!file || fields.purpose !== "user_data")
      fail(
        400,
        "Send one file and purpose=user_data. Other purposes are not supported.",
      );
    if (
      fields["expires_after[anchor]"] &&
      fields["expires_after[anchor]"] !== "created_at"
    )
      fail(400, "expires_after anchor must be created_at.");
    res
      .status(200)
      .json(
        await store(
          req,
          file.name,
          file.bytes,
          fields["expires_after[seconds]"] === undefined
            ? 7 * 86400
            : Number(fields["expires_after[seconds]"]),
        ),
      );
  });
  function expandMessages(req, messages) {
    if (!Array.isArray(messages)) return messages;
    let used = 0;
    return messages.map((m) => {
      if (!Array.isArray(m?.content)) return m;
      const hasFile = m.content.some((part) => part?.type === "file");
      const content = m.content.map((part) => {
        if (part?.type !== "file") return part;
        if (!isReleased(cfg, "files"))
          fail(
            403,
            "Files & Reusable Uploads is not available.",
            "feature_unreleased",
          );
        policy(req);
        if (
          m.role !== "user" ||
          ++used > 5 ||
          typeof part.file?.file_id !== "string" ||
          Object.keys(part.file).some((k) => k !== "file_id")
        )
          fail(400, "Use up to five user file parts containing only file_id.");
        const row = owned(part.file.file_id, req.user.id);
        if (row.kind !== "document")
          fail(400, "Audio files must be explicitly transcribed first.");
        return {
          type: "text",
          text: buildDocumentBlock({
            name: row.name,
            text: row.text,
            truncated: row.truncated,
          }),
        };
      });
      // The existing API contract accepts text-only messages. File parts are
      // expanded to bounded text, not a new promise of general multimodality.
      if (req.apiKey && hasFile) {
        if (
          content.some((p) => p?.type !== "text" || typeof p.text !== "string")
        )
          fail(400, "API file messages support text and file_id parts only.");
        return { ...m, content: content.map((p) => p.text).join("\n\n") };
      }
      return { ...m, content };
    });
  }
  return { cleanup, expandMessages };
}
