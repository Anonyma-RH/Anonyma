import { readFileSync } from "node:fs";
import { fail, generationPrice } from "./core.js";
// PPQ's BYOK usage.cost is its fee, not the full account debit. The
// upstream inference charge appears separately in cost_details. Live PPQ
// history includes another 0.5% of that upstream charge in the final debit.
export function reportedProviderCost(usage, explicitCost) {
  const valid = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const reported = valid(explicitCost)
    ? explicitCost
    : valid(usage?.cost)
      ? usage.cost
      : null;
  const upstream = usage?.cost_details?.upstream_inference_cost;
  if (usage?.is_byok === true && valid(upstream))
    return Math.max(
      upstream * 1.005 + (valid(usage.cost) ? usage.cost : 0),
      reported ?? 0,
    );
  return reported;
}
// Codes for upstream responses that prove the provider did not accept the
// request, so its reservation can be released without reconciliation.
export const PROVIDER_REFUSALS = new Set([
  "provider_rejected",
  "provider_unavailable",
  "provider_busy",
]);
// 401/402/403 mean the operator's gateway account (key, funding, access) is
// at fault and 429 means the gateway is throttling us; neither is the
// user's request, so they are reported as a temporary service condition.
function providerFailure(status, detail, label = "Provider") {
  if ([401, 402, 403].includes(status)) {
    console.error(
      `${label} refused the gateway account (${status}). Check the gateway key and its funding.`,
    );
    fail(
      503,
      "The AI provider is temporarily unavailable. Nothing was charged.",
      "provider_unavailable",
    );
  }
  if (status === 429)
    fail(
      503,
      "The AI provider is busy. Nothing was charged; try again shortly.",
      "provider_busy",
    );
  fail(
    status >= 500 ? 502 : 400,
    detail || `${label} rejected this request (${status}).`,
    "provider_rejected",
  );
}
export async function* chatStream(cfg, body, signal, onAccepted) {
  if (cfg.testMode) {
    onAccepted?.();
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
    providerFailure(response.status, detail);
  }
  onAccepted?.();
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
  const dedicated = model.type === "image";
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
    const resolution =
      options.resolution ||
      (/^[124]K$/.test(options.size || "") ? options.size : null);
    const size =
      options.size && options.size !== resolution
        ? options.size
        : options.ratio;
    const body = dedicated
      ? {
          model: model.id,
          prompt,
          ...(model.pricing?.variants?.length
            ? { quality: options.quality || model.pricing.variants[0].quality }
            : {}),
          ...(options.images?.length ? { image_url: options.images[0] } : {}),
          ...(resolution ? { resolution } : {}),
          ...(size ? { size } : {}),
          ...(options.output_format
            ? { output_format: options.output_format }
            : {}),
        }
      : {
          model: model.id,
          messages: [{ role: "user", content }],
          stream: false,
        };
    const r = await fetch(
      cfg.gateway.replace(/\/$/, "") +
        (dedicated ? "/v1/images/generations" : "/chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.gatewayKey}`,
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!r.ok) {
      if ([401, 402, 403, 429].includes(r.status))
        providerFailure(r.status, null, "Image provider");
      fail(
        502,
        `Image provider rejected the request (${r.status}).`,
        "provider_rejected",
      );
    }
    const j = await r.json();
    let images = dedicated
      ? j.data || []
      : j.choices?.[0]?.message?.images || [];
    if (
      !dedicated &&
      !images.length &&
      Array.isArray(j.choices?.[0]?.message?.content)
    )
      images = j.choices[0].message.content.filter(
        (p) => p.type === "image_url",
      );
    if (!images.length)
      fail(
        502,
        "The provider returned no image for this part of the batch.",
        "empty_output",
      );
    const cost =
      reportedProviderCost(j.usage, j.cost) ?? generationPrice(model, options);
    // Persist each completed call before starting the next paid request.
    await onBatch({
      data: images.map((v) => ({
        url: v.image_url?.url || v.url,
        b64_json: v.b64_json,
      })),
      cost,
    });
  }
}
export async function createVideo(cfg, body) {
  if (cfg.testMode)
    return { id: "local_" + Date.now(), status: "pending", estimated_cost: 0 };
  const r = await fetch(cfg.gateway.replace(/\/$/, "") + "/v1/videos", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.gatewayKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) {
    if ([401, 402, 403, 429].includes(r.status))
      providerFailure(r.status, null, "Video provider");
    fail(502, `Video submission rejected (${r.status}).`, "provider_rejected");
  }
  return r.json();
}
export async function pollVideo(cfg, id, signal) {
  if (cfg.testMode)
    return { status: "completed", cost: 0.01, data: { test: true } };
  const r = await fetch(
    cfg.gateway.replace(/\/$/, "") + "/v1/videos/" + encodeURIComponent(id),
    {
      headers: { authorization: `Bearer ${cfg.gatewayKey}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    },
  );
  if (!r.ok) throw new Error(`Video poll failed (${r.status})`);
  return r.json();
}
export async function payment(cfg, path, body, signal) {
  if (!cfg.paymentKey || cfg.testMode)
    fail(
      503,
      cfg.testMode
        ? "Live payments are disabled in local test mode."
        : "Payment processing is not configured.",
      "payments_unconfigured",
    );
  const r = await fetch(cfg.paymentBase + path, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.paymentKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  });
  if (!r.ok)
    fail(
      502,
      `Payment processor returned ${r.status}.`,
      r.status >= 400 && r.status < 500 && ![408, 429].includes(r.status)
        ? "payment_rejected"
        : "payment_error",
    );
  return r.json();
}
