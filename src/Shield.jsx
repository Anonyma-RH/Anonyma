import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Icon, Modal } from "./ui.jsx";
import { isReleased } from "./lib.js";
import { useLanguage, loadDictionary, t } from "./i18n.js";
import {
  CATEGORIES,
  excerpt,
  namesHost,
  remoteTarget,
  shieldSummary,
  summaryText,
} from "./shield.js";
import "./shield.css";

// Injection Shield (update "shield"). Browser only: the checks in
// src/shield.js run in this tab, and nothing about a finding is sent, logged
// or stored. On by default once released, with a per-browser switch in
// Account settings.
export const shieldReleased = (config) => isReleased(config, "shield");

const KEY = "anonyma.shield";
const listeners = new Set();
let cached;
export function getShieldPref() {
  if (cached === undefined) {
    try {
      cached = globalThis.localStorage?.getItem(KEY) !== "off";
    } catch {
      cached = true;
    }
  }
  return cached;
}
export function setShieldPref(on) {
  cached = !!on;
  try {
    if (on) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, "off");
  } catch {}
  listeners.forEach((fn) => fn());
}
function subscribe(fn) {
  listeners.add(fn);
  const onStorage = (e) => {
    if (e.key !== KEY) return;
    cached = undefined;
    fn();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(fn);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
export const useShieldPref = () => useSyncExternalStore(subscribe, getShieldPref, () => true);
// Released and switched on in this browser.
export function useShieldLive(config) {
  const on = useShieldPref();
  return shieldReleased(config) && on;
}

const HONEST = "Shield catches known tricks. It can't guarantee a document is safe.";
const LOCAL = "Checked in this browser. Nothing about it is sent or saved.";

// --- Part A: the chip, the panel and the paste notice ---------------------
// The line under an attachment: "Shield · 2 hidden instructions · 31
// invisible characters", or "nothing found". Opens the panel.
export function ShieldChip({ result, asData = false, onOpen }) {
  const summary = shieldSummary(result);
  return (
    <button
      type="button"
      className={"shield-chip" + (summary.clear ? "" : " found")}
      onClick={onOpen}
      aria-haspopup="dialog"
    >
      <span className="shield-tile" aria-hidden="true">
        <Icon name="shield" size={11} />
      </span>
      <span className="shield-chip-label">Shield</span>
      <span className="shield-chip-text">{summaryText(summary)}</span>
      {asData && <span className="shield-chip-data">Sent as data</span>}
    </button>
  );
}

// On a saved message whose documents went with the data notice.
export function SentAsDataTag() {
  return (
    <span className="shield-data-tag" title="These files were sent with a note that their contents are data, not instructions.">
      <Icon name="shield" size={11} />
      Sent as data
    </span>
  );
}

const WHERE = {
  tag: "Spelled out in invisible tag characters",
  variation: "Hidden in variation selectors",
  comment: "Inside an HTML comment",
  style: "Inside text hidden with CSS",
};
const INVISIBLE = {
  zeroWidth: "Zero-width characters",
  bidi: "Text-direction controls",
  tag: "Unicode tag characters",
  variation: "Variation-selector runs",
};
const HIDDEN = {
  comment: "HTML comment",
  style: "Hidden with CSS",
  tiny: "Text too small to see",
  offpage: "Text off the page",
  vanish: "Marked hidden in Word",
  white: "White text",
};

// Text around a finding, with the finding marked and invisible characters
// shown as markers. Document content, so never translated.
function Excerpt({ text, start, end }) {
  const { lead, tail, parts } = excerpt(text, start, end);
  return (
    <p className="shield-excerpt" data-i18n="off">
      {lead && "…"}
      {parts.map((p, i) =>
        p.hidden ? (
          <span key={i} className={"shield-invisible" + (p.mark ? " in-mark" : "")} title="Invisible characters">
            {"⟨" + p.hidden + "⟩"}
          </span>
        ) : p.mark ? (
          <mark key={i}>{p.text}</mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
      {tail && "…"}
    </p>
  );
}

const SHOWN = 25;
// The findings for one attachment (or a paste), and its choices. `prefs` is
// { keepInvisible, removeFlagged } for this item; `asData` covers every
// attachment in the message. A paste has no choices here: its invisible
// characters were already taken out, and its actions are on the notice.
export function ShieldPanel({
  name,
  result,
  prefs = {},
  onPrefs,
  asData,
  onAsData,
  onClose,
  paste = false,
}) {
  const summary = shieldSummary(result);
  const text = result?.text || "";
  const { invisible, instructions, hidden } = result || {};
  const examples = (invisible?.runs || []).slice(0, 3);
  return (
    <Modal title="Injection Shield" onClose={onClose}>
      <div className="shield-panel">
        {paste ? (
          <p className="shield-panel-name">Pasted text</p>
        ) : (
          <p className="shield-panel-name" data-i18n="off">
            {name}
          </p>
        )}
        <p className="shield-panel-summary">
          <span className={"shield-tile" + (summary.clear ? "" : " found")} aria-hidden="true">
            <Icon name="shield" size={14} />
          </span>
          <span>{summary.clear ? "Shield found nothing to flag." : summaryText(summary)}</span>
        </p>
        <p className="shield-panel-note">{`${HONEST} ${LOCAL}`}</p>
        {instructions?.length > 0 && (
          <section className="shield-section">
            <h3>{`Hidden instructions (${summary.instructions})`}</h3>
            <p className="shield-section-note">
              Flagged, not removed: a phrase aimed at an AI rather than a reader.
            </p>
            <ul>
              {instructions.slice(0, SHOWN).map((f, i) => (
                <li key={i}>
                  <b>{CATEGORIES[f.category]}</b>
                  {f.where !== "text" && <small>{WHERE[f.where]}</small>}
                  {f.decoded ? (
                    <p className="shield-excerpt" data-i18n="off">
                      <mark>{f.decoded}</mark>
                    </p>
                  ) : (
                    <Excerpt text={text} start={f.start} end={f.end} />
                  )}
                </li>
              ))}
            </ul>
            {summary.instructions > SHOWN && (
              <p className="shield-section-note">{`And ${summary.instructions - SHOWN} more.`}</p>
            )}
          </section>
        )}
        {invisible?.total > 0 && (
          <section className="shield-section">
            <h3>{`Invisible characters (${invisible.total})`}</h3>
            <p className="shield-section-note">
              Characters you can't see but a model reads. Legitimate uses, such
              as emoji and right-to-left text, aren't counted.
            </p>
            <dl className="shield-counts">
              {Object.entries(invisible.counts)
                .filter(([, n]) => n > 0)
                .map(([cls, n]) => (
                  <div key={cls}>
                    <dt>{INVISIBLE[cls]}</dt>
                    <dd>{n}</dd>
                  </div>
                ))}
            </dl>
            {invisible.messages.slice(0, 5).map((m, i) => (
              <div key={i} className="shield-spelled">
                <small>{m.cls === "tag" ? "The tag characters spell:" : "The hidden bytes read:"}</small>
                <p className="shield-excerpt" data-i18n="off">
                  <mark>{m.decoded.slice(0, 400)}</mark>
                </p>
              </div>
            ))}
            {!invisible.messages.length &&
              examples.map((r, i) => <Excerpt key={i} text={text} start={r.start} end={r.end} />)}
          </section>
        )}
        {hidden?.length > 0 && (
          <section className="shield-section">
            <h3>{`Hidden text (${hidden.length})`}</h3>
            <p className="shield-section-note">
              Text a reader wouldn't see on the page, but a model reads.
            </p>
            <ul>
              {hidden.slice(0, SHOWN).map((h, i) => (
                <li key={i}>
                  <b>{HIDDEN[h.why] || "Hidden text"}</b>
                  {h.page ? <small>{`Page ${h.page}`}</small> : null}
                  {h.instruction && <small className="warn">Contains an instruction-like phrase</small>}
                  <p className="shield-excerpt" data-i18n="off">
                    {h.text.length > 300 ? h.text.slice(0, 300) + "…" : h.text}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!paste && (
          <fieldset className="shield-choices">
            <legend>What's sent</legend>
            <label>
              <input
                type="checkbox"
                checked={!prefs.keepInvisible && summary.invisible > 0}
                disabled={!summary.invisible}
                onChange={(e) => onPrefs?.({ ...prefs, keepInvisible: !e.target.checked })}
              />
              <span>
                Remove invisible characters
                <small>
                  {summary.invisible
                    ? "On by default. Turn off to send the file's text exactly as extracted."
                    : "None in this file."}
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!prefs.removeFlagged && summary.instructions > 0}
                disabled={!summary.instructions}
                onChange={(e) => onPrefs?.({ ...prefs, removeFlagged: e.target.checked })}
              />
              <span>
                Remove flagged lines
                <small>
                  {summary.instructions
                    ? "Takes out each line, or sentence in a long line, with a flagged phrase."
                    : "Nothing flagged in this file."}
                </small>
              </span>
            </label>
            <label>
              <input type="checkbox" checked={!!asData} onChange={(e) => onAsData?.(e.target.checked)} />
              <span>
                Send attached files as data
                <small>
                  Adds one line after your files telling the model their
                  contents are data to read, not instructions to follow. Covers
                  every file in this message.
                </small>
              </span>
            </label>
          </fieldset>
        )}
        <div className="shield-panel-actions">
          <button type="button" className="shield-button solid" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Above the composer after a paste Shield acted on. `report` is
// { result, removed, lines }: invisible characters already taken out of the
// paste (`removed`), and flagged phrases in a long paste (`lines`).
export function ShieldPasteNotice({ report, onReview, onRemoveFlagged, onAttach, onRestore, onDismiss }) {
  if (!report) return null;
  const { result } = report;
  const flagged = result.instructionCount;
  const spelled = result.invisible.messages[0]?.decoded;
  return (
    <div className="shield-notice" role="status">
      <span className="shield-tile" aria-hidden="true">
        <Icon name="shield" size={16} />
      </span>
      <div className="shield-notice-body">
        <p className="shield-notice-eyebrow">INJECTION SHIELD</p>
        {report.removed > 0 && (
          <p className="shield-notice-message">
            {report.removed === 1
              ? "Removed 1 invisible character from what you pasted."
              : `Removed ${report.removed} invisible characters from what you pasted.`}
          </p>
        )}
        {spelled && (
          <p className="shield-notice-spelled">
            <span>They spelled:</span>
            <q data-i18n="off">{spelled.length > 160 ? spelled.slice(0, 160) + "…" : spelled}</q>
          </p>
        )}
        {flagged > 0 && (
          <p className="shield-notice-message">
            {flagged === 1
              ? "1 instruction-like phrase in what you pasted. It's flagged, not removed."
              : `${flagged} instruction-like phrases in what you pasted. They're flagged, not removed.`}
          </p>
        )}
        <p className="shield-notice-note">{HONEST}</p>
        <div className="shield-notice-actions">
          <button type="button" className="shield-button" onClick={onReview}>
            Review
          </button>
          {flagged > 0 && onRemoveFlagged && (
            <button type="button" className="shield-button" onClick={onRemoveFlagged}>
              Remove flagged lines
            </button>
          )}
          {onAttach && (
            <button type="button" className="shield-button" onClick={onAttach}>
              Send it as an attached file
            </button>
          )}
          {report.removed > 0 && onRestore && (
            <button type="button" className="shield-button" onClick={onRestore}>
              Put them back
            </button>
          )}
          <button type="button" className="shield-button quiet" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Part B: remote images and links in replies ---------------------------
const origin = () => globalThis.location?.origin;
function hastText(node) {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  return (node.children || []).map(hastText).join("");
}

// Replies are fenced off from the page translator (they're the model's), so
// the placeholder's own words translate themselves, as Live Preview's
// button does.
function useUiText() {
  const language = useLanguage();
  const [, redraw] = useState(0);
  useEffect(() => {
    if (language !== "zh") return;
    let current = true;
    loadDictionary().then(
      () => setTimeout(() => current && redraw((n) => n + 1), 0),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [language]);
  return (text) => (language === "zh" ? t(text) : text);
}

// A remote image isn't fetched until the user says so: loading it would tell
// its host that this chat was opened, and anything packed into its address.
// Same-site, data: and blob: images load as before. `load` is false where
// nothing remote may ever load (a shared chat).
export function ShieldImage({ src, alt, title, load = true }) {
  const [shown, setShown] = useState(false);
  const ui = useUiText();
  const target = remoteTarget(src, origin());
  if (!target) return <img src={src} alt={alt || ""} title={title} />;
  if (shown && load)
    return <img src={target.url} alt={alt || ""} title={title} referrerPolicy="no-referrer" />;
  return (
    <span className={"shield-image" + (target.carriesData ? " carries-data" : "")}>
      <span className="shield-image-head">
        <Icon name="image" size={14} />
        <span>{ui(`Image from ${target.host}.`)}</span>
        {load && (
          <button type="button" className="shield-image-load" onClick={() => setShown(true)}>
            {ui("Load?")}
          </button>
        )}
      </span>
      <code className="shield-image-url" data-i18n="off">
        {target.url}
      </code>
      {target.carriesData && (
        <span className="shield-image-flag">
          <Icon name="warning" size={12} />
          <span>{ui(`Its address carries ${target.dataLength} characters of data. Loading it sends them to ${target.host}.`)}</span>
        </span>
      )}
      {!load && <span className="shield-image-note">{ui("Shared chats never load remote images.")}</span>}
    </span>
  );
}

// A link keeps working and shows the host it really goes to, unless its
// text already names it.
export function ShieldLink({ node, href, title, children, rel = "noopener noreferrer nofollow" }) {
  const target = remoteTarget(href, origin());
  if (!target)
    return (
      <a href={href} title={title}>
        {children}
      </a>
    );
  const link = (
    <a href={href} title={title} target="_blank" rel={rel}>
      {children}
    </a>
  );
  if (namesHost(hastText(node), target.host)) return link;
  return (
    <>
      {link}
      <span
        className={"shield-host" + (target.carriesData ? " carries-data" : "")}
        data-i18n="off"
        title={target.url}
      >
        {target.host}
      </span>
    </>
  );
}

// react-markdown components with Shield's img and a, over `base` (e.g. Live
// Preview's pre). Cached so a streaming reply doesn't remount its images.
const cache = new WeakMap();
const NONE = {};
export function shieldMarkdown(base = null, { load = true, rel } = {}) {
  const key = base || NONE;
  let byMode = cache.get(key);
  if (!byMode) cache.set(key, (byMode = new Map()));
  const id = `${load}:${rel || ""}`;
  if (!byMode.has(id))
    byMode.set(id, {
      ...(base || {}),
      img: ({ node, src, alt, title }) => <ShieldImage src={src} alt={alt} title={title} load={load} />,
      a: ({ node, href, title, children }) => (
        <ShieldLink node={node} href={href} title={title} rel={rel}>
          {children}
        </ShieldLink>
      ),
    });
  return byMode.get(id);
}

// --- Account → Settings ------------------------------------------------------
export function ShieldSettings({ config }) {
  const on = useShieldPref();
  if (!shieldReleased(config)) return null;
  return (
    <section className="shield-settings">
      <div>
        <h2>Injection Shield.</h2>
        <p>{`Checks attached files and long pastes for hidden instructions and invisible characters, sends files as data, and holds remote images in replies until you load them. ${HONEST} It runs in this browser; nothing about a finding is sent.`}</p>
      </div>
      <label className="shield-switch">
        <input type="checkbox" checked={on} onChange={(e) => setShieldPref(e.target.checked)} />
        <span>{on ? "On in this browser" : "Off in this browser"}</span>
      </label>
    </section>
  );
}
