import { readFileSync } from "node:fs";
import { fail, generationPrice } from "./core.js";
import { sheetsTestReply } from "./sheets.js";
import { sharpenTestReply } from "./sharpen.js";
import { studyTestReply } from "./study.js";
import { compareTestReply } from "./compare.js";
import { pageWatchTestReply } from "./page-watch-test.js";
import { overviewTestReply } from "./audio-overview.js";
import { translateTestReply } from "./translate-test.js";
import { fileSearchTestReply } from "./file-search-test.js";
import { catchupTestReply } from "./catchup.js";
import { autoHelperTestReply } from "./auto-model-test.js";
import { canvasTestReply } from "./canvas.js";
import { slidesTestReply } from "./slides.js";
import { meetingNotesTestReply } from "./meeting-notes.js";
import { repoTestReply } from "./repo-reader.js";
import { siteTestReply } from "./shot-to-site.js";
// PPQ's BYOK usage.cost is its fee, not the full account debit. The
// upstream inference charge appears separately in cost_details. Live PPQ
// history includes another 0.5% of that upstream charge in the final debit.
// What PPQ actually debits for a request. For token-priced chat PPQ adds a
// fee on top of the upstream inference cost it reports: observed debits were
// exactly 1.055 times that cost (0.0000836 -> 0.000088198 with a BYOK key,
// 0.000119208 -> 0.000125764 without). A top-level `cost`, as image and video
// responses carry, is already the final debit.
export function reportedProviderCost(usage, explicitCost, feePercent = 5.5) {
  const valid = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (valid(explicitCost)) return explicitCost;
  const fee = 1 + feePercent / 100;
  const upstream = usage?.cost_details?.upstream_inference_cost;
  if (valid(upstream)) return upstream * fee;
  // With a BYOK key, `usage.cost` is only PPQ's fee, not the inference.
  if (valid(usage?.cost) && usage.is_byok !== true) return usage.cost * fee;
  return null;
}
// PPQ's native Gemini response can exclude thinking from completion_tokens
// while including it in total_tokens.
// A live 2026-09-27 request reported 40 completion + 573 reasoning tokens;
// PPQ history billed 613 output tokens. Only repair the exclusive shape
// proven by total = prompt + completion + reasoning. Ordinary inclusive
// usage and inconsistent totals remain untouched to avoid overcharging.
export function normalizeProviderUsage(usage, gateway, model) {
  let host;
  try { host = new URL(gateway).hostname; } catch { return usage; }
  const input = usage?.prompt_tokens, output = usage?.completion_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (host !== "api.ppq.ai" || !/^(?:google\/)?gemini-/.test(model || "") ||
      !usage?.extra_properties?.google ||
      ![input, output, reasoning, usage?.total_tokens].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      reasoning <= 0 || usage.total_tokens !== input + output + reasoning ||
      !Number.isSafeInteger(input + output + reasoning)) return usage;
  return { ...usage, completion_tokens: output + reasoning };
}
// Codes for upstream responses that prove the provider did not accept the
// request, so its reservation can be released without reconciliation.
export const PROVIDER_REFUSALS = new Set([
  "provider_rejected",
  "provider_unavailable",
  "provider_busy",
  "provider_down",
]);
// 401/402/403 mean the operator's gateway account (key, funding, access) is
// at fault and 429 means the gateway is throttling us; neither is the
// user's request, so they are reported as a temporary service condition.
export function providerFailure(status, detail, label = "Provider") {
  try {
    refuse(status, detail, label);
  } catch (e) {
    // Model Status (server/model-status.js) tells a request the provider
    // turned down (400, 413, 422) from a model that's down.
    e.upstreamStatus = status;
    throw e;
  }
}
// A provider's refusal of a media request, keeping its upstream status.
function mediaRejected(status, message) {
  const e = new Error(message);
  Object.assign(e, { status: 502, code: "provider_rejected", upstreamStatus: status });
  throw e;
}
function refuse(status, detail, label) {
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
  if (status >= 500)
    fail(
      502,
      detail || `${label} is having trouble (${status}). Nothing was charged.`,
      "provider_down",
    );
  fail(
    400,
    detail || `${label} rejected this request (${status}).`,
    "provider_rejected",
  );
}
// Local test mode's fixed reply to a question about a diagram or a formula:
// a sample with inline and display math and a Mermaid flowchart, for trying
// out Math & Diagrams without a live model.
const TEST_DIAGRAM_ANSWER = [
  "**Local test provider** — a fixed sample reply, not a live model.",
  "",
  "A prepaid request is held, run, then settled. For a model listed at $p_{in}$ and $p_{out}$ credits per million input and output tokens, the charge is",
  "",
  "$$",
  "\\text{charge} = \\frac{t_{in}\\,p_{in} + t_{out}\\,p_{out}}{10^{6}}",
  "$$",
  "",
  "and whatever was held beyond that goes straight back to your balance.",
  "",
  "```mermaid",
  "flowchart TD",
  "  A[Your message] --> B{Enough balance?}",
  "  B -- No --> C[Refused, nothing charged]",
  "  B -- Yes --> D[Hold the estimate]",
  "  D --> E[Model replies]",
  "  E --> F[Charge the tokens used, release the rest]",
  "```",
  "",
  "Nothing is charged for a refused or failed request.",
].join("\n");

