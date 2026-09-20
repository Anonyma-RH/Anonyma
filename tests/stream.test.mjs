import test from "node:test";
import assert from "node:assert/strict";
import { readChatEvents } from "../src/stream.js";
function stream(text) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    }),
  );
}
test("chat streaming handles split UTF-8, CRLF, comments and terminal receipts", async () => {
  const parts = [];
  for await (const p of readChatEvents(
    stream(
      ':ping\r\n\r\ndata: {"text":"Hello 🌏"}\r\n\r\ndata: {"anonyma":{"credits_charged":1}}\r\n\r\ndata: [DONE]\r\n\r\n',
    ),
  ))
    parts.push(p);
  assert.equal(parts[0].text, "Hello 🌏");
  assert.equal(parts[1].anonyma.credits_charged, 1);
});
test("chat disconnect and malformed events are not reported as completed", async () => {
  async function consume(s) {
    for await (const p of readChatEvents(stream(s))) void p;
  }
  await assert.rejects(
    consume('data: {"text":"partial"}\n\n'),
    /before completion/,
  );
  await assert.rejects(consume("data: broken\n\n"), /could not be decoded/);
});
