import { uid, now, fail, transaction } from "../core.js";
import { isReleased } from "../releases.js";
import { findSeedPhrase } from "../../src/seed-guard.js";
import {
  MAX_PROJECTS,
  MAX_PINNED,
  MAX_PROJECT_NAME,
  MAX_PROJECT_INSTRUCTIONS,
  PROJECT_COLORS,
  PROJECT_PRIVACY,
  DEFAULT_COLOR,
} from "../../src/projects.js";

const PROJECT_SEED_MESSAGE =
  "This looks like a wallet seed phrase. A project's instructions are saved and sent with every chat in it, so ANONYMA won't save one. Remove it to continue.";

// A project's pinned files: the account's own unexpired saved uploads,
// oldest pin first. Only metadata: the text is fetched from /api/files when
// a new chat attaches it.
const pinnedFiles = (db, project) =>
  db
    .prepare(
      `SELECT u.id,u.name,u.bytes,u.kind,u.truncated,length(u.text) characters,u.expires
       FROM project_files f JOIN uploads u ON u.id=f.upload_id
       WHERE f.project_id=? AND u.user_id=f.user_id AND u.expires>? ORDER BY f.added,f.rowid`,
    )
    .all(project, now())
    .map((f) => ({ ...f, truncated: !!f.truncated }));
// Saved chats and Symposium runs filed in a project, newest first. An
// auto-deleted one is gone at once, as everywhere else.
const filedChats = (db, project, user) =>
  db
    .prepare(
      `SELECT c.id,c.title,c.mode,c.created,c.updated,c.expires FROM project_chats pc
       JOIN conversations c ON c.id=pc.conversation_id
       WHERE pc.project_id=? AND pc.user_id=? AND c.user_id=pc.user_id AND c.collab_id IS NULL
         AND (c.expires IS NULL OR c.expires>=?)
       ORDER BY c.updated DESC,c.rowid DESC`,
    )
    .all(project, user, now());
const view = (db, row, detail = false) => {
  const chats = filedChats(db, row.id, row.user_id);
  const saved = chats.filter((c) => c.mode !== "symposium"),
    runs = chats.filter((c) => c.mode === "symposium");
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    instructions: row.instructions,
    privacy: row.starts,
    model: row.model,
    files: pinnedFiles(db, row.id),
    chat_count: saved.length,
    run_count: runs.length,
    created: row.created,
    updated: row.updated,
    ...(detail ? { chats: saved, runs } : {}),
  };
};
export const listProjects = (db, user) =>
  db
    .prepare("SELECT * FROM projects WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((row) => view(db, row));
// For the account export: each project with its settings, the saved chats
// and Symposium runs filed in it (by id; their messages are exported with
// the conversations) and its pinned files (by id and name).
export const exportProjects = (db, user) =>
  db
    .prepare("SELECT * FROM projects WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((row) => {
      const v = view(db, row, true);
      return {
        id: v.id,
        name: v.name,
        color: v.color,
        instructions: v.instructions,
        privacy: v.privacy,
        model: v.model,
        created: v.created,
        updated: v.updated,
        conversations: [...v.chats, ...v.runs].map((c) => c.id),
        pinned_files: v.files.map((f) => ({ id: f.id, name: f.name })),
      };
    });

