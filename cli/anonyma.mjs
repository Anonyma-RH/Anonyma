#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const dir = process.env.ANONYMA_CONFIG_DIR || join(homedir(), ".config", "anonyma"),
  file = join(dir, "config.json");
let saved = {};
try {
  saved = JSON.parse(readFileSync(file, "utf8"));
} catch {}
const args = process.argv.slice(2);
let base = (
  process.env.ANONYMA_BASE_URL ||
  saved.base ||
  /* INSTALLATION_BASE */ "http://localhost:3001/v1"
).replace(/\/$/, "");
let key = process.env.ANONYMA_API_KEY || saved.key || "";
let model =
  process.env.ANONYMA_MODEL || saved.model || "google/gemini-2.5-flash";
let messages = [];
let controller;
if (args[0] === "--help" || args[0] === "help") {
  console.log(
    'Anonyma CLI (Node 18+)\nUsage: anonyma ["prompt"]\n       anonyma config\n\nEnvironment: ANONYMA_API_KEY, ANONYMA_BASE_URL, ANONYMA_MODEL\nInteractive: /models, /model ID, /new, /balance, /exit\nNo tools or shell commands are executed from model output.',
  );
  process.exit(0);
}
async function request(path, body) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}
function promptSecret(label) {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      rl.question(label).then((v) => {
        rl.close();
        resolve(v);
      });
      return;
    }
    stdout.write(label);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const handler = (chunk) => {
      for (const c of chunk) {
        if (c === "\u0003") {
          cleanup();
          process.exit(130);
        }
        if (c === "\r" || c === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    function cleanup() {
      stdin.removeListener("data", handler);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    }
    stdin.on("data", handler);
  });
}
if (args[0] === "config" || args[0] === "login") {
  const rl = createInterface({ input: stdin, output: stdout });
  base = (await rl.question(`API base URL [${base}]: `)).trim() || base;
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol))
    throw Error("Use an HTTP(S) API base URL.");
  model = (await rl.question(`Default model [${model}]: `)).trim() || model;
  rl.close();
  key = await promptSecret("API key (hidden): ");
  if (!key) throw Error("An API key is required.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ base, key, model }, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  console.log("Configuration saved with owner-only file permissions.");
  process.exit(0);
}
if (!key) {
  console.error("No API key. Run `anonyma config` or set ANONYMA_API_KEY.");
  process.exit(1);
}
async function chat(prompt) {
  let markdownBuffer = "",
    inCode = false;
  const safeText = (text) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  function renderLine(line) {
    if (/^```/.test(line)) {
      inCode = !inCode;
      return inCode ? "\x1b[2m  " + line.slice(3) + "\x1b[0m\n" : "\n";
    }
    if (inCode) return "\x1b[36m  " + line + "\x1b[0m\n";
    return (
      line
        .replace(/^#{1,6}\s+(.+)$/, "\x1b[1m$1\x1b[0m")
        .replace(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[0m")
        .replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[0m") + "\n"
    );
  }
  const writeMarkdown = (text) => {
    const clean = safeText(text);
    if (!stdout.isTTY) {
      stdout.write(clean);
      return;
    }
    markdownBuffer += clean;
    let end;
    while ((end = markdownBuffer.indexOf("\n")) >= 0) {
      stdout.write(renderLine(markdownBuffer.slice(0, end)));
      markdownBuffer = markdownBuffer.slice(end + 1);
    }
  };
  controller = new AbortController();
  const r = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [...messages.slice(-18), { role: "user", content: prompt }],
      max_tokens: 4096,
      stream: true,
    }),
    signal: controller.signal,
  });
  if (!r.ok) {
    const j = await r.json();
    throw Error(j.error?.message || `HTTP ${r.status}`);
  }
  let buffer = "",
    answer = "",
    completed = false,
    receipt,
    usage;
  const decoder = new TextDecoder();
  for await (const bytes of r.body) {
    buffer += decoder.decode(bytes, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const raw = event
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!raw) continue;
      if (raw === "[DONE]") {
        completed = true;
        break;
      }
      const j = JSON.parse(raw);
      if (j.error) throw Error(j.error.message);
      const delta = j.choices?.[0]?.delta;
      if (delta?.content) {
        writeMarkdown(delta.content);
        answer += delta.content;
      }
      if (delta?.images)
        for (const image of delta.images)
          stdout.write(`\nImage: ${image.image_url?.url || image.url}\n`);
      receipt = j.anonyma || j.askr || receipt;
      usage = j.usage || usage;
    }
    if (completed) break;
  }
  if (markdownBuffer) stdout.write(renderLine(markdownBuffer));
  stdout.write("\n");
  if (!completed)
    throw Error(
      "Connection ended before completion was confirmed. Check account activity before retrying.",
    );
  if (receipt)
    console.log(
      `[${receipt.credits_charged} credits${usage ? ` · ${usage.total_tokens} tokens` : ""}${receipt.local_test ? " · LOCAL TEST" : ""}]`,
    );
  messages.push(
    { role: "user", content: prompt },
    { role: "assistant", content: answer },
  );
  controller = null;
}
process.on("SIGINT", () => {
  if (controller) {
    controller.abort();
    console.log("\nStopped. Partial output may have been charged.");
  } else process.exit(0);
});
if (args.length) {
  try {
    await chat(args.join(" "));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
} else {
  console.log(
    `Anonyma · ${model}\nType /models, /model ID, /new, /balance or /exit. Markdown is streamed as text.\n`,
  );
  const rl = createInterface({ input: stdin, output: stdout });
  while (true) {
    const prompt = (await rl.question("You › ")).trim();
    if (!prompt) continue;
    if (prompt === "/exit" || prompt === "/quit") break;
    try {
      if (prompt === "/models") {
        const j = await request("/models");
        console.log(j.data.map((m) => m.id).join("\n"));
      } else if (prompt === "/model") {
        console.log("Model: " + model);
      } else if (prompt.startsWith("/model ")) {
        model = prompt.slice(7).trim();
        console.log("Model: " + model);
      } else if (prompt === "/new") {
        messages = [];
        console.log("Conversation cleared.");
      } else if (prompt === "/balance") {
        const j = await request("/balance");
        console.log(`${j.available} available / ${j.balance} total credits`);
      } else await chat(prompt);
    } catch (e) {
      console.error(
        e.name === "AbortError" ? "Generation stopped." : e.message,
      );
      controller = null;
    }
  }
  rl.close();
}
