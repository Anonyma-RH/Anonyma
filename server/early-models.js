import { now, transaction, callable } from "./core.js";
import { isReleased } from "./releases.js";
import { programLive, tokenChecks, earlyAccessHolder } from "./holders.js";

// Early Model Access: the NYMA Insider perk for new models. A model this
// installation hasn't seen before is open only to accounts at the Insider
// tier and up for its first EARLY_MODEL_DAYS days (default 14), then to
// everyone. Nothing is staked or locked: the tier is the Holder Program's
// current tier (currentTier in server/holders.js, with its 48-hour fresh
// check), through earlyAccessHolder, the same rule as early updates.
//
// When a model is new: model_first_seen (server/core.js) keeps when each
// catalog first listed each id. The first LIVE catalog a catalog records
// (the gateway's feed, or its saved cache) is its baseline, recorded as 0:
// already known, never early. A reference snapshot or fixture only ever
// records 0 too, so a model can only become early by appearing in a live
// refresh after the baseline. That is also what keeps this upgrade from
// restricting any model that's already public.
//
// Who sees one: the public model list (/api/models) stays the same for
// everyone, like every public surface, and marks it with earlyUntil, when
// it opens to everyone. The app offers it, tagged Early, only when the
// account's own session says it's eligible (holder.eligible, see
// src/early-models.js). Lists that are already the account's own
// (/api/audio/models, priced at its rate; /v1/models and MCP list_models,
// behind its key) leave it out unless the account is eligible. A request naming it
// is refused before anything is reserved: 403 early_model with the date it
// opens to everyone, or for a connected app the generic "unavailable"
// answer, so an outside app never learns the account's tier.
//
// It applies only while "earlymodels" is released, the Holder Program is
// live and balance checks are configured: without a way to qualify, every
// model is simply open to everyone. EARLY_MODEL_EXEMPT lists model ids
// that open to everyone at once.

const DAY = 24 * 3600000;
export const CATALOGS = ["models", "tts", "stt"];

export const earlyModelsLive = (cfg) =>
  isReleased(cfg, "earlymodels") &&
  programLive(cfg) &&
  tokenChecks(cfg) &&
  cfg.earlyModelDays > 0;
export const earlyWindowMs = (cfg) => cfg.earlyModelDays * DAY;

// Who is asking. A connected app (Connect an App's OAuth token, whose
// requests pay the standard rate and whose key has a connection) is never
// eligible, whatever the account holds. An account's own API keys follow
// the account.
export const viewerOf = (req) => ({
  user: req?.user ?? null,
  app: !!(
    req?.appConnection ||
    req?.standardRate === true ||
    req?.apiKey?.connection_id != null
  ),
});

// "2026-10-09 14:05 UTC": the minute a model opens to everyone.
export const opensText = (t) =>
  new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function createEarlyModels(db, cfg) {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO model_first_seen(catalog,id,first_seen) VALUES(?,?,?)",
  );
  const baselineOf = db.prepare(
    "SELECT taken FROM model_catalog_baselines WHERE catalog=?",
  );
  const recent = db.prepare(
    "SELECT id,first_seen FROM model_first_seen WHERE catalog=? AND first_seen>? ORDER BY first_seen,id",
  );
  let audio = null;

  // Records the ids a catalog lists. Only ids never seen before are
  // written; nothing already recorded changes.
  function record(catalog, ids, { live = false, t = now() } = {}) {
    if (!CATALOGS.includes(catalog)) throw Error("Unknown model catalog.");
    const list = [
      ...new Set(
        ids.filter(
          (id) => typeof id === "string" && id.length && id.length <= 250,
        ),
      ),
    ];
    return transaction(db, () => {
      const baseline = baselineOf.get(catalog);
      const at = live && baseline ? t : 0;
      let added = 0;
      for (const id of list)
        added += Number(insert.run(catalog, id, at).changes);
      if (live && !baseline)
        db.prepare(
          "INSERT INTO model_catalog_baselines(catalog,taken) VALUES(?,?)",
        ).run(catalog, t);
      return { added, baseline: live && !baseline, firstSeen: at };
    });
  }
  // The chat, image and video catalog (server/catalog.js): live when it came
  // from the gateway (syncCatalog) or its saved cache, not the bundled
  // reference snapshot.
  const recordCatalog = (snapshot, options = {}) =>
    record(
      "models",
      (snapshot?.data || []).map((m) => m?.id),
      { live: snapshot?.live === true, ...options },
    );
  // The speech catalog (server/audio.js): live when read from the gateway.
  function recordAudio(catalog, live, options = {}) {
    const results = ["tts", "stt"].map((kind) =>
      record(
        kind,
        (catalog?.[kind] || []).map((m) => m?.id),
        { live, ...options },
      ),
    );
    audio = catalog;
    return results;
  }

  // The ids in their early window right now, with when each opens to
  // everyone. Empty while the feature isn't in effect.
  function inWindow(catalog, t = now()) {
    if (!earlyModelsLive(cfg)) return new Map();
    const span = earlyWindowMs(cfg);
    const exempt = new Set(cfg.earlyModelExempt || []);
    return new Map(
      recent
        .all(catalog, t - span)
        .filter((r) => r.first_seen > 0 && !exempt.has(r.id))
        .map((r) => [r.id, r.first_seen + span]),
    );
  }
  const eligible = (who, t = now()) =>
    !!who && !who.app && earlyAccessHolder(cfg, who.user, t);

  // What `who` sees of one catalog: whether a model is hidden from it, and
  // for an eligible account, until when a model is early (for the tag).
  function view(who, catalog = "models", t = now()) {
    const early = inWindow(catalog, t);
    const open = early.size > 0 && eligible(who, t);
    return {
      eligible: open,
      hides: (id) => !open && early.has(id),
      earlyUntil: (id) => (open ? (early.get(id) ?? null) : null),
    };
  }

  // Refuses a request naming a model `who` can't use yet. Call it before
  // anything is reserved.
  function check(who, catalog, id, t = now()) {
    const opensAt = inWindow(catalog, t).get(id);
    if (opensAt == null || eligible(who, t)) return;
    const e = new Error(
      who?.app
        ? "This model is catalog-only or unavailable."
        : `This model is new and open to NYMA Insiders first. It opens to everyone on ${opensText(opensAt)}. Nothing was sent or charged.`,
    );
    if (who?.app) {
      e.status = 503;
      e.code = "model_unavailable";
    } else {
      e.status = 403;
      e.code = "early_model";
      e.earlyModel = { model: id, opens_at: new Date(opensAt).toISOString() };
    }
    throw e;
  }

  // Every model in early access now, the same list for everyone: what the
  // Holdings panel and the NYMA page show. Only models this installation
  // offers (callable chat, image and video models, and the speech catalog
  // last loaded).
  function list(models, t = now()) {
    const out = [];
    for (const [id, opensAt] of inWindow("models", t)) {
      const m = models.find(id);
      if (m && callable(m, cfg))
        out.push({ id, name: m.name || id, type: m.type, opensAt });
    }
    for (const kind of ["tts", "stt"])
      for (const [id, opensAt] of inWindow(kind, t)) {
        const m = (audio?.[kind] || []).find((x) => x.id === id);
        if (m)
          out.push({
            id,
            name: m.name || id,
            type: kind === "tts" ? "speech" : "transcription",
            opensAt,
          });
      }
    return out.sort(
      (a, b) => a.opensAt - b.opensAt || a.id.localeCompare(b.id),
    );
  }

  return {
    record,
    recordCatalog,
    recordAudio,
    inWindow,
    eligible,
    view,
    check,
    list,
  };
}