// Projects: named, colour-coded folders for an account's saved chats with
// shared context (src/projects.js). The release gate refuses these routes
// while the update is unreleased, and asks for Files & Reusable Uploads when
// files are pinned and for the update behind a default privacy mode.
export function projectRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("projects-read", 240, 60000);
  const write = limit("projects", 240, 3600000);
  const owned = (id, user) => {
    const row =
      typeof id === "string" &&
      db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(id, user);
    if (!row) fail(404, "Project not found.", "project_not_found");
    return row;
  };
  // A project's fields from a request body; `existing` keeps what a PATCH
  // leaves out.
  function input(body, user, existing = null) {
    const has = (k) => Object.hasOwn(body || {}, k);
    const need = (k) => !existing || has(k);
    const next = existing
      ? {
          name: existing.name,
          color: existing.color,
          instructions: existing.instructions,
          privacy: existing.starts,
          model: existing.model,
        }
      : { color: DEFAULT_COLOR, instructions: "", privacy: "normal", model: null };
    if (need("name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > MAX_PROJECT_NAME)
        fail(400, `Give the project a name of 1–${MAX_PROJECT_NAME} characters.`, "invalid_project");
      next.name = name;
    }
    if (has("color")) {
      if (!PROJECT_COLORS.some((c) => c.id === body.color))
        fail(400, "Choose one of the project colors.", "invalid_project");
      next.color = body.color;
    }
    if (has("instructions")) {
      if (typeof body.instructions !== "string" || body.instructions.length > MAX_PROJECT_INSTRUCTIONS)
        fail(400, `Project instructions cannot exceed ${MAX_PROJECT_INSTRUCTIONS} characters.`, "invalid_project");
      // Seed Guard: project instructions go with every chat in the project,
      // so a seed phrase is never saved in them, with no override.
      if (isReleased(cfg, "seedguard") && findSeedPhrase(body.instructions))
        fail(400, PROJECT_SEED_MESSAGE, "seed_phrase_blocked");
      next.instructions = body.instructions;
    }
    if (has("privacy")) {
      if (!PROJECT_PRIVACY.includes(body.privacy))
        fail(400, "Choose Normal, Off the record or Private Mode.", "invalid_project");
      next.privacy = body.privacy;
    }
    if (has("model")) {
      if (body.model === null || body.model === "") next.model = null;
      else {
        const m = typeof body.model === "string" && body.model.length <= 200 && ctx.models.find(body.model);
        if (
          !m ||
          m.type !== "chat" ||
          (m.architecture?.output_modalities || []).includes("image")
        )
          fail(400, "Choose a chat model, or no default.", "invalid_model");
        next.model = m.id;
      }
    }
    let files = null;
    if (has("files")) {
      if (
        !Array.isArray(body.files) ||
        body.files.some((f) => typeof f !== "string") ||
        new Set(body.files).size !== body.files.length
      )
        fail(400, "files must be a list of saved file ids.", "invalid_project");
      if (body.files.length > MAX_PINNED)
        fail(400, `Pin up to ${MAX_PINNED} files to a project.`, "project_files_limit");
      files = body.files.map((id) => {
        const f = db
          .prepare("SELECT id,kind FROM uploads WHERE id=? AND user_id=? AND expires>?")
          .get(id, user, now());
        if (!f) fail(404, "File not found.");
        if (f.kind !== "document")
          fail(400, "Pin saved text and Office files. Audio needs transcribing first.", "invalid_project");
        return f.id;
      });
    }
    return { next, files };
  }
  const pin = (project, user, files) => {
    db.prepare("DELETE FROM project_files WHERE project_id=?").run(project);
    const insert = db.prepare(
      "INSERT INTO project_files(project_id,upload_id,user_id,added) VALUES(?,?,?,?)",
    );
    files.forEach((f, i) => insert.run(project, f, user, now() + i));
  };

  app.get("/api/projects", requireUser, read, (req, res) =>
    res.json({
      projects: listProjects(db, req.user.id),
      max_projects: MAX_PROJECTS,
      max_pinned: MAX_PINNED,
    }),
  );
  app.post("/api/projects", requireUser, write, (req, res) => {
    const { next, files } = input(req.body || {}, req.user.id);
    const id = uid("prj_");
    transaction(db, () => {
      const n = db
        .prepare("SELECT COUNT(*) n FROM projects WHERE user_id=?")
        .get(req.user.id).n;
      if (n >= MAX_PROJECTS)
        fail(
          409,
          `You can have up to ${MAX_PROJECTS} projects. Delete one to add another.`,
          "project_limit",
        );
      const at = now();
      db.prepare(
        "INSERT INTO projects(id,user_id,name,color,instructions,starts,model,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(id, req.user.id, next.name, next.color, next.instructions, next.privacy, next.model, at, at);
      if (files) pin(id, req.user.id, files);
    });
    res.status(201).json(view(db, owned(id, req.user.id), true));
  });
  app.get("/api/projects/:id", requireUser, read, (req, res) =>
    res.json(view(db, owned(req.params.id, req.user.id), true)),
  );
  app.patch("/api/projects/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const { next, files } = input(req.body || {}, req.user.id, row);
    transaction(db, () => {
      db.prepare(
        "UPDATE projects SET name=?,color=?,instructions=?,starts=?,model=?,updated=? WHERE id=? AND user_id=?",
      ).run(next.name, next.color, next.instructions, next.privacy, next.model, now(), row.id, req.user.id);
      if (files) pin(row.id, req.user.id, files);
    });
    res.json(view(db, owned(row.id, req.user.id), true));
  });
  // Deleting a project keeps its chats: they go back to the chat list.
  app.delete("/api/projects/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    db.prepare("DELETE FROM projects WHERE id=? AND user_id=?").run(row.id, req.user.id);
    res.json({ ok: true });
  });
  // Move a saved personal chat (or Symposium run) into this project, from no
  // project or another one. A collab's shared chats stay in their collab.
  app.post("/api/projects/:id/chats", requireUser, write, (req, res) => {
    const project = owned(req.params.id, req.user.id);
    const id = req.body?.conversationId;
    if (typeof id !== "string" || !id)
      fail(400, "conversationId must be a conversation id.", "invalid_request");
    const c = ctx.conversations.accessConversation(id, req.user.id);
    if (c.collab_id || c.user_id !== req.user.id)
      fail(400, "A collab's shared chats stay in the collab; they can't join a project.", "invalid_request");
    db.prepare(
      `INSERT INTO project_chats(conversation_id,project_id,user_id,added) VALUES(?,?,?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET project_id=excluded.project_id,added=excluded.added`,
    ).run(c.id, project.id, req.user.id, now());
    res.json({ ok: true, conversation_id: c.id, project_id: project.id });
  });
  // Take a chat out of this project; it stays saved, in no project.
  app.delete("/api/projects/:id/chats/:conversation", requireUser, write, (req, res) => {
    const project = owned(req.params.id, req.user.id);
    const r = db
      .prepare("DELETE FROM project_chats WHERE conversation_id=? AND project_id=? AND user_id=?")
      .run(req.params.conversation, project.id, req.user.id);
    if (!r.changes) fail(404, "This chat isn't in the project.", "not_in_project");
    res.json({ ok: true });
  });

  return {
    // The project a new chat is filed in: the account's own, checked before
    // anything is reserved. Only saved chats are filed (see runChat).
    forChat(user, id) {
      if (typeof id !== "string" || !id)
        fail(400, "project must be a project id.", "invalid_request");
      return owned(id, user);
    },
    // Files a conversation the chat just created.
    file(conversation, project, user) {
      db.prepare(
        "INSERT INTO project_chats(conversation_id,project_id,user_id,added) VALUES(?,?,?,?)",
      ).run(conversation, project, user, now());
    },
  };
}
