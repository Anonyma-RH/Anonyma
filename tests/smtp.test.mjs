import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { createApp } from "../server/app.js";

test("live-mode email linking uses SMTP, hides the code from HTTP, and rejects failed delivery", async (t) => {
  const messages = [];
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
        else if (/^MAIL FROM/.test(line))
          socket.write(
            reject ? "550 sender rejected\r\n" : "250 sender ok\r\n",
          );
        else if (/^RCPT TO/.test(line)) socket.write("250 recipient ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 end with dot\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "anonyma-smtp-"));
  const svc = createApp({
    testMode: false,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    smtp: `smtp://127.0.0.1:${smtp.address().port}`,
    smtpFrom: "Anonyma <sender@example.invalid>",
  });
  t.after(async () => {
    svc.close();
    await new Promise((r) => smtp.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const agent = request.agent(svc.app);
  await agent
    .post("/api/auth/register")
    .send({ username: "smtp_user", password: "temporary-test-password" })
    .expect(201);
  const sent = (
    await agent
      .post("/api/auth/email/send")
      .send({ email: "recipient@example.invalid", purpose: "link" })
      .expect(200)
  ).body;
  assert.equal(sent.testCode, undefined);
  assert.equal(messages.length, 1);
  const code = messages[0].match(/Your code is (\d{6})/)[1];
  const verified = (
    await agent
      .post("/api/auth/email/verify")
      .send({ id: sent.id, code })
      .expect(200)
  ).body;
  assert.equal(verified.user.email, "recipient@example.invalid");
  reject = true;
  const failed = (
    await agent
      .post("/api/auth/email/send")
      .send({ email: "rejected@example.invalid" })
      .expect(503)
  ).body;
  assert.equal(failed.error.code, "email_unavailable");
  assert.equal(
    svc.db
      .prepare(
        "SELECT COUNT(*) n FROM challenges WHERE target='rejected@example.invalid'",
      )
      .get().n,
    0,
  );
});
