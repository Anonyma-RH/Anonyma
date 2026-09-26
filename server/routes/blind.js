import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
} from "node:crypto";
import { uid, now, fail, credits, transaction } from "../core.js";
import { refuseSeedPhrase } from "../seed-guard.js";
import { isPrivateModel } from "../private-mode.js";
import { requestIdentifier } from "../middleware.js";
import { veilMaskedFrom } from "../privacy-trail.js";
import { chatTitle } from "./chat.js";
import {
  SIDES,
  OUTCOMES,
  MAX_VOTES,
  blindText,
  rankings,
} from "../../src/blind.js";

// Blind Compare: one message answered by two chat models at once, labelled
// A and B in a random order. Each side runs through runChat (routes/chat.js)
// exactly like a chat reply: the same validation, hold, settlement, failure
// policies, Spending Limits, receipts and Privacy Trail. The only additions
// are that neither side starts until both are reserved (so a refused side
// releases the other and nothing is sent), and that the stream carries only
// the text of each side, never a model's name or its own charge.
//
// What is stored, and when:
// - Nothing about the round itself until the person votes. Which model was
//   A, and each side's charge and speed, travel sealed (AES-GCM, this
//   installation's key) in a round token the browser holds, or inside the
//   saved reply for a saved chat.
// - A vote stores the two model ids, the outcome and the date, per account
//   (blind_votes), for "Your rankings". Never a prompt or a reply. Account
//   closure and Panic Wipe erase them; the account export lists them.
// - A saved chat keeps its user message and one reply holding both answers,
//   and the reveal once voted, like any saved turn. Off the record, Private
//   Mode and Device only rounds are never saved on the server.

const MODES = ["chat", "code", "uncensored"];
// A round can be voted on for 30 days after it ran.
export const TOKEN_TTL_MS = 30 * 86400000;

// The display order of one round: the two models in a fair random order.
export function orderPair(pair, coin = () => randomInt(2)) {
  return coin() === 1 ? [pair[1], pair[0]] : [pair[0], pair[1]];
}

// Round tokens: sealed so the browser can't read (or forge) which model is
// which, and bound to the account inside.
export function roundSealer(secret) {
  const key = createHash("sha256")
    .update("anonyma-blind-compare:" + secret)
    .digest();
  const aad = Buffer.from("anonyma-blind-round-v1");
  return {
    seal(value) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(aad);
      const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
    },
    open(token) {
      if (typeof token !== "string" || token.length > 20000 || !/^[A-Za-z0-9_-]+$/.test(token))
        return null;
      try {
        const raw = Buffer.from(token, "base64url");
        if (raw.length < 29) return null;
        const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        d.setAAD(aad);
        d.setAuthTag(raw.subarray(12, 28));
        return JSON.parse(
          Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8"),
        );
      } catch {
        return null;
      }
    },
  };
}

// The account export: each vote, never anything about the chat it came from.
export function exportBlindVotes(db, user) {
  return db
    .prepare(
      "SELECT id,model_a,model_b,outcome,created FROM blind_votes WHERE user_id=? ORDER BY created,rowid",
    )
    .all(user);
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export function forgetBlindVotes(db, user) {
  db.prepare("DELETE FROM blind_votes WHERE user_id=?").run(user);
}

// The server-sent events runChat writes, as objects.
function* sseEvents(chunk) {
  for (const line of String(chunk || "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      yield JSON.parse(data);
    } catch {}
  }
}

export function blindRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const { seal, open } = roundSealer(cfg.secret);
  const nameOf = (id) => ctx.models.find(id)?.name || id;
  const revealOf = (p, outcome) => ({
    outcome,
    ...Object.fromEntries(
      SIDES.map((s) => [
        s,
        {
          model: p[s],
          name: nameOf(p[s]),
          credits: credits(p.d?.[s]?.c || 0),
          ms: p.d?.[s]?.ms ?? null,
          request_id: p.d?.[s]?.r || null,
          ...(p.d?.[s]?.p ? { privacy: p.d[s].p } : {}),
        },
      ]),
    ),
  });

  app.post("/api/blind", requireUser, limit("blind", 10, 60000), async (req, res) => {
    const body = req.body || {};
    const user = req.user.id;
    // Seed Guard, before anything is validated, reserved or stored.
    refuseSeedPhrase(cfg, req, false);
    const pair = body.models;
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((id) => typeof id !== "string" || !id || id.length > 200)
    )
      fail(400, "Choose two models to compare.", "invalid_request");
    if (pair[0] === pair[1])
      fail(400, "Choose two different models to compare.", "blind_same_model");
    // What Blind doesn't do, said plainly rather than silently dropped.
    if (body.web_search === true || body.plugins !== undefined)
      fail(400, "Web search is off in Blind.", "blind_unsupported");
    if (body.memory != null)
      fail(400, "Memory isn't used in Blind.", "blind_unsupported");
    if (body.treasury === true)
      fail(400, "Blind isn't available with Team pays.", "blind_unsupported");
    if (body.double_check != null || body.taskTool !== undefined)
      fail(400, "Blind compares chat replies only.", "blind_unsupported");
    const mode = body.mode ?? "chat";
    if (!MODES.includes(mode))
      fail(400, "Blind works in chat, code and Uncensored.", "invalid_request");
    const models = pair.map((id) => ctx.models.getModel(id));
    if (models.some((m) => m.type !== "chat"))
      fail(400, "Blind compares chat models.", "unsupported_model");
    const isPrivate = body.private === true;
    if (isPrivate && models.some((m) => !isPrivateModel(m, cfg)))
      fail(
        400,
        "Private mode needs two models with zero data retention.",
        "private_model_required",
      );
    // The same checks each side makes, up front, so a request neither model
    // can take is refused before either is reserved.
    const expanded = ctx.files.expandMessages(req, body.messages);
    let messages;
    for (const m of models) {
      messages = ctx.models.validateMessages(expanded, m);
      ctx.models.validateContext(messages, m, ctx.models.maxTokens(body.max_tokens, m));
    }
    if (messages.at(-1)?.role !== "user")
      fail(400, "The last message must be yours.", "invalid_request");
    const veilMasked = veilMaskedFrom(body);
    const requestId = requestIdentifier(req);
    if (requestId.length > 190)
      fail(400, "Request ID must contain 1–190 characters.", "invalid_request_id");
    // Off the record and Private Mode: nothing about the round is saved.
    const ephemeral = body.ephemeral === true || isPrivate;
    if (ephemeral && body.conversationId)
      fail(
        400,
        "An off-the-record chat can't be added to a saved conversation.",
        "invalid_request",
      );
    let conversation = null;
    if (!ephemeral && body.conversationId != null) {
      if (typeof body.conversationId !== "string")
        fail(400, "conversationId must be a conversation id.", "invalid_request");
      const c = ctx.conversations.accessConversation(body.conversationId, user);
      if (c.collab_id)
        fail(400, "Blind isn't available in shared chats.", "blind_unsupported");
      if (!MODES.includes(c.mode || "chat"))
        fail(400, "Blind works in chat, code and Uncensored conversations.", "blind_unsupported");
      conversation = c.id;
    }
    let project = null;
    if (body.project != null) {
      if (ephemeral)
        fail(
          400,
          "Off-the-record and Private chats are never saved, so they aren't filed in a project.",
          "invalid_request",
        );
      if (body.conversationId)
        fail(
          400,
          "A saved chat moves between projects from its details, not with a new message.",
          "invalid_request",
        );
      project = ctx.projects.forChat(user, body.project);
    }

    const [first, second] = orderPair(models);
    const round = uid("br_");
    let started = false,
      clientGone = false;
    const emit = (value) => {
      if (started && !res.destroyed) res.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    res.on("close", () => {
      if (!res.writableEnded) clientGone = true;
    });

    // Neither side is sent until both are reserved.
    let arrived = 0,
      opened = false,
      refusal = null,
      openGate,
      closeGate;
    const gate = new Promise((ok, no) => {
      openGate = ok;
      closeGate = no;
    });
    gate.catch(() => {});
    const partnerRefused = () =>
      Object.assign(new Error("The other model couldn't start, so nothing was sent."), {
        code: "blind_partner_refused",
      });
    const refuse = (e) => {
      refusal ??= e;
      if (!opened) closeGate(partnerRefused());
    };
    // Both reserved: save the question (a saved chat) and start the stream.
    function start() {
      if (!ephemeral) {
        const last = messages.at(-1).content;
        conversation ||= ctx.conversations.newConversation(
          user,
          typeof last === "string" ? chatTitle(last) : "Image conversation",
          mode,
        );
        if (project) ctx.projects.file(conversation, project.id, user);
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(uid("m_"), conversation, "user", JSON.stringify(last), null, 0, now(), user);
        db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
      }
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      started = true;
      emit({ blind: { conversationId: conversation } });
      for (const s of sides) s.start = now();
    }
    const side = (label, m) => {
      const s = {
        label,
        model: m,
        requestId: requestId + ":" + label,
        text: "",
        reasoning: "",
        finish: null,
        error: null,
        extension: null,
        reserved: false,
        ended: false,
        start: 0,
        ms: null,
        listeners: [],
      };
      s.req = {
        body: {
          model: m.id,
          // Saved files already read in (routes/files.js): each side is
          // sent exactly what was checked above.
          messages: expanded,
          ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
          requestId: s.requestId,
          // Each side is an unsaved chat; the round is saved below.
          ephemeral: true,
          ...(isPrivate ? { private: true } : {}),
          ...(veilMasked !== undefined ? { veil_masked: veilMasked } : {}),
          ...(body.allow_seed_phrase === true ? { allow_seed_phrase: true } : {}),
        },
        user: req.user,
        headers: {},
        // A text comparison: images a model returns aren't kept.
        discardMedia: true,
        blind: {
          storage: isPrivate ? "private" : ephemeral ? "off_the_record" : "saved",
          // Off the record and in Private Mode only the model is kept with
          // the charge, never which kind of chat it was (usage-insights.js).
          feature: ephemeral ? "chat" : "blind",
        },
        beforeSend() {
          s.reserved = true;
          if (++arrived === 2) {
            try {
              start();
              opened = true;
              openGate();
            } catch (e) {
              refuse(e);
            }
          }
          return gate;
        },
      };
      const onEvent = (e) => {
        if (e.error) {
          s.error = {
            message: String(e.error.message || "The model didn't answer."),
            code: e.error.code || "generation_error",
          };
          if (e.anonyma) s.extension = e.anonyma;
          return;
        }
        if (e.anonyma && !e.choices?.length) s.extension = e.anonyma;
        const choice = e.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason) s.finish = choice.finish_reason;
        const d = choice.delta || {},
          out = {};
        if (typeof d.content === "string" && d.content) {
          s.text += d.content;
          out.content = d.content;
        }
        const r = d.reasoning ?? d.reasoning_content;
        if (typeof r === "string" && r) {
          s.reasoning += r;
          out.reasoning = r;
        }
        if (out.content || out.reasoning) emit({ side: label, delta: out });
      };
      s.res = {
        set() {
          return this;
        },
        flushHeaders() {},
        write(chunk) {
          for (const e of sseEvents(chunk)) onEvent(e);
          return true;
        },
        end(chunk) {
          if (chunk) this.write(chunk);
          if (s.ended) return;
          s.ended = true;
          if (s.start) s.ms = now() - s.start;
          if (opened)
            emit({
              side: label,
              status: s.error ? (clientGone ? "stopped" : "failed") : "done",
              ...(s.error ? { error: { message: s.error.message, code: s.error.code } } : {}),
            });
        },
        on(event, fn) {
          // runChat stops a side like Stop when the browser leaves.
          if (event === "close") {
            res.on("close", fn);
            s.listeners.push(fn);
          }
          return this;
        },
        json() {},
        get destroyed() {
          return res.destroyed;
        },
        get writableEnded() {
          return s.ended;
        },
      };
      return s;
    };
    const sides = [side("a", first), side("b", second)];
    const runs = [];
    try {
      for (const s of sides) {
        runs.push(
          ctx.runChat(s.req, s.res, false).catch((e) => {
            if (!s.reserved) refuse(e);
            else s.error ??= { message: e.message, code: e.code || "generation_error" };
          }),
        );
        // runChat reaches its reservation without waiting, so a side that
        // hasn't got there was refused: the other one is released (or never
        // starts) and nothing is sent.
        if (!s.reserved || refusal) {
          if (!opened) closeGate(partnerRefused());
          break;
        }
      }
      await Promise.all(runs);
    } finally {
      for (const s of sides) for (const fn of s.listeners) res.off("close", fn);
    }
    if (!opened) {
      if (refusal) throw refusal;
      fail(502, "The comparison couldn't start. Nothing was charged.", "blind_not_started");
    }

    // What each side was charged, from its settled hold (0 when released).
    const charged = (s) => {
      const h = db
        .prepare("SELECT status,result FROM holds WHERE id=?")
        .get(user + ":" + s.requestId);
      if (h?.status !== "settled" || !h.result) return 0;
      try {
        return Number(JSON.parse(h.result).charged) || 0;
      } catch {
        return 0;
      }
    };
    const status = (s) => (s.error ? (clientGone ? "stopped" : "failed") : "done");
    const [a, b] = sides;
    const total = charged(a) + charged(b);
    const votable = status(a) === "done" && status(b) === "done";
    const sealed = {
      v: 1,
      id: round,
      u: user,
      a: a.model.id,
      b: b.model.id,
      t: now(),
      d: Object.fromEntries(
        sides.map((s) => [
          s.label,
          {
            c: charged(s),
            ms: s.ms,
            r: s.requestId,
            ...(s.extension?.privacy ? { p: s.extension.privacy } : {}),
          },
        ]),
      ),
    };
    // A round with a failed or stopped side isn't a fair comparison: it's
    // revealed at once and never counted.
    const token = votable ? seal(sealed) : null;
    const reveal = votable ? null : revealOf(sealed, null);
    const view = (s) => ({
      text: s.text,
      reasoning: s.reasoning,
      status: status(s),
      finish_reason: s.finish || (s.error ? "interrupted" : "stop"),
      ...(s.error ? { error: s.error.message } : {}),
    });
    const blind = {
      a: view(a),
      b: view(b),
      ...(votable ? { token } : { reveal }),
    };
    let messageId = null;
    if (
      conversation &&
      !ephemeral &&
      (a.text || b.text || a.reasoning || b.reasoning) &&
      db.prepare("SELECT id FROM conversations WHERE id=?").get(conversation)
    ) {
      messageId = uid("m_");
      db.prepare(
        "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        messageId,
        conversation,
        "assistant",
        JSON.stringify({ text: blindText(blind), blind, request_id: requestId }),
        null,
        total,
        now(),
        user,
      );
      db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
    }
    emit({
      blind: {
        done: true,
        conversationId: conversation,
        message_id: messageId,
        credits_charged: credits(total),
        round: token,
        reveal,
        sides: Object.fromEntries(
          sides.map((s) => [
            s.label,
            { status: status(s), ...(s.error ? { error: s.error.message } : {}) },
          ]),
        ),
        ...(cfg.testMode ? { local_test: true } : {}),
      },
    });
    if (!res.destroyed) res.end("data: [DONE]\n\n");
  });

  // Vote, then reveal. The first vote on a round is the one that counts;
  // asking again reveals the same result.
  app.post("/api/blind/votes", requireUser, limit("blind-votes", 120, 60000), (req, res) => {
    const { round, outcome, message_id } = req.body || {};
    if (!OUTCOMES.includes(outcome))
      fail(400, "Vote A, B, tie or both bad.", "invalid_request");
    const p = open(round);
    if (!p || p.v !== 1 || p.u !== req.user.id || !p.a || !p.b)
      fail(404, "This comparison wasn't found.", "blind_round_not_found");
    if (!(now() - p.t <= TOKEN_TTL_MS))
      fail(410, "Voting on this comparison has closed.", "blind_vote_closed");
    const result = transaction(db, () => {
      const kept = db
        .prepare("SELECT outcome FROM blind_votes WHERE id=? AND user_id=?")
        .get(p.id, req.user.id);
      if (!kept) {
        db.prepare(
          "INSERT INTO blind_votes(id,user_id,model_a,model_b,outcome,created) VALUES(?,?,?,?,?,?)",
        ).run(p.id, req.user.id, p.a, p.b, outcome, now());
        db.prepare(
          "DELETE FROM blind_votes WHERE user_id=? AND id NOT IN (SELECT id FROM blind_votes WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT ?)",
        ).run(req.user.id, req.user.id, MAX_VOTES);
      }
      const reveal = revealOf(p, kept?.outcome || outcome);
      // A saved reply (or a branch's copy of it) takes the reveal too.
      let updated = null;
      if (typeof message_id === "string" && message_id.length <= 100) {
        const row = db
          .prepare(
            `SELECT m.id,m.content FROM messages m JOIN conversations c ON c.id=m.conversation_id
             WHERE m.id=? AND m.role='assistant' AND c.user_id=? AND c.collab_id IS NULL`,
          )
          .get(message_id, req.user.id);
        let content = null;
        try {
          content = row ? JSON.parse(row.content) : null;
        } catch {}
        if (content?.blind?.token === round) {
          const { token, ...rest } = content.blind;
          const blind = { ...rest, reveal };
          db.prepare("UPDATE messages SET content=? WHERE id=?").run(
            JSON.stringify({ ...content, text: blindText(blind), blind }),
            row.id,
          );
          updated = row.id;
        }
      }
      return { reveal, counted: !kept, updated };
    });
    res.json({
      reveal: result.reveal,
      counted: result.counted,
      message_id: result.updated,
    });
  });

  // Your rankings: win rates from this account's own votes only.
  app.get("/api/blind/rankings", requireUser, limit("blind-read", 240, 60000), (req, res) => {
    const votes = db
      .prepare("SELECT model_a,model_b,outcome FROM blind_votes WHERE user_id=?")
      .all(req.user.id);
    res.json({
      votes: votes.length,
      data: rankings(votes).map((r) => ({ ...r, name: nameOf(r.model) })),
    });
  });
  app.delete("/api/blind/rankings", requireUser, limit("blind-votes", 120, 60000), (req, res) => {
    const r = db.prepare("DELETE FROM blind_votes WHERE user_id=?").run(req.user.id);
    res.json({ deleted: Number(r.changes) });
  });
}
