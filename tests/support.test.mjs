import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { createApp } from "../server/app.js";
import { deliverSupport } from "../server/support.js";

test("support delivers signed-out and account requests, preserves failures, and retries safely", async (t) => {
  const messages = [];
  const recipients = [];
  let reject = false;
  const smtp = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 localhost ESMTP test\r\n");
    let buffer = "",
      data = false,
      lines = [];
    socket.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            messages.push(lines.join("\r\n"));
            data = false;
            lines = [];
            socket.write("250 queued\r\n");
          } else lines.push(line);
        } else if (/^(EHLO|HELO)/.test(line)) socket.write("250 localhost\r\n");
        else if (/^RCPT TO/.test(line)) {
          recipients.push(line);
          socket.write(reject ? "550 rejected\r\n" : "250 recipient ok\r\n");
        } else if (line === "DATA") {
          data = true;
          socket.write("354 end with dot\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "anonyma-support-"));
  const svc = createApp({
    testMode: false,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    smtp: `smtp://127.0.0.1:${smtp.address().port}`,
    smtpFrom: "Anonyma <sender@example.invalid>",
    supportEmail: "support@example.invalid",
  });
  t.after(async () => {
    svc.close();
    await new Promise((r) => smtp.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    (await request(svc.app).get("/api/config")).body.services.support,
    true,
  );
  const note = {
    subject: "Cannot log in",
    body: "Please help recover my account.",
    email: "visitor@example.invalid",
  };
  const sent = await request(svc.app)
    .post("/api/support")
    .send(note)
    .expect(201);
  assert.equal(sent.body.delivery, "accepted");
  assert.match(messages[0], /Reply-To: visitor@example.invalid/);
  assert.match(messages[0], /Please help recover my account/);
  assert.ok(
    recipients.every((line) => line === "RCPT TO:<support@example.invalid>"),
  );
  assert.equal(
    svc.db.prepare("SELECT user_id FROM tickets WHERE id=?").get(sent.body.id)
      .user_id,
    null,
  );
  await request(svc.app)
    .post("/api/support")
    .send({ ...note, email: "a@b.com\r\nBcc:other@example.invalid" })
    .expect(400);
  await request(svc.app)
    .post("/api/support")
    .set("Origin", "https://attacker.invalid")
    .send(note)
    .expect(403);
  reject = true;
  const failed = await request(svc.app)
    .post("/api/support")
    .send(note)
    .expect(202);
  assert.equal(failed.body.delivery, "failed");
  assert.equal(
    svc.db
      .prepare("SELECT delivery FROM tickets WHERE id=?")
      .get(failed.body.id).delivery,
    "failed",
  );
  reject = false;
  assert.equal(
    await deliverSupport(svc.db, svc.cfg, failed.body.id),
    "accepted",
  );
  assert.equal(
    await deliverSupport(svc.db, svc.cfg, failed.body.id),
    "accepted",
  );
  assert.equal(messages.length, 2);
  const agent = request.agent(svc.app);
  const registered = await agent
    .post("/api/auth/register")
    .send({ username: "support_user", password: "temporary-test-password" })
    .expect(201);
  const signedIn = await agent.post("/api/support").send(note).expect(201);
  assert.equal(
    svc.db
      .prepare("SELECT user_id FROM tickets WHERE id=?")
      .get(signedIn.body.id).user_id,
    registered.body.user.id,
  );
  await request(svc.app).post("/api/support").send(note).expect(201);
  await request(svc.app).post("/api/support").send(note).expect(201);
  await request(svc.app).post("/api/support").send(note).expect(429);
});

test("unconfigured support is unavailable and test mode never sends mail", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-support-off-"));
  const svc = createApp({
    testMode: false,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    smtp: "",
    smtpFrom: "",
    supportEmail: "",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const note = {
    subject: "Help",
    body: "Test",
    email: "visitor@example.invalid",
  };
  assert.equal(
    (await request(svc.app).get("/api/config")).body.services.support,
    false,
  );
  await request(svc.app).post("/api/support").send(note).expect(503);
  assert.equal(svc.db.prepare("SELECT count(*) n FROM tickets").get().n, 0);
  svc.cfg.testMode = true;
  svc.cfg.smtp = "smtp://127.0.0.1:1";
  svc.cfg.smtpFrom = "sender@example.invalid";
  svc.cfg.supportEmail = "support@example.invalid";
  const saved = await request(svc.app)
    .post("/api/support")
    .send(note)
    .expect(201);
  assert.equal(saved.body.delivery, "unavailable");
  assert.match(saved.body.message, /No email was sent/);
});
