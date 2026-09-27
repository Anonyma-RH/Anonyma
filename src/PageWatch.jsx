import React, { useEffect, useRef, useState } from "react";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import remarkGfm from "remark-gfm";
import { Button, Icon, Notice, Empty, CopyButton } from "./ui.jsx";
import SignedReceipt from "./SignedReceipt.jsx";
import { api, isReleased } from "./lib.js";
import { HINT_LIMIT, MAX_WATCHES, shortUrl } from "./page-watch.js";
import "./page-watch.css";

// Page Watch, the page's side: the watches (a tab of the Routines page),
// their reports in the Routines inbox, and the workspace badge for reports
// not seen yet. The checks run on the server (server/page-watch.js). Links,
// hints, summaries and model names are the user's, the page's or a model's
// words, so they're marked data-i18n="off".

const fmtCredits = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
const when = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const kb = (bytes) => `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
export const EVERY_LABEL = {
  "6h": "Every 6 hours",
  daily: "Every day",
  weekly: "Every week",
};
const LAST_STATUS = {
  baseline: "First version saved",
  unchanged: "No change",
  changed: "Changed",
  not_relevant: "Changed, but not what you asked about",
  refused: "Changed; the summary was refused",
  failed: "Changed; the summary failed",
  unreadable: "Changed; the model's answer couldn't be read",
  fetch_failed: "Couldn't read the page",
  paused: "Paused",
};
const REPORT_STATUS = {
  changed: "Page changed",
  refused: "Refused",
  failed: "Failed",
  unreadable: "No summary",
  paused: "Paused",
};
// Why a page couldn't be read, from the fetcher's fixed codes.
const READ_REASONS = {
  link_unreachable: "Couldn't reach the page.",
  link_timeout: "The page took longer than 10 seconds to load.",
  link_status: "The site didn't return the page.",
  link_blocked: "The link now points to a private or local address, so it isn't read.",
  link_type: "The page is no longer a web page or plain text.",
  link_too_large: "The page is larger than 5 MB.",
  link_redirects: "The link redirected more than 3 times.",
  link_unreadable: "No readable text was found on the page.",
};
const readReason = (code) => READ_REASONS[code] || "The page couldn't be read.";
// Why a change has no summary, in the page's own words where it knows the code.
const REASONS = {
  insufficient_credits: "Your balance couldn't cover a summary. Nothing was charged.",
  watch_budget: "This watch's monthly budget couldn't cover a summary. Nothing was charged.",
  spending_limit: "Your spending limits couldn't cover a summary. Nothing was charged.",
  model_not_found: "This watch's model isn't available right now. Nothing was charged.",
  model_unavailable: "This watch's model isn't available right now. Nothing was charged.",
  unpriced_model: "This watch's model isn't available right now. Nothing was charged.",
  private_model_required: "Private models only is on, and this model isn't a zero-data-retention model. Nothing was charged.",
  private_unavailable: "Private Mode isn't available right now. Nothing was charged.",
  payment_reconciliation_pending: "Spending is paused while a payment is checked. Nothing was charged.",
  seed_phrase_blocked: "The hint looks like a wallet seed phrase, so nothing was sent. Nothing was charged.",
  length: "The model ran out of room before it finished, so no summary is shown. The charge stands; nothing was retried.",
  unreadable: "The model's answer couldn't be read, so no summary is shown.",
};
const reportReason = (r) =>
  r.status === "paused"
    ? `Paused after 5 failed checks in a row. ${readReason(r.code)} Switch the watch back on to try again.`
    : REASONS[r.code] || r.message || "No summary was made.";

// The sample account's watches and reports (?demo=1): nothing is fetched.
export function demoWatchState() {
  const at = Date.now();
  const hour = 3600000;
  const watches = [
    {
      id: "demo-watch-pricing",
      url: "https://www.example.com/pricing",
      site: "www.example.com",
      hint: "the price changes",
      model: "demo-model",
      private_only: false,
      every: "6h",
      monthly_budget_credits: 200,
      enabled: true,
      paused: null,
      failures: 0,
      next_check_at: at + 4 * hour,
      running: false,
      last_check_at: at - 2 * hour,
      last_status: "changed",
      last_change_at: at - 2 * hour,
      kept: { at: at - 2 * hour, bytes: 14540, truncated: false },
      month: { spent: 2.6, held: 0, remaining: 197.4 },
    },
    {
      id: "demo-watch-status",
      url: "https://status.example.org/",
      site: "status.example.org",
      hint: null,
      model: "demo-model",
      private_only: true,
      every: "daily",
      monthly_budget_credits: 100,
      enabled: true,
      paused: null,
      failures: 0,
      next_check_at: at + 15 * hour,
      running: false,
      last_check_at: at - 9 * hour,
      last_status: "unchanged",
      last_change_at: null,
      kept: { at: at - 33 * hour, bytes: 3120, truncated: false },
      month: { spent: 0, held: 0, remaining: 100 },
    },
  ];
  const reports = [
    {
      id: "demo-report-1",
      watch_id: "demo-watch-pricing",
      url: "https://www.example.com/pricing",
      site: "www.example.com",
      checked_at: at - 2 * hour,
      status: "changed",
      summary:
        "- **Sample:** a prepared demo summary, not a model's.\n- Pro plan: **$39 a month** (was $49).\n- A new yearly option: $390 a year.",
      model: "demo-model",
      private_only: false,
      hint: "the price changes",
      credits_charged: 1.3,
      added: 2,
      removed: 1,
      flagged: 0,
      seen: false,
      signed_receipt: null,
    },
  ];
  return { watches, reports };
}

export function blankWatch(models) {
  return {
    id: null,
    url: "",
    every: "daily",
    hint: "",
    model: models[0]?.id || "",
    private_only: false,
    monthly_budget_credits: "200",
    enabled: true,
  };
}
export const watchDraftOf = (w) => ({
  id: w.id,
  url: w.url,
  every: w.every,
  hint: w.hint || "",
  model: w.model,
  private_only: w.private_only,
  monthly_budget_credits: String(w.monthly_budget_credits),
  enabled: w.enabled,
});
export const watchBodyOf = (d) => ({
  ...(d.id ? {} : { url: d.url.trim() }),
  every: d.every,
  hint: d.hint.trim() || null,
  model: d.model,
  private_only: d.private_only,
  monthly_budget_credits: Number(d.monthly_budget_credits),
  enabled: d.enabled,
});

function Switch({ checked, onChange, disabled, title, detail }) {
  return (
    <label className={"routine-switch" + (disabled ? " disabled" : "")}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="routine-switch-track" aria-hidden="true" />
      <span>
        <b>{title}</b>
        {detail && <small>{detail}</small>}
      </span>
    </label>
  );
}
function ConfirmDelete({ busy, onConfirm, onCancel }) {
  return (
    <div className="routine-confirm" role="group" aria-label="Delete watch">
      <span>Stop watching this page? Its kept copy and its reports are deleted. This can't be undone.</span>
      <button type="button" className="small-button danger" onClick={onConfirm} disabled={busy}>
        Delete
      </button>
      <button type="button" className="small-button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

// The most one summary can cost with the chosen model (the server's worst
// case), fetched as the model changes.
function useEstimate(model, enabled) {
  const [estimate, setEstimate] = useState(null);
  useEffect(() => {
    if (!enabled || !model) return setEstimate(null);
    let gone = false;
    const timer = setTimeout(() => {
      api("/api/watches/estimate?model=" + encodeURIComponent(model))
        .then((e) => !gone && setEstimate(e))
        .catch(() => !gone && setEstimate(null));
    }, 250);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [model, enabled]);
  return estimate;
}

export function WatchEditor({ draft, setDraft, models, config, busy, error, onSave, onCancel, onDelete, live }) {
  const [confirming, setConfirming] = useState(false);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const choices = models.filter((m) => !draft.private_only || m.private);
  const privateLive = isReleased(config, "private");
  const estimate = useEstimate(draft.model, live);
  return (
    <form
      className="routine-editor watch-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="routine-editor-head">
        <h2>{draft.id ? "Edit watch" : "Watch a page"}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="routine-editor-grid">
        <div className="routine-editor-col">
          <label className="routine-field">
            <span>Page link</span>
            <input
              type="url"
              inputMode="url"
              value={draft.url}
              placeholder="https://example.com/pricing"
              onChange={(e) => set("url")(e.target.value)}
              disabled={!!draft.id}
              required
              data-i18n="off"
            />
          </label>
          {!draft.id && (
            <p className="routine-help watch-first">
              The page is read once when you save, to keep a first version to
              compare with. Web pages and plain text only; not PDFs.
            </p>
          )}
          <fieldset className="routine-field">
            <legend>How often</legend>
            <div className="routine-repeat">
              {Object.entries(EVERY_LABEL).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={draft.every === id}
                  className={draft.every === id ? "active" : ""}
                  onClick={() => set("every")(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="routine-field">
            <span>Only tell me if… (optional)</span>
            <input
              value={draft.hint}
              maxLength={HINT_LIMIT}
              placeholder="the price changes"
              onChange={(e) => set("hint")(e.target.value)}
            />
          </label>
          <p className="routine-help">
            With a hint, the model first decides whether a change matters to
            you. You're told only when it does; that check still costs a
            summary.
          </p>
          <p className="routine-veil-note">
            <Icon name="eye" size={15} />
            <span>
              The model sees only the lines that changed, a little context
              around them, the site's name and your hint: not the whole page,
              not the link. Veil can't mask the hint, so it's sent as written.
            </span>
          </p>
        </div>
        <div className="routine-editor-col">
          <label className="routine-field">
            <span>Model for summaries</span>
            <select
              value={choices.some((m) => m.id === draft.model) ? draft.model : ""}
              onChange={(e) => set("model")(e.target.value)}
              required
            >
              {!choices.some((m) => m.id === draft.model) && <option value="">Choose a model</option>}
              {choices.map((m) => (
                <option key={m.id} value={m.id} data-i18n="off">
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {privateLive && (
            <Switch
              checked={draft.private_only}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  private_only: v,
                  model:
                    v && !models.some((m) => m.id === d.model && m.private)
                      ? models.find((m) => m.private)?.id || ""
                      : d.model,
                }))
              }
              title="Private models only"
              detail="Zero-data-retention models only, never the backup gateway. Reports are still kept in your inbox."
            />
          )}
          <label className="routine-field">
            <span>Monthly budget (credits)</span>
            <input
              type="number"
              min="0.0001"
              step="any"
              inputMode="decimal"
              value={draft.monthly_budget_credits}
              onChange={(e) => set("monthly_budget_credits")(e.target.value)}
              required
            />
          </label>
          <div className="watch-cost">
            <p>
              <Icon name="coins" size={15} />
              <span>
                {estimate
                  ? `A summary costs at most ${fmtCredits(estimate.max_credits)} credits with this model, and usually far less: you pay only what it uses.`
                  : "A summary is billed like a message: you pay only what it uses."}
              </span>
            </p>
            <p>
              <Icon name="check" size={15} />
              <span>Checking is free. No real change, no charge.</span>
            </p>
          </div>
          <p className="routine-help">
            A summary is refused, and nothing is charged, when your balance,
            your spending limits or this watch's monthly budget can't cover it.
            The budget resets each calendar month (UTC).
          </p>
          <Switch
            checked={draft.enabled}
            onChange={set("enabled")}
            title={draft.enabled ? "On" : "Off"}
            detail={draft.enabled ? "Checked on schedule by our server." : "Saved, but not checked until you switch it on."}
          />
        </div>
      </div>
      <p className="watch-honest">
        <Icon name="shield" size={15} />
        <span>
          ANONYMA keeps the last version of the page to spot changes. Delete
          the watch to delete it.
        </span>
      </p>
      {error && <Notice type="error">{error}</Notice>}
      <div className="routine-editor-actions">
        <Button type="submit" disabled={busy}>
          {draft.id ? "Save watch" : busy ? "Reading the page…" : "Start watching"}
        </Button>
        <Button type="button" secondary onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {draft.id && !confirming && (
          <button type="button" className="routine-delete" onClick={() => setConfirming(true)} disabled={busy}>
            <Icon name="delete" size={15} />
            Delete watch
          </button>
        )}
      </div>
      {confirming && <ConfirmDelete busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />}
    </form>
  );
}

export function WatchCard({ w, modelName, busy, onEdit, onToggle, onDelete, onReports }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <article className={"routine-card watch-card" + (w.enabled ? "" : " off")}>
      <div className="routine-card-head">
        <h3>
          <a href={w.url} target="_blank" rel="noreferrer noopener" title="Open page">
            <span data-i18n="off">{shortUrl(w.url)}</span>
            <Icon name="external" size={13} />
          </a>
        </h3>
        <Switch checked={w.enabled} disabled={busy} onChange={onToggle} title={w.enabled ? "On" : "Off"} />
      </div>
      <p className="routine-schedule">
        <Icon name="watch" size={14} />
        <span>{EVERY_LABEL[w.every]}</span>
      </p>
      {w.hint ? (
        <p className="watch-hint">
          <span>Only tell me if:</span> <q data-i18n="off">{w.hint}</q>
        </p>
      ) : (
        <p className="watch-hint">Tells you about every real change.</p>
      )}
      <div className="routine-tags">
        <span className="routine-tag" data-i18n="off">
          {modelName}
        </span>
        {w.private_only && <span className="routine-tag">Private models only</span>}
        {w.paused && <span className="routine-tag paused">Paused</span>}
        {w.running && <span className="routine-tag live">Checking now</span>}
      </div>
      {w.paused === "failures" && (
        <p className="watch-paused">
          {`Paused after 5 failed checks in a row. ${readReason(w.last_code)} Switch it back on to try again.`}
        </p>
      )}
      <dl className="routine-facts">
        <div>
          <dt>Last check</dt>
          <dd>{w.last_check_at ? when(w.last_check_at) : "Not yet"}</dd>
        </div>
        {w.last_check_at && (
          <div>
            <dt>Result</dt>
            <dd>{LAST_STATUS[w.last_status] || "Checked"}</dd>
          </div>
        )}
        <div>
          <dt>Last change</dt>
          <dd>{w.last_change_at ? when(w.last_change_at) : "None yet"}</dd>
        </div>
        <div>
          <dt>Next check</dt>
          <dd>{w.enabled && w.next_check_at ? when(w.next_check_at) : "Off"}</dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd>{`${fmtCredits(w.month.spent)} of ${fmtCredits(w.monthly_budget_credits)} credits spent this month`}</dd>
        </div>
      </dl>
      <div
        className="routine-bar"
        role="img"
        aria-label={`${fmtCredits(w.month.spent)} of ${fmtCredits(w.monthly_budget_credits)} credits spent this month`}
      >
        <div style={{ width: Math.min(100, (w.month.spent / w.monthly_budget_credits) * 100) + "%" }} />
      </div>
      {w.kept && (
        <p className="watch-kept">
          <Icon name="file" size={13} />
          <span>{`Kept: the last version of this page, ${kb(w.kept.bytes)}, from ${when(w.kept.at)}.`}</span>
        </p>
      )}
      <div className="routine-actions">
        <button type="button" className="small-button" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button type="button" className="small-button" onClick={onReports}>
          View reports
        </button>
        <button type="button" className="small-button" onClick={() => setConfirming(true)} disabled={busy || w.running || confirming}>
          Delete
        </button>
      </div>
      {confirming && <ConfirmDelete busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />}
    </article>
  );
}

// One report in the Routines inbox. `markdown`: the summary's markdown
// components (Injection Shield's image and link guards when it's on).
export function WatchReportCard({ report: r, modelName, onDelete, busy, markdown, fresh }) {
  return (
    <article className={"run-card watch-report " + r.status}>
      <div className="run-head">
        <span className={"run-status " + (r.status === "changed" ? "changed" : r.status === "unreadable" ? "refused" : r.status === "paused" ? "failed" : r.status)}>
          {REPORT_STATUS[r.status]}
        </span>
        <b data-i18n="off">{shortUrl(r.url)}</b>
        {fresh && <span className="watch-new">Unread</span>}
        <time dateTime={new Date(r.checked_at).toISOString()}>{when(r.checked_at)}</time>
        <span className="run-credits">{`${fmtCredits(r.credits_charged)} credits`}</span>
      </div>
      <p className="run-meta">
        <span className="watch-kind">
          <Icon name="watch" size={12} />
          Page Watch
        </span>
        {r.model && (
          <span className="run-model" data-i18n="off">
            {modelName}
          </span>
        )}
        {r.hint && (
          <span>
            Only tell me if: <q data-i18n="off">{r.hint}</q>
          </span>
        )}
        {r.private_only && <span>Private models only</span>}
        {r.status === "changed" && r.added != null && (
          <span>{`${r.added} lines added · ${r.removed} removed`}</span>
        )}
      </p>
      {r.status === "changed" ? (
        <>
          <div className="run-answer" data-i18n="off">
            <ReplyMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
              {r.summary || ""}
            </ReplyMarkdown>
          </div>
          {r.finish_reason === "length" && (
            <p className="run-note">The summary reached its length limit and may be cut short.</p>
          )}
        </>
      ) : (
        <p className="run-reason">{reportReason(r)}</p>
      )}
      {r.flagged > 0 && (
        <p className="watch-flagged">
          <Icon name="shield" size={14} />
          <span>
            {r.flagged === 1
              ? "Injection Shield: the new text had 1 instruction-like phrase. It was sent to the model as data only."
              : `Injection Shield: the new text had ${r.flagged} instruction-like phrases. They were sent to the model as data only.`}
          </span>
        </p>
      )}
      <div className="run-actions">
        {r.signed_receipt && <SignedReceipt signedReceipt={r.signed_receipt} />}
        {r.status === "changed" && r.summary && <CopyButton text={r.summary} label="Copy summary" />}
        {r.url && (
          <a className="small-button" href={r.url} target="_blank" rel="noreferrer noopener">
            Open page
            <Icon name="external" size={12} />
          </a>
        )}
        <button type="button" className="small-button" onClick={onDelete} disabled={busy}>
          <Icon name="delete" size={14} />
          Delete
        </button>
      </div>
    </article>
  );
}

// The Page Watch tab of the Routines page.
export function WatchesTab({ demo, live, models, config, watches, setWatches, reload, onReports, onRemoved, setError, nameOf }) {
  const [draft, setDraft] = useState(null),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const atLimit = watches.length >= MAX_WATCHES;
  function open(w) {
    setFormError("");
    setDraft(w ? watchDraftOf(w) : blankWatch(models));
  }
  async function save() {
    setFormError("");
    const body = watchBodyOf(draft);
    if (demo) {
      const w = {
        ...(watches.find((x) => x.id === draft.id) || {
          id: "demo-watch-" + Date.now(),
          url: body.url,
          site: (() => {
            try {
              return new URL(body.url).hostname;
            } catch {
              return "";
            }
          })(),
          paused: null,
          failures: 0,
          running: false,
          last_check_at: Date.now(),
          last_status: "baseline",
          last_change_at: null,
          kept: { at: Date.now(), bytes: 9200, truncated: false },
          month: { spent: 0, held: 0, remaining: body.monthly_budget_credits },
        }),
        ...body,
        next_check_at: body.enabled ? Date.now() + { "6h": 6, daily: 24, weekly: 168 }[body.every] * 3600000 : null,
      };
      setWatches((list) => (draft.id ? list.map((x) => (x.id === draft.id ? w : x)) : [...list, w]));
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await api(draft.id ? "/api/watches/" + draft.id : "/api/watches", {
        method: draft.id ? "PATCH" : "POST",
        body,
      });
      setDraft(null);
      await reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(w, enabled) {
    if (demo) {
      setWatches((list) => list.map((x) => (x.id === w.id ? { ...x, enabled, paused: enabled ? null : x.paused } : x)));
      return;
    }
    setBusy(true);
    try {
      await api("/api/watches/" + w.id, { method: "PATCH", body: { enabled } });
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(w) {
    if (!w) return;
    if (demo) {
      setWatches((list) => list.filter((x) => x.id !== w.id));
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await api("/api/watches/" + w.id, { method: "DELETE" });
      setDraft(null);
      onRemoved?.(w.id);
      await reload();
    } catch (e) {
      setError(e.message);
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="watches-tab">
      <div className="watches-intro">
        <div>
          <h2>Page Watch</h2>
          <p>
            Paste a link and choose how often. Our server checks the page, not
            your browser: no cookies, no referrer, never your IP. When it
            really changes, you're told what changed, here in your inbox.
          </p>
        </div>
        {!draft && (
          <Button type="button" onClick={() => open(null)} disabled={atLimit || busy}>
            Watch a page <Icon name="plus" size={16} />
          </Button>
        )}
      </div>
      {atLimit && !draft && (
        <p className="routine-help">You watch the most pages an account can. Delete a watch to add another.</p>
      )}
      {draft && (
        <WatchEditor
          draft={draft}
          setDraft={setDraft}
          models={models}
          config={config}
          busy={busy}
          error={formError}
          live={live}
          onSave={save}
          onCancel={() => setDraft(null)}
          onDelete={() => remove(watches.find((w) => w.id === draft.id))}
        />
      )}
      {watches.length ? (
        <div className="routine-grid">
          {watches.map((w) => (
            <WatchCard
              key={w.id}
              w={w}
              modelName={nameOf(w.model)}
              busy={busy}
              onEdit={() => open(w)}
              onToggle={(v) => toggle(w, v)}
              onDelete={() => remove(w)}
              onReports={() => onReports(w.id)}
            />
          ))}
        </div>
      ) : (
        !draft && (
          <Empty icon="watch" title="No pages watched yet.">
            Watch a pricing page, a changelog, a job board or a policy, and
            hear when it changes.
          </Empty>
        )
      )}
    </div>
  );
}

// The workspace badge: how many Page Watch reports are waiting in the inbox.
export const WATCHES_SEEN_EVENT = "anonyma:watches-seen";
export function WatchBadge({ enabled }) {
  const [count, setCount] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  useEffect(() => {
    if (!enabled) return setCount(0);
    const load = () =>
      document.visibilityState === "visible" &&
      api("/api/watches/unseen")
        .then((r) => mounted.current && setCount(r.count || 0))
        .catch(() => {});
    load();
    const timer = setInterval(load, 60000);
    const seen = () => setCount(0);
    window.addEventListener(WATCHES_SEEN_EVENT, seen);
    return () => {
      clearInterval(timer);
      window.removeEventListener(WATCHES_SEEN_EVENT, seen);
    };
  }, [enabled]);
  if (!enabled || !count) return null;
  return (
    <span className="nav-badge" aria-label={count === 1 ? "1 new page change" : `${count} new page changes`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
// Marks the reports shown as seen, and clears the badge.
export async function markWatchesSeen(before) {
  try {
    await api("/api/watches/seen", { method: "POST", body: { before } });
    window.dispatchEvent(new Event(WATCHES_SEEN_EVENT));
  } catch {}
}
