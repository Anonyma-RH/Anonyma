import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  now,
  uid,
  fail,
  credits,
  usdUnits,
  quote,
  markupFactor,
  assertPricedImageOption,
} from "./core.js";
import { videoOptions } from "./video-options.js";
import { isReleased } from "./releases.js";

export const recipeHash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Only actual generation controls, never auth, private-mode state or Veil maps.
export function mediaRecipe(kind, body) {
  const fields =
    kind === "image"
      ? [
          "model",
          "prompt",
          "n",
          "images",
          "size",
          "ratio",
          "quality",
          "resolution",
          "output_format",
        ]
      : kind === "video"
        ? ["model", "prompt", "ratio", "duration", "quality", "image_url"]
        : kind === "audio"
          ? ["model", "text", "voice", "language"]
          : [];
  const value = Object.fromEntries(
    fields.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]),
  );
  if (!fields.length || JSON.stringify(value).length > 3 * 1024 * 1024)
    return null;
  return value;
}
export function historyLibrary(ctx) {
  const { app, db, cfg, requireUser, limit } = ctx;
  function owned(id, user) {
    const m = db
      .prepare(
        "SELECT * FROM media WHERE id=? AND user_id=? AND expires IS NULL",
      )
      .get(id, user);
    if (!m) fail(404, "Media not found.");
    return m;
  }
  function source(item, user) {
    if (!item?.had_source)
      return {
        status: "not-recorded",
        message: "No source chat was saved for this item.",
      };
    if (item.source_id)
      try {
        const c = ctx.conversations.accessConversation(item.source_id, user);
        if (c.expires == null && !["private", "ephemeral"].includes(c.mode))
          return {
            status: "available",
            id: c.id,
            title: c.title,
            mode: c.mode || "chat",
          };
      } catch {
        /* Missing and inaccessible sources deliberately have the same response. */
      }
    return {
      status: "unavailable",
      message:
        "The source chat was deleted, is auto-deleting, or is no longer accessible.",
    };
  }
  async function prepare(id, user) {
    const m = owned(id, user.id),
      item = db.prepare("SELECT * FROM library_items WHERE media_id=?").get(id);
    const origin = source(item, user.id);
    // Chat media must reopen the real source rather than replay a partial context.
    if (item?.had_source || !item?.recipe)
      return {
        media: m,
        source: origin,
        rerun: {
          available: false,
          message: item?.had_source
            ? "Open the source chat to review its context before generating again."
            : "Original generation settings were not retained. Create a new request in the studio.",
        },
      };
    const params = JSON.parse(item.recipe);
    try {
      let cost;
      if (m.kind === "audio") {
        const model = await ctx.audio.model("tts", params.model);
        if (
          typeof params.text !== "string" ||
          !params.text.trim() ||
          params.text.length > (model.char_limit || 5000)
        )
          fail(400, "The saved script no longer fits this voice model.");
        if (
          params.voice &&
          model.voices?.length &&
          !model.voices.some((v) => v.id === params.voice)
        )
          fail(400, "The saved voice is no longer offered.");
        cost = usdUnits(
          (params.text.trim().length / 1000) *
            model.pricing.api_price *
            markupFactor(user, cfg),
        );
      } else {
        const model = ctx.models.getModel(params.model, m.kind);
        if (m.kind === "video")
          cost = Math.ceil(
            usdUnits(videoOptions(model, params).price) *
              markupFactor(user, cfg),
          );
        else {
          const refs = params.images || [];
          if (!Array.isArray(refs) || refs.length > 20)
            fail(400, "Saved reference images are not supported.");
          if (model.type === "image") {
            if (
              refs.length > 1 ||
              (refs.length && !model.capabilities?.accepts_image_url) ||
              (!refs.length && model.capabilities?.requires_image_url)
            )
              fail(
                400,
                "This model no longer supports the saved reference-image settings.",
              );
            assertPricedImageOption(model, params);
          }
          ctx.models.validateMessages(
            [
              {
                role: "user",
                content: [
                  { type: "text", text: params.prompt },
                  ...refs.map((url) => ({
                    type: "image_url",
                    image_url: { url },
                  })),
                ],
              },
            ],
            model,
          );
          const n = params.n ?? 1;
          if (!Number.isInteger(n) || n < 1 || n > 4)
            fail(400, "Saved image count is unsupported.");
          cost = Math.ceil(
            quote(
              model,
              [{ role: "user", content: params.prompt }],
              4096,
              params,
            ) * markupFactor(user, cfg),
          );
        }
      }
      return {
        media: m,
        source: origin,
        rerun: {
          available: true,
          kind: m.kind,
          params,
          credits: credits(cost),
          usd: cost / 1e7,
          referenceCount: params.images?.length || (params.image_url ? 1 : 0),
        },
      };
    } catch (e) {
      return {
        media: m,
        source: origin,
        rerun: {
          available: false,
          message: e.status
            ? e.message
            : "Saved generation settings could not be restored.",
        },
      };
    }
  }
  function signature(user, id, q) {
    return createHmac("sha256", cfg.secret)
      .update(JSON.stringify([user, id, q.id, q.expires, q.hash, q.credits]))
      .digest("hex");
  }
  async function validateReplay(req, kind) {
    if (
      req.body.libraryMediaId === undefined &&
      req.body.libraryQuote === undefined
    )
      return;
    const id = req.body.libraryMediaId,
      q = req.body.libraryQuote;
    if (
      typeof id !== "string" ||
      !q ||
      typeof q.id !== "string" ||
      !Number.isFinite(q.expires) ||
      q.expires < now() ||
      q.expires > now() + 120000 ||
      req.body.requestId !== q.id ||
      typeof q.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(q.signature)
    )
      fail(
        409,
        "Get a fresh quote before rerunning this item.",
        "stale_library_quote",
      );
    const expected = signature(req.user.id, id, q);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(q.signature)))
      fail(
        409,
        "Get a fresh quote before rerunning this item.",
        "stale_library_quote",
      );
    const result = await prepare(id, req.user);
    if (!result.rerun.available)
      fail(409, result.rerun.message, "incompatible_library_item");
    if (
      result.media.kind !== kind ||
      recipeHash(result.rerun.params) !== q.hash ||
      recipeHash(mediaRecipe(kind, req.body)) !== q.hash ||
      result.rerun.credits !== q.credits
    )
      fail(
        409,
        "The settings or price changed. Review a fresh quote.",
        "stale_library_quote",
      );
  }
  app.get(
    "/api/history/search",
    requireUser,
    limit("history-search", 60, 60000),
    (req, res) => {
      const q = String(req.query.q || "").trim(),
        offset = Number(req.query.offset || 0),
        take = Number(req.query.limit || 20);
      if (
        q.length < 2 ||
        q.length > 160 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10000 ||
        !Number.isInteger(take) ||
        take < 1 ||
        take > 50
      )
        fail(400, "Search for 2–160 characters; use a page size of 1–50.");
      const needle = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      // Projects: only chats filed in one of this account's projects (the
      // release gate asks for Projects when `project` is sent). Someone
      // else's project is not found, exactly like a missing one.
      const projects = isReleased(cfg, "projects");
      const project = req.query.project;
      if (project !== undefined) {
        if (
          typeof project !== "string" ||
          !db.prepare("SELECT 1 FROM projects WHERE id=? AND user_id=?").get(project, req.user.id)
        )
          fail(404, "Project not found.", "project_not_found");
      }
      const rows = db
        .prepare(
          `SELECT c.id,c.title,c.mode,c.updated,c.collab_id,
      (SELECT substr(m.content,1,420) FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\' ORDER BY m.created,m.rowid LIMIT 1) snippet
      ${projects ? ",(SELECT pc.project_id FROM project_chats pc WHERE pc.conversation_id=c.id AND pc.user_id=?) project_id" : ""}
      FROM conversations c WHERE c.expires IS NULL AND coalesce(c.mode,'chat') NOT IN ('private','ephemeral')
      AND ((c.collab_id IS NULL AND c.user_id=?) OR EXISTS(SELECT 1 FROM collab_members cm WHERE cm.collab_id=c.collab_id AND cm.user_id=?))
      AND (c.title LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ? ESCAPE '\\'))
      ${project !== undefined ? "AND EXISTS(SELECT 1 FROM project_chats pc WHERE pc.conversation_id=c.id AND pc.project_id=? AND pc.user_id=?)" : ""}
      ORDER BY c.updated DESC,c.id DESC LIMIT ? OFFSET ?`,
        )
        .all(
          needle,
          ...(projects ? [req.user.id] : []),
          req.user.id,
          req.user.id,
          needle,
          needle,
          ...(project !== undefined ? [project, req.user.id] : []),
          take + 1,
          offset,
        );
      res.json({
        data: rows.slice(0, take).map((r) => ({
          ...r,
          snippet:
            typeof r.snippet === "string"
              ? r.snippet.replace(/^"|"$/g, "")
              : "",
        })),
        nextOffset: rows.length > take ? offset + take : null,
      });
    },
  );
  app.get("/api/library/:id/actions", requireUser, async (req, res) => {
    const { source, rerun } = await prepare(req.params.id, req.user);
    res.json({ source, rerun });
  });
  app.post(
    "/api/library/:id/quote",
    requireUser,
    limit("library-quote", 60, 60000),
    async (req, res) => {
      const { rerun } = await prepare(req.params.id, req.user);
      if (!rerun.available)
        fail(409, rerun.message, "incompatible_library_item");
      const q = {
        id: uid("library_"),
        expires: now() + 120000,
        hash: recipeHash(rerun.params),
        credits: rerun.credits,
      };
      q.signature = signature(req.user.id, req.params.id, q);
      res.json({
        ...rerun,
        quote: q,
        body: {
          ...rerun.params,
          requestId: q.id,
          libraryMediaId: req.params.id,
          libraryQuote: q,
        },
      });
    },
  );
  return { validateReplay };
}