// Local test mode's fixed reply to a request for Python that plots or
// reads data: a runnable sample for Python Runner. With a CSV attached it
// reads that file by name; otherwise it plots made-up numbers. "Write a
// python function" still gets the JavaScript fixture above.
export function pythonTestReply(text) {
  const ask = String(text || "").split("\n\n<document ")[0];
  if (!/python/i.test(ask) || !/\b(plot|chart|graph|matplotlib|pandas|numpy|csv|data)\b|图表|画图|绘图|曲线|数据/i.test(ask))
    return null;
  const csv = /<document name="([^"]+\.csv)"/i.exec(String(text))?.[1]?.replace(/[^\w .()-]/g, "_");
  const intro = "**Local test provider** — a fixed sample reply, not a live model.";
  if (csv)
    return [
      intro,
      "",
      `This reads \`${csv}\`, totals its number columns and charts them by the first column:`,
      "",
      "```python",
      "import pandas as pd",
      "import matplotlib.pyplot as plt",
      "",
      `df = pd.read_csv("${csv}")`,
      "label = df.columns[0]",
      "numbers = [c for c in df.select_dtypes(\"number\").columns if c != label]",
      "",
      "print(f\"{len(df)} rows. Totals:\", \", \".join(f\"{c} {df[c].sum():,}\" for c in numbers))",
      "",
      "ax = df.plot(x=label, y=numbers, kind=\"bar\", figsize=(8.6, 2.9), rot=0,",
      "             color=[\"#0135df\", \"#ffb21c\", \"#7f9bff\"][: len(numbers)])",
      `ax.set_title("${csv}")`,
      "ax.set_xlabel(\"\")",
      "ax.spines[[\"top\", \"right\"]].set_visible(False)",
      "plt.tight_layout()",
      "plt.show()",
      "```",
      "",
      "Tick **Use my attached CSV** before you run it, so the code can read the file.",
    ].join("\n");
  return [
    intro,
    "",
    "Here's a plot of two waves, with the peak printed underneath:",
    "",
    "```python",
    "import numpy as np",
    "import matplotlib.pyplot as plt",
    "",
    "x = np.linspace(0, 4 * np.pi, 400)",
    "plt.figure(figsize=(8.6, 2.9))",
    "plt.plot(x, np.sin(x), label=\"sin(x)\", color=\"#0135df\", linewidth=2)",
    "plt.plot(x, np.cos(x), label=\"cos(x)\", color=\"#ffb21c\", linewidth=2)",
    "plt.title(\"Sine and cosine\")",
    "plt.legend(frameon=False)",
    "plt.gca().spines[[\"top\", \"right\"]].set_visible(False)",
    "plt.tight_layout()",
    "plt.show()",
    "",
    "print(\"Peak of sin(x):\", round(float(np.sin(x).max()), 3))",
    "```",
  ].join("\n");
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
    // File Search's stand-in (server/file-search-test.js) answers from the
    // passages it is given, citing them by number.
    const fileSearch = fileSearchTestReply(body.messages);
    if (fileSearch) {
      if (fileSearch.error) {
        yield { error: { message: fileSearch.error } };
        return;
      }
      for (const part of fileSearch.text.match(/.{1,16}|\n/g) || []) {
        signal?.throwIfAborted();
        await new Promise((r) => setTimeout(r, 12));
        yield { choices: [{ delta: { content: part }, index: 0 }] };
      }
      if (fileSearch.finish) yield { choices: [{ delta: {}, index: 0, finish_reason: fileSearch.finish }] };
      yield {
        choices: [],
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4),
          completion_tokens: Math.ceil(fileSearch.text.length / 4),
        },
      };
      return;
    }
    const last = body.messages.filter((m) => m.role === "user").at(-1)?.content;
    const text =
      typeof last === "string"
        ? last
        : last?.find((p) => p.type === "text")?.text || "";
    // Deterministic stand-ins for the features that parse a model's reply:
    // Page Watch's summaries and Summarize & Continue's summary (each with a
    // finish reason, "length" when cut off), Local Sheets' planner and
    // explainer, Study Mode's decks, Document Compare's summary, Audio
    // Overview's script writer (server/audio-overview.js), Prompt Sharpen's
    // sharpener (server/sharpen.js), Auto Model's helper
    // (server/auto-model-test.js) and Highlight & Ask's fact-check: a
    // Overview's script writer (server/audio-overview.js), Meeting Notes'
    // notes (server/meeting-notes.js), Prompt Sharpen's
    // sharpener (server/sharpen.js) and Highlight & Ask's fact-check: a
    // verdict in its JSON shape, with no pages (no search runs here), so the
    // card says it couldn't be verified. Each returns null otherwise.
    // Page Watch's summaries, Summarize & Continue's summary and Canvas's
    // suggestions (each with a finish reason, "length" when cut off), Local
    // Sheets' planner and explainer, Study Mode's decks, Document Compare's
    // summary, Audio Overview's script writer (server/audio-overview.js),
    // Prompt Sharpen's sharpener (server/sharpen.js) and Highlight & Ask's
    // fact-check: a verdict in its JSON shape, with no pages (no search runs
    // here), so the card says it couldn't be verified. Each returns null
    // otherwise.
    const factCheck = String(body.messages?.[0]?.content || "").startsWith("You fact-check one claim against the live web.")
      ? JSON.stringify({ verdict: "unverified", reason: "Local test provider: no web search was run.", sources: [] })
      : null;
    // Slides' deck and slide writer (server/slides.js) finishes the same way,
    // and so does Repo Reader's answer (server/repo-reader.js) and Screenshot
    // to site's page (server/shot-to-site.js).
    // Translate docs' stand-in (server/translate-test.js) can also fail on
    // purpose, as a provider error would.
    const finishing =
      pageWatchTestReply(body.messages) ?? catchupTestReply(body.messages) ?? canvasTestReply(body.messages) ?? slidesTestReply(body.messages) ?? translateTestReply(body.messages) ?? repoTestReply(body.messages) ?? siteTestReply(body.messages);
    if (finishing?.error) {
      yield { error: { message: finishing.error } };
      return;
    }
    const standIn =
      finishing !== null
        ? finishing.text
        : sheetsTestReply(body.messages) ??
          studyTestReply(body.messages) ??
          compareTestReply(body.messages) ??
          overviewTestReply(body.messages) ??
          meetingNotesTestReply(body.messages) ??
          sharpenTestReply(body.messages) ??
          autoHelperTestReply(body.messages) ??
          factCheck;
    const python = standIn === null ? pythonTestReply(text) : null;
    const answer = standIn !== null ? standIn : python !== null ? python : /code|function|javascript|python/i.test(text)
      ? "**Local test provider** — this is a deterministic integration fixture, not a live model.\n\n```javascript filename=hello.js\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n```\n\nThe file is available in the code panel."
      : /\b(diagram|equation|formula)s?\b|图表|公式|流程图/i.test(text)
      ? TEST_DIAGRAM_ANSWER
      : "**Local test provider**\n\nYou asked: " +
        text +
        "\n\nThis response verifies streaming, saved conversations, usage receipts, and the shared credit ledger. Configure your gateway key to receive real model output.";
    // (A stand-in may ask for bigger pieces, so a very long reply is quick.)
    const piece = finishing?.chunk > 16 ? new RegExp(`.{1,${finishing.chunk}}|\\n`, "g") : /.{1,16}|\n/g;
    for (const part of answer.match(piece) || []) {
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, 12));
      yield { choices: [{ delta: { content: part }, index: 0 }] };
    }
    if (finishing?.finish)
      yield { choices: [{ delta: {}, index: 0, finish_reason: finishing.finish }] };
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
  let response;
  try {
    response = await fetch(
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
  } catch (e) {
    if (signal?.aborted) throw e;
    // No response. The provider may still have run it, so failing over can
    // cost the operator twice; the user is only ever charged once.
    fail(
      502,
      "The AI provider couldn't be reached. Nothing was charged.",
      "provider_down",
    );
  }
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
          const part = JSON.parse(data);
          if (part.usage) part.usage = normalizeProviderUsage(part.usage, cfg.gateway, body.model);
          yield part;
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
        // Photo Tools passes the picture its tool would give back.
        b64_json: (
          options.testImage ??
          readFileSync(new URL("../data/test-image.png", import.meta.url))
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
          // A utility model (background removal, an upscaler) takes no prompt.
          ...(prompt ? { prompt } : {}),
          ...(model.pricing?.variants?.length
            ? { quality: options.quality || model.pricing.variants[0].quality }
            : {}),
          ...(options.images?.length ? { image_url: options.images[0] } : {}),
          ...(resolution ? { resolution } : {}),
          ...(size ? { size } : {}),
          ...(options.output_format
            ? { output_format: options.output_format }
            : {}),
          // Extra routing the caller needs, such as zero-data-retention.
          ...(options.extraBody || {}),
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
      mediaRejected(r.status, `Image provider rejected the request (${r.status}).`);
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
    // A timeout or server error can arrive after the provider accepted a
    // paid job. Preserve its reservation for reconciliation; retrying could
    // submit and charge for a second video.
    if (r.status === 408 || r.status >= 500)
      fail(
        502,
        "Video submission could not be confirmed. Check your jobs before trying again.",
        "provider_ambiguous",
      );
    if ([401, 402, 403, 429].includes(r.status))
      providerFailure(r.status, null, "Video provider");
    mediaRejected(r.status, `Video submission rejected (${r.status}).`);
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
