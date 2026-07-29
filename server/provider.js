import { readFileSync } from "node:fs";
import { fail, generationPrice } from "./core.js";
export async function* chatStream(cfg, body, signal) {
  if (cfg.testMode) {
    if (/gemini.*image/.test(body.model)) {
      yield {
        choices: [
          {
            index: 0,
            delta: {
              images: [
                {
                  type: "image_url",
                  image_url: {
                    url:
                      "data:image/png;base64," +
                      readFileSync(
                        new URL("../data/test-image.png", import.meta.url),
                      ).toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      };
      return;
    }
    const last = body.messages.filter((m) => m.role === "user").at(-1)?.content;
    const text =
      typeof last === "string"
        ? last
        : last?.find((p) => p.type === "text")?.text || "";
    const answer = /code|function|javascript|python/i.test(text)
      ? "**Local test provider** — this is a deterministic integration fixture, not a live model.\n\n```javascript filename=hello.js\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n```\n\nThe file is available in the code panel."
      : "**Local test provider**\n\nYou asked: " +
        text +
        "\n\nThis response verifies streaming, saved conversations, usage receipts, and the shared credit ledger. Configure your gateway key to receive real model output.";
    for (const part of answer.match(/.{1,16}|\n/g) || []) {
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, 12));
      yield { choices: [{ delta: { content: part }, index: 0 }] };
    }
    yield {
      choices: [],
      usage: {
        prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
        completion_tokens: Math.ceil(answer.length / 4),
      },
    };
    return;
  }
  if (!cfg.gatewayKey)
    fail(503, "AI provider is not configured.", "provider_unconfigured");
  const response = await fetch(
    cfg.gateway.replace(/\/$/, "") + "/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.gatewayKey}`,
      },
      body: JSON.stringify({
        ...body,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    },
  );
  if (!response.ok) {
    let detail;
    try {
      detail = (await response.json()).error?.message;
    } catch {}
    fail(
      response.status >= 500 ? 502 : 400,
      detail || `Provider rejected this request (${response.status}).`,
      "provider_rejected",
    );
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          fail(
            502,
            "Provider returned an unreadable event.",
            "provider_unreadable",
          );
        }
      }
    }
  }
  fail(
    502,
    "The provider connection ended before completion was confirmed. Partial output may have been billed; check activity before retrying.",
    "provider_interrupted",
  );
}
export async function generateImages(
  cfg,
  model,
  prompt,
  n,
  options,
  signal,
  onBatch,
) {
  if (cfg.testMode) {
    const batch = {
      data: Array.from({ length: n }, () => ({
        b64_json: readFileSync(
          new URL("../data/test-image.png", import.meta.url),
        ).toString("base64"),
      })),
      cost: generationPrice(model, options) * n,
      test: true,
    };
    await onBatch(batch);
    return;
  }
  const content = options.images?.length
    ? [
        { type: "text", text: prompt },
        ...options.images.map((url) => ({
          type: "image_url",
          image_url: { url },
        })),
      ]
    : prompt;
  for (let i = 0; i < n; i++) {
    const r = await fetch(
      cfg.gateway.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.gatewayKey}`,
        },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content }],
          stream: false,
        }),
        signal,
      },
    );
    if (!r.ok)
      fail(
        502,
        `Image provider rejected the request (${r.status}).`,
        "provider_rejected",
      );
    const j = await r.json();
    let images = j.choices?.[0]?.message?.images || [];
    if (!images.length && Array.isArray(j.choices?.[0]?.message?.content))
      images = j.choices[0].message.content.filter(
        (p) => p.type === "image_url",
      );
    if (!images.length)
      fail(
        502,
        "The provider returned no image for this part of the batch.",
        "empty_output",
      );
    const reportedCost = j.cost ?? j.usage?.cost;
    const cost =
      typeof reportedCost === "number" &&
      Number.isFinite(reportedCost) &&
      reportedCost >= 0
        ? reportedCost
        : generationPrice(model, options);
    // Persist each completed call before starting the next paid request.
    await onBatch({
      data: images.map((v) => ({ url: v.image_url?.url || v.url })),
      cost,
    });
  }
}