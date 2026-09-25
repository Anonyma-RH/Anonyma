import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import JSZip from "jszip";
import { inflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { MIGRATIONS, balance, migrate, now, rollbackSchema } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import {
  extractOffice,
  zipEntries,
  parseOfficeXML,
  browserInflate,
  FILE_LIMIT,
} from "../src/file-formats.js";
import { inspectFile } from "../server/files.js";
import { openapiForConfig } from "../server/openapi.js";
const mime = {
  docx: "wordprocessingml.document.main+xml",
  xlsx: "spreadsheetml.sheet.main+xml",
  pptx: "presentationml.presentation.main+xml",
};
async function office(ext, parts = {}, compression = "DEFLATE") {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types><Override ContentType="application/vnd.openxmlformats-officedocument.${mime[ext]}"/></Types>`,
  );
  for (const [name, text] of Object.entries(parts)) zip.file(name, text);
  return zip.generateAsync({
    type: "nodebuffer",
    compression,
    compressionOptions: { level: 6 },
  });
}
const inflate = (b, n) =>
  inflateRawSync(b, { maxOutputLength: Math.max(1, n) });
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-files-"));
  const svc = createApp({
    testMode: true,
    released: "all",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function person(app, name = "file_user") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  const key = (
    await agent.post("/api/keys").send({ name: "files" }).expect(201)
  ).body;
  return { agent, user: r.body.user, key };
}
const save = (
  agent,
  filename = "notes.txt",
  bytes = Buffer.from("A reusable Greek archive."),
  extra = {},
) =>
  agent.post("/api/files").send({
    filename,
    data: bytes.toString("base64"),
    consent: true,
    ...extra,
  });
const auth = (r, key) => r.set("Authorization", "Bearer " + key.key);

test("Office extracts DOCX paragraphs, PPTX slides and XLSX stored values without executing formulas", async () => {
  const doc = await office("docx", {
    "word/document.xml":
      '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>',
  });
  assert.equal(
    (await extractOffice(doc, "docx", inflate)).text,
    "Hello & welcome\nSecond paragraph",
  );
  assert.equal(
    (await extractOffice(doc, "docx", browserInflate)).text,
    "Hello & welcome\nSecond paragraph",
  );
  const slides = await office("pptx", {
    "ppt/slides/slide2.xml":
      "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml":
      "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
  });
  assert.equal(
    (await extractOffice(slides, "pptx", inflate)).text,
    "Slide 1\nFirst\nSlide 2\nSecond",
  );
  const sheet = await office("xlsx", {
    "xl/sharedStrings.xml": "<sst><si><t>Sales</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>HYPERLINK("https://example.invalid")</f><v>42</v></c></row></sheetData></worksheet>',
  });
  const result = await extractOffice(sheet, "xlsx", inflate);
  assert.match(result.text, /A1: Sales\tB1: 42/);
  assert.doesNotMatch(result.text, /HYPERLINK|https:/);
});
test("Office rejects unsafe archives, XML entities, deep nesting, macro objects and mismatched contents", async () => {
  assert.throws(() => zipEntries(Buffer.from("not a ZIP")), /Office|ZIP/);
  const normal = await office("docx", {
    "word/document.xml": "<document><p><t>Hello</t></p></document>",
  });
  await assert.rejects(extractOffice(normal, "xlsx", inflate), /match/);
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
    "<x><y></x>",
    "<x>" + "<y>".repeat(65) + "</y>".repeat(65) + "</x>",
    "<x>&unknown;</x>",
  ])
    assert.throws(() => parseOfficeXML(xml), /XML|entit|nesting/);
  const macro = await office("docx", {
    "word/document.xml": "<x/>",
    "word/vbaProject.bin": "do not execute",
  });
  await assert.rejects(extractOffice(macro, "docx", inflate), /Macros/);
  const traversal = await office("docx", {
    "word/document.xml": "<x/>",
    "../escape.xml": "<x/>",
  });
  assert.throws(() => zipEntries(traversal), /Unsafe/);
  const bomb = await office("docx", {
    "word/document.xml": "<x>" + "A".repeat(2 * 1024 * 1024) + "</x>",
  });
  await assert.rejects(extractOffice(bomb, "docx", inflate), /safe extraction/);
  const corrupt = Buffer.from(normal);
  const entries = zipEntries(normal),
    target = entries.get("word/document.xml");
  const offset = target.bytes.byteOffset - normal.byteOffset;
  corrupt[offset] ^= 1;
  await assert.rejects(extractOffice(corrupt, "docx", inflate));
});
test("Malformed and oversized files never enter storage; valid audio only validates container signature", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app);
  for (const [name, bytes] of [
    ["evil.txt", Buffer.from([0, 1, 2])],
    ["clip.wav", Buffer.from("not wav")],
    ["legacy.doc", Buffer.from("legacy")],
    ["../notes.txt", Buffer.from("unsafe")],
    ["m.xlsm", Buffer.from("zip")],
    ["bad.docx", Buffer.from("PK")],
  ])
    await save(agent, name, bytes).expect(400);
  await save(agent, "empty.txt", Buffer.alloc(0)).expect(400);
  await save(agent, "too-big.txt", Buffer.alloc(FILE_LIMIT + 1, 65)).expect(
    400,
  );
  await agent
    .post("/api/files")
    .send({ filename: "bad.txt", data: "Y===", consent: true })
    .expect(400);
  assert.equal(s.db.prepare("SELECT count(*) n FROM uploads").get().n, 0);
  const wav = Buffer.alloc(44);
  wav.write("RIFF");
  wav.write("WAVE", 8);
  assert.equal((await inspectFile("sound.wav", wav)).kind, "audio");
});
test("Saved file consent, private restrictions, ownership, pagination, content and delete", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app),
    other = await person(s.app, "other_file_user");
  await request(s.app).get("/api/files").expect(401);
  await agent
    .post("/api/files")
    .send({ filename: "x.txt", data: "eA==" })
    .expect(400);
  for (const field of ["private", "ephemeral", "veil"])
    await save(agent, "x.txt", Buffer.from("x"), { [field]: true }).expect(400);
  const before = balance(s.db, user.id),
    a = (await save(agent).expect(201)).body,
    b = (await save(agent, "two.txt", Buffer.from("two")).expect(201)).body;
  assert.deepEqual(balance(s.db, user.id), before);
  assert.equal(a.purpose, "user_data");
  assert.equal(a.bytes, 25);
  const list = (await agent.get("/api/files?limit=1&order=asc").expect(200))
    .body;
  assert.equal(list.data.length, 1);
  assert.equal(list.has_more, true);
  const next = (
    await agent
      .get("/api/files?limit=1&order=asc&after=" + list.last_id)
      .expect(200)
  ).body;
  assert.equal(next.data.length, 1);
  assert.notEqual(next.data[0].id, list.data[0].id);
  for (const path of ["", "/content", "/text"])
    await other.agent.get("/api/files/" + a.id + path).expect(404);
  await other.agent.delete("/api/files/" + a.id).expect(404);
  const raw = await agent.get("/api/files/" + a.id + "/content").expect(200);
  assert.equal(raw.body.toString(), "A reusable Greek archive.");
  assert.match(raw.headers["content-disposition"], /^attachment/);
  assert.equal(
    (await agent.get("/api/files/" + a.id + "/text")).body.text,
    "A reusable Greek archive.",
  );
  await agent.delete("/api/files/" + a.id).expect(200);
  await agent.get("/api/files/" + a.id).expect(404);
  assert.equal((await agent.get("/api/files")).body.data[0].id, b.id);
});
test("Expiration is enforced immediately and cleanup/account delete remove stored bytes", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  await save(agent, "x.txt", Buffer.from("x"), {
    retention_seconds: 3599,
  }).expect(400);
  await save(agent, "x.txt", Buffer.from("x"), {
    retention_seconds: 30 * 86400 + 1,
  }).expect(400);
  const f = (await save(agent).expect(201)).body;
  s.db.prepare("UPDATE uploads SET expires=? WHERE id=?").run(now() - 1, f.id);
  await agent.get("/api/files/" + f.id + "/content").expect(404);
  await agent.get("/api/files").expect(200);
  assert.equal(s.db.prepare("SELECT count(*) n FROM uploads").get().n, 0);
  await save(agent).expect(201);
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.uploads.length, 1);
  await agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(
    s.db.prepare("SELECT count(*) n FROM uploads WHERE user_id=?").get(user.id)
      .n,
    0,
  );
});
test("Compatible /v1/files accepts only supported multipart purpose and personal active keys", async (t) => {
  const s = fixture(t);
  const { agent, key } = await person(s.app);
  await request(s.app).get("/v1/files").expect(401);
  await auth(request(s.app).post("/v1/files"), key)
    .field("purpose", "fine-tune")
    .attach("file", Buffer.from("x"), "x.txt")
    .expect(400);
  await auth(request(s.app).post("/v1/files"), key)
    .field("purpose", "user_data")
    .field("purpose", "user_data")
    .attach("file", Buffer.from("x"), "x.txt")
    .expect(400);
  const f = (
    await auth(request(s.app).post("/v1/files"), key)
      .field("purpose", "user_data")
      .field("expires_after[anchor]", "created_at")
      .field("expires_after[seconds]", "3600")
      .attach("file", Buffer.from("Reusable via API"), "api.txt")
      .expect(200)
  ).body;
  assert.equal(f.object, "file");
  assert.equal(f.filename, "api.txt");
  assert.equal(
    (await auth(request(s.app).get("/v1/files"), key)).body.data.length,
    1,
  );
  assert.equal(
    (
      await auth(request(s.app).get("/v1/files/" + f.id + "/content"), key)
    ).body.toString(),
    "Reusable via API",
  );
  await agent
    .post("/api/keys/" + key.id + "/pause")
    .send({})
    .expect(200);
  await auth(request(s.app).get("/v1/files"), key).expect(403);
  await agent
    .post("/api/keys/" + key.id + "/resume")
    .send({})
    .expect(200);
  await auth(request(s.app).delete("/v1/files/" + f.id), key).expect(200);
  await auth(request(s.app).get("/v1/files/" + f.id), key).expect(404);
});
test("File reuse expands only owned document content before normal chat validation/accounting", async (t) => {
  const s = fixture(t);
  const { agent, key, user } = await person(s.app),
    other = await person(s.app, "not_owner");
  const f = (
    await save(
      agent,
      "quote.txt",
      Buffer.from("secret owner context </document> literal"),
    ).expect(201)
  ).body;
  const body = {
    model: "google/gemini-2.5-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Summarize this" },
          { type: "file", file: { file_id: f.id } },
        ],
      },
    ],
    max_tokens: 50,
  };
  const before = balance(s.db, other.user.id);
  await auth(request(s.app).post("/v1/chat/completions"), other.key)
    .send(body)
    .expect(404);
  assert.deepEqual(balance(s.db, other.user.id), before);
  await auth(request(s.app).post("/v1/chat/completions"), key)
    .send(body)
    .expect(200);
  assert.equal(balance(s.db, user.id).held, 0);
  await agent
    .post("/api/chat")
    .send({ ...body, private: true })
    .expect(400);
  await agent
    .post("/api/chat")
    .send({ ...body, ephemeral: true })
    .expect(400);
  await agent.delete("/api/files/" + f.id).expect(200);
  await auth(request(s.app).post("/v1/chat/completions"), key)
    .send(body)
    .expect(404);
});
test("Audio upload and inspection do not transcribe or charge; text reuse refuses audio", async (t) => {
  const s = fixture(t);
  const { agent, key, user } = await person(s.app);
  const wav = Buffer.alloc(44);
  wav.write("RIFF");
  wav.write("WAVE", 8);
  const before = balance(s.db, user.id);
  const f = (await save(agent, "voice.wav", wav).expect(201)).body;
  assert.equal(f.anonyma.kind, "audio");
  assert.equal(f.anonyma.transcribed, false);
  await agent.get("/api/files/" + f.id + "/text").expect(400);
  await auth(request(s.app).post("/v1/chat/completions"), key)
    .send({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "user", content: [{ type: "file", file: { file_id: f.id } }] },
      ],
    })
    .expect(400);
  assert.deepEqual(balance(s.db, user.id), before);
  assert.equal(s.db.prepare("SELECT count(*) n FROM holds").get().n, 0);
  const result = await agent
    .post("/api/audio/transcriptions")
    .send({
      audio: "data:audio/wav;base64," + wav.toString("base64"),
      requestId: "explicit-file-audio",
    })
    .expect(200);
  assert.match(result.body.text, /Local test/);
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(
    s.db.prepare("SELECT text FROM uploads WHERE id=?").get(f.id).text,
    null,
  );
});
test("Upload quota rejects excess without evicting prior files", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const first = (await save(agent).expect(201)).body;
  const stmt = s.db.prepare(
    "INSERT INTO uploads SELECT ?,user_id,name,bytes,kind,mime,text,truncated,created,expires,content FROM uploads WHERE id=?",
  );
  for (let i = 1; i < 50; i++) stmt.run("file-fixture-" + i, first.id);
  await save(agent, "one-more.txt").expect(400);
  assert.equal(
    s.db.prepare("SELECT count(*) n FROM uploads WHERE user_id=?").get(user.id)
      .n,
    50,
  );
  await agent.get("/api/files/" + first.id).expect(200);
});
test("Files gate blocks routes and file parts while disabled; OpenAPI describes supported subset only", async (t) => {
  const gate = UPDATES.find((u) => u.id === "files"),
    old = gate.released;
  gate.released = false;
  t.after(() => (gate.released = old));
  const s = fixture(t, { released: "mvp,api,documents" });
  await request(s.app).get("/api/files").expect(403);
  await request(s.app).post("/v1/files").expect(403);
  const schema = openapiForConfig({ released: "all" });
  assert.ok(schema.paths["/v1/files"]);
  assert.ok(!openapiForConfig({ released: "mvp,api" }).paths["/v1/files"]);
});

test("Archive size lies, duplicate paths and malformed multipart are rejected within bounds", async (t) => {
  const original = await office(
    "docx",
    { "word/document.xml": "<x><p><t>small text</t></p></x>" },
    "STORE",
  );
  const lying = Buffer.from(original);
  let central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (central >= 0) {
    if (
      lying
        .subarray(central + 46, central + 46 + lying.readUInt16LE(central + 28))
        .toString() === "word/document.xml"
    ) {
      lying.writeUInt32LE(1, central + 24);
      break;
    }
    central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), central + 1);
  }
  await assert.rejects(
    extractOffice(lying, "docx", inflate),
    /Inconsistent|checksum|size/,
  );
  // Both local and central uncompressed lengths lie: actual inflation is
  // still capped rather than trusting the metadata.
  const deflated = await office("docx", {
    "word/document.xml": "<x><p><t>bounded actual expansion</t></p></x>",
  });
  let offset = deflated.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (offset >= 0) {
    const name = deflated
      .subarray(offset + 46, offset + 46 + deflated.readUInt16LE(offset + 28))
      .toString();
    if (name === "word/document.xml") {
      deflated.writeUInt32LE(1, offset + 24);
      deflated.writeUInt32LE(1, deflated.readUInt32LE(offset + 42) + 22);
      break;
    }
    offset = deflated.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      offset + 1,
    );
  }
  await assert.rejects(extractOffice(deflated, "docx", inflate));
  await assert.rejects(
    extractOffice(deflated, "docx", browserInflate),
    /safe limit/,
  );
  const duplicate = await office("docx", { "a.xml": "<x/>", "b.xml": "<x/>" });
  for (
    let p = duplicate.indexOf("b.xml");
    p >= 0;
    p = duplicate.indexOf("b.xml", p + 1)
  )
    duplicate.write("a.xml", p);
  assert.throws(() => zipEntries(duplicate), /duplicate/);
  assert.throws(
    () => parseOfficeXML("<x " + " ".repeat(100000) + "bad>"),
    /XML/,
  );
  const entries = {};
  for (let i = 0; i < 260; i++) entries["word/x" + i + ".xml"] = "<x/>";
  const tooMany = await office("docx", entries);
  assert.throws(() => zipEntries(tooMany), /entry limit/);
  const s = fixture(t);
  const { key } = await person(s.app);
  const raw =
    '--x\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n--x\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello';
  await auth(request(s.app).post("/v1/files"), key)
    .set("Content-Type", "multipart/form-data; boundary=x")
    .send(raw)
    .expect(400);
  await auth(request(s.app).post("/v1/files"), key)
    .field("purpose", "user_data")
    .attach("file", Buffer.from("one"), "one.txt")
    .attach("file", Buffer.from("two"), "two.txt")
    .expect(400);
  assert.equal(s.db.prepare("SELECT count(*) n FROM uploads").get().n, 0);
});

test("Office shared strings reuse preserves ordinary text and caps accumulated output", async () => {
  const shared = "A Greek archive record. ".repeat(125);
  const workbook = await office(
    "xlsx",
    {
      "xl/sharedStrings.xml": `<sst><si><t>${shared}</t></si><si><r><t>Final </t></r><r><t>entry</t></r></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${Array.from({ length: 40 }, (_, i) => `<row r="${i + 1}"><c t="s"><v>0</v></c></row>`).join("")}<row><c t="s"><v>1</v></c></row></sheetData></worksheet>`,
    },
    "STORE",
  );
  const result = await extractOffice(workbook, "xlsx", inflate);
  assert.equal(result.text.length, 100000);
  assert.equal(result.truncated, true);
  assert.ok(
    result.text.startsWith(
      "Worksheet 1 (stored values; formulas are not evaluated)\ncell: " +
        shared,
    ),
  );
  const small = await office("xlsx", {
    "xl/sharedStrings.xml":
      "<sst><si><r><t>Greek </t></r><r><t>archive</t></r></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row></sheetData></worksheet>',
  });
  const normal = await extractOffice(small, "xlsx", inflate);
  assert.equal(
    normal.text,
    "Worksheet 1 (stored values; formulas are not evaluated)\ncell: Greek archive\tcell: Greek archive",
  );
  assert.equal(normal.truncated, false);
});

test("File quotes match expanded content and refuse other-owner and private reuse without charges", async (t) => {
  const { buildDocumentBlock } = await import("../src/documents.js");
  const s = fixture(t);
  const owner = await person(s.app),
    other = await person(s.app, "quote_other");
  const text = "Archive facts and supporting notes. ".repeat(120);
  const file = (
    await save(owner.agent, "quote.txt", Buffer.from(text)).expect(201)
  ).body;
  const body = {
    model: "google/gemini-2.5-flash",
    max_tokens: 500,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Review" },
          { type: "file", file: { file_id: file.id } },
        ],
      },
    ],
  };
  const before = balance(s.db, owner.user.id);
  const quoted = (await owner.agent.post("/api/quote").send(body).expect(200))
    .body;
  const expanded = structuredClone(body);
  expanded.messages[0].content[1] = {
    type: "text",
    text: buildDocumentBlock({ name: "quote.txt", text, truncated: false }),
  };
  assert.deepEqual(
    quoted,
    (await owner.agent.post("/api/quote").send(expanded).expect(200)).body,
  );
  const bare = (
    await owner.agent
      .post("/api/quote")
      .send({ ...body, messages: [{ role: "user", content: "Review" }] })
      .expect(200)
  ).body;
  assert.notDeepEqual(quoted, bare);
  await other.agent.post("/api/quote").send(body).expect(404);
  for (const flag of ["private", "ephemeral", "veil"])
    await owner.agent
      .post("/api/quote")
      .send({ ...body, [flag]: true })
      .expect(400);
  assert.deepEqual(balance(s.db, owner.user.id), before);
});

test("An in-flight multipart upload rechecks current authorization before storage", async (t) => {
  const { request: httpRequest } = await import("node:http");
  const { setTimeout: delay } = await import("node:timers/promises");
  const s = fixture(t),
    { user, key } = await person(s.app);
  const server = s.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    for (const change of ["paused", "expired", "revoked", "deleted"]) {
      s.db
        .prepare(
          "UPDATE api_keys SET paused_at=NULL, allowance_expires=NULL, revoked=NULL, last_used=NULL WHERE id=?",
        )
        .run(key.id);
      const pending = httpRequest({
        host: "127.0.0.1",
        port: server.address().port,
        path: "/v1/files",
        method: "POST",
        headers: {
          Authorization: "Bearer " + key.key,
          "Content-Type": "multipart/form-data; boundary=local-upload",
        },
      });
      const response = new Promise((resolve, reject) => {
        pending.on("error", reject);
        pending.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
      });
      pending.write(
        '--local-upload\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n--local-upload\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\n\r\nA local archive',
      );
      const deadline = Date.now() + 2000;
      while (
        !s.db.prepare("SELECT last_used FROM api_keys WHERE id=?").get(key.id)
          .last_used &&
        Date.now() < deadline
      )
        await delay(5);
      assert.ok(
        s.db.prepare("SELECT last_used FROM api_keys WHERE id=?").get(key.id)
          .last_used,
        "request passed initial authentication",
      );
      if (change === "deleted")
        s.db
          .prepare("UPDATE users SET deleted=? WHERE id=?")
          .run(now(), user.id);
      else
        s.db
          .prepare(
            `UPDATE api_keys SET ${{ paused: "paused_at", expired: "allowance_expires", revoked: "revoked" }[change]}=? WHERE id=?`,
          )
          .run(now() - 1, key.id);
      pending.end("\r\n--local-upload--\r\n");
      assert.equal(
        await response,
        ["paused", "expired"].includes(change) ? 403 : 401,
        change,
      );
      assert.equal(
        s.db.prepare("SELECT COUNT(*) n FROM uploads").get().n,
        0,
        change,
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Delayed upload work cannot revive after privacy changes or component replacement", async () => {
  const { createUploadActivity } = await import("../src/documents.js");
  const activity = createUploadActivity();
  activity.update(false, false);
  let finishRead,
    posts = 0,
    attachments = 0;
  const canAct = activity.capture();
  const completion = (async () => {
    await new Promise((resolve) => {
      finishRead = resolve;
    });
    if (!canAct()) return;
    posts++;
    attachments++;
  })();
  activity.update(true, false);
  activity.update(false, false);
  finishRead();
  await completion;
  assert.equal(posts, 0);
  assert.equal(attachments, 0);
  assert.equal(
    activity.capture()(),
    true,
    "a newly authorized action is available",
  );
  const beforeDisable = activity.capture();
  activity.update(false, true);
  activity.update(false, false);
  assert.equal(beforeDisable(), false);
  const beforeUnmount = activity.capture();
  activity.dispose();
  activity.mount();
  assert.equal(beforeUnmount(), false);
});

test("uploads append additive schema21 after Memory20; upgrading keeps Memory and History data", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  const has = (name) => !!db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name);
  // The released base: History is schema19 and Memory schema20.
  assert.ok(MIGRATIONS.length >= 21);
  for (let i = 0; i < 20; i++) {
    MIGRATIONS[i](db);
    db.exec(`PRAGMA user_version=${i + 1}`);
  }
  assert.ok(has("library_items") && has("memory_facts") && has("memory_settings"));
  assert.equal(has("uploads"), false);
  db.prepare("INSERT INTO users(id,created) VALUES('files_upgrade',0)").run();
  db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES('c_up','files_upgrade','Kept','chat',0,0)").run();
  db.prepare("INSERT INTO media(id,user_id,kind,mime,filename,prompt,model,cost,created,expires) VALUES('m_up','files_upgrade','image','image/png','m.png','p','x',0,0,NULL)").run();
  db.prepare("INSERT INTO library_items(media_id,source_id,had_source,recipe) VALUES('m_up','c_up',1,'{}')").run();
  db.prepare("INSERT INTO memory_facts(id,user_id,text,enabled,source_conversation_id,created,updated) VALUES('mem_up','files_upgrade','I prefer metric units.',1,'c_up',1,2)").run();
  db.prepare("INSERT INTO memory_settings(user_id,enabled,updated) VALUES('files_upgrade',1,3)").run();
  const kept = () => ({
    library: db.prepare("SELECT media_id,source_id,had_source,recipe FROM library_items").all().map((r) => ({ ...r })),
    facts: db.prepare("SELECT id,text,enabled,source_conversation_id,updated FROM memory_facts").all().map((r) => ({ ...r })),
    settings: db.prepare("SELECT user_id,enabled FROM memory_settings").all().map((r) => ({ ...r })),
  });
  const before = kept();
  // Schema21 itself adds the uploads table; later steps may follow it.
  MIGRATIONS[20](db);
  db.exec("PRAGMA user_version=21");
  assert.ok(has("uploads"));
  migrate(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.ok(db.prepare("SELECT version FROM schema_additive WHERE version=20").get());
  assert.ok(db.prepare("SELECT version FROM schema_additive WHERE version=21").get());
  assert.deepEqual(kept(), before);
  // An upload survives rolling back to Memory's schema and upgrading again.
  db.prepare("INSERT INTO uploads(id,user_id,name,bytes,kind,mime,text,truncated,created,expires,content) VALUES('up_1','files_upgrade','a.txt',1,'document','text/plain','a',0,0,?,?)").run(now() + 60_000, Buffer.from("a"));
  assert.deepEqual(rollbackSchema(db, 20), { from: MIGRATIONS.length, to: 20 });
  migrate(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM uploads").get().n, 1);
  assert.deepEqual(kept(), before);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
