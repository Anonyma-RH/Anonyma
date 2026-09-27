import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Icon, Button, Notice, CopyButton, Mark } from "./ui.jsx";
import { api, uid, isReleased } from "./lib.js";
import { encodeQR, qrPath } from "./qr.js";
import {
  AMOUNT_RULE,
  GIFT_DAYS,
  GIFT_MAX,
  GIFT_MIN,
  GIFT_NOTE_MAX,
  GIFT_PATH,
  GIFT_PRESETS,
  GIFT_STATUS,
  normalizeGiftNote,
  parseGiftAmount,
} from "./gift-links.js";
import "./gift-links.css";

// Gift Links, the giver's side (Account → Credits & funding): make a gift,
// see its link, code and printable card once, and the list of gifts with
// Cancel. The server (server/routes/gifts.js) moves the credits; nothing
// here keeps a code: it's in this page's memory until the page closes.
export const giftLinksReleased = (config) => isReleased(config, "giftlinks");

const date = (ms) => new Date(ms).toLocaleDateString();
const whole = (n) => Number(n).toLocaleString();

// The claim link as a QR code, drawn in the browser (src/qr.js): the code
// never goes to a QR service.
function GiftQr({ text }) {
  const qr = useMemo(() => qrPath(encodeQR(text, { ecl: "M" }), 2), [text]);
  return (
    <svg className="gift-qr" viewBox={qr.viewBox} role="img" aria-label="QR code of the gift link" shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={qr.d} fill="#0e1a3a" />
    </svg>
  );
}

// The gift card: on screen after making a gift, on paper from Print card,
// and (without its code) on the claim page.
export function GiftCard({ amount, note, code, link, expires, host, claimed = false }) {
  return (
    <article className="gift-card" aria-label={`Gift card for ${whole(amount)} credits`}>
      <div className="gift-card-top">
        <span className="gift-card-brand">
          <Mark />
          <span>ANONYMA</span>
        </span>
        <span className="gift-card-tag">
          <Icon name={claimed ? "check" : "gift"} size={14} />
          {claimed ? "Claimed" : "Gift"}
        </span>
      </div>
      <div className="gift-card-amount">
        <b>{whole(amount)}</b>
        <span>credits of AI</span>
      </div>
      {note ? (
        <p className="gift-card-note" data-i18n="off">
          “{note}”
        </p>
      ) : (
        <p className="gift-card-note muted">Chat, code, images, video and voice, on one balance.</p>
      )}
      {code ? (
        <div className="gift-card-claim">
          <GiftQr text={link} />
          <div>
            <small>Scan, or go to {host}/gift and enter</small>
            <code data-i18n="off">{code}</code>
            {expires && <small>Claim by {date(expires)} · No cash value</small>}
          </div>
        </div>
      ) : (
        expires && (
          <p className="gift-card-by">
            Claim by {date(expires)} · No cash value
          </p>
        )
      )}
    </article>
  );
}

// Print card: a copy of the card alone, mounted at the top of the page for
// as long as the print dialog is open.
function usePrintCard() {
  const [printing, setPrinting] = useState(null);
  useEffect(() => {
    if (!printing) return;
    const root = document.documentElement;
    root.classList.add("gift-printing");
    const done = () => {
      root.classList.remove("gift-printing");
      setPrinting(null);
    };
    window.addEventListener("afterprint", done, { once: true });
    // Let the copy render before the dialog opens.
    const timer = setTimeout(() => {
      try {
        window.print();
      } catch {
        done();
      }
    }, 60);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      root.classList.remove("gift-printing");
    };
  }, [printing]);
  const sheet = printing
    ? createPortal(
        <div className="gift-print-root">
          <GiftCard {...printing} />
        </div>,
        document.body,
      )
    : null;
  return [sheet, setPrinting];
}

function StatusTag({ gift }) {
  const when =
    gift.status === "open"
      ? `Comes back ${date(gift.expires)} if unclaimed`
      : gift.status === "claimed"
        ? `Claimed ${date(gift.claimed)}`
        : `Returned ${date(gift.returned)}`;
  return (
    <>
      <span className={"gift-status " + gift.status}>{GIFT_STATUS[gift.status]}</span>
      <small>{when}</small>
    </>
  );
}

// Just made: the card, the link (shown this once) and what to do with it.
export function GiftMade({ made, host, onPrint, onAnother }) {
  return (
    <div className="gift-made" aria-live="polite">
      <GiftCard
        amount={made.amount}
        note={made.note}
        code={made.code}
        link={made.link}
        expires={made.expires}
        host={host}
      />
      <Notice>
        Save the link now: it's shown only once. We keep only a fingerprint
        of the code, so nobody can show it again, us included.
      </Notice>
      <div className="gift-made-link" data-i18n="off">
        {made.link}
      </div>
      <div className="gift-made-actions">
        <CopyButton text={made.link} label="Copy link" />
        <CopyButton text={made.code} label="Copy code" />
        <button type="button" className="small-button" onClick={onPrint}>
          <Icon name="printer" size={14} />
          Print card
        </button>
        <button type="button" className="small-button" onClick={onAnother}>
          <Icon name="plus" size={14} />
          Make another
        </button>
      </div>
    </div>
  );
}

// The giver's gifts: amount, note, state and date, with Cancel on the open
// ones (asked twice), and the small print.
export function GiftList({ gifts, busy, cancelling, onAsk, onCancel }) {
  return (
    <>
      {gifts === null ? (
        <p className="gift-fine">Loading your gifts…</p>
      ) : gifts.length ? (
        <ul className="gift-list">
          {gifts.map((g) => (
            <li key={g.id} className="gift-row">
              <b>{whole(g.amount)}</b>
              <div className="gift-row-text">
                {g.note && (
                  <span className="gift-row-note" data-i18n="off">
                    {g.note}
                  </span>
                )}
                <span className="gift-row-meta">
                  <StatusTag gift={g} />
                </span>
              </div>
              {g.status === "open" &&
                (cancelling === g.id ? (
                  <div className="gift-row-confirm">
                    <button
                      type="button"
                      className="small-button danger-text"
                      disabled={busy}
                      onClick={() => onCancel(g)}
                    >
                      Cancel gift
                    </button>
                    <button type="button" className="small-button" onClick={() => onAsk(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="small-button"
                    disabled={busy}
                    onClick={() => onAsk(g.id)}
                  >
                    Cancel
                  </button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="gift-fine">No gifts yet. The ones you make show here, with when they're claimed.</p>
      )}
      <ul className="gift-facts">
        <li>
          <Icon name="check" size={15} />
          Credits leave your balance when you make the gift. Cancel any
          time before it's claimed; unclaimed credits come back after{" "}
          {GIFT_DAYS} days.
        </li>
        <li>
          <Icon name="eyeoff" size={15} />
          You see only that a gift was claimed, and when. Never who.
        </li>
        <li>
          <Icon name="coins" size={15} />
          A gift counts toward your spending limits, like sending credits.
        </li>
        <li>
          <Icon name="shield" size={15} />
          Gift credits have no cash value and can't be refunded to cash.
        </li>
      </ul>
    </>
  );
}

export function GiftLinks({ user, demo, config, onChanged }) {
  const [gifts, setGifts] = useState(null);
  const [preset, setPreset] = useState(GIFT_PRESETS[1]);
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [requestId, setRequestId] = useState(uid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [made, setMade] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  // What Cancel did, shown beside the list.
  const [listMessage, setListMessage] = useState(null);
  const [sheet, printCard] = usePrintCard();
  const alive = useRef(true);
  const panel = useRef(null);
  useEffect(() => {
    alive.current = true;
    // Opened as /account/credits#gift-links (the command palette, the claim
    // page): the account page loads lazily, so scroll once it's here.
    const timer =
      globalThis.location?.hash === "#gift-links" &&
      setTimeout(() => panel.current?.scrollIntoView({ block: "start" }), 120);
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);
  async function load() {
    try {
      const r = await api("/api/gifts");
      if (alive.current) setGifts(r.data);
    } catch (e) {
      if (alive.current) setListMessage({ type: "error", text: e.message });
    }
  }
  useEffect(() => {
    if (!demo && user) load();
    else setGifts([]);
  }, [demo, user?.id]);

  const amount = preset === "custom" ? parseGiftAmount(custom) : preset;
  const cleanNote = normalizeGiftNote(note);
  const host = String(config?.origin || globalThis.location?.origin || "").replace(/^https?:\/\//, "");
  const reset = () => {
    setConfirm(false);
    setRequestId(uid());
    setError("");
  };

  async function submit(e) {
    e.preventDefault();
    setNotice("");
    if (amount == null) return setError(AMOUNT_RULE);
    if (!confirm) {
      setError("");
      return setConfirm(true);
    }
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/gifts", {
        method: "POST",
        body: { amount, note: cleanNote, requestId },
      });
      if (!alive.current) return;
      if (r.repeated) setNotice(r.message);
      else setMade(r);
      setNote("");
      setConfirm(false);
      setRequestId(uid());
      load();
      onChanged?.();
    } catch (err) {
      if (alive.current) {
        setError(err.message);
        setConfirm(false);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function cancelGift(gift) {
    setBusy(true);
    setListMessage(null);
    try {
      await api(`/api/gifts/${encodeURIComponent(gift.id)}/revoke`, { method: "POST", body: {} });
      if (!alive.current) return;
      setListMessage({ text: `Gift cancelled. ${whole(gift.amount)} credits are back in your balance.` });
      if (made?.id === gift.id) setMade(null);
      load();
      onChanged?.();
    } catch (err) {
      if (alive.current) setListMessage({ type: "error", text: err.message });
    } finally {
      if (alive.current) {
        setBusy(false);
        setCancelling(null);
      }
    }
  }

  const open = (gifts || []).filter((g) => g.status === "open").length;
  return (
    <section className="gift-links" id="gift-links" ref={panel} aria-labelledby="gift-links-title">
      <div className="gift-links-head">
        <span className="gift-links-tile" aria-hidden="true">
          <Icon name="gift" size={20} />
        </span>
        <div>
          <h2 id="gift-links-title">Gift Links</h2>
          <p>
            Turn credits into a link anyone can claim once. No usernames, no
            emails; unclaimed credits come back to you.
          </p>
        </div>
        <Link to={GIFT_PATH} className="small-button gift-have-code">
          Have a gift code? <Icon name="arrow" size={14} />
        </Link>
      </div>
      <div className="gift-links-grid">
        <div className="gift-links-make">
          {made ? (
            <GiftMade
              made={made}
              host={host}
              onPrint={() => printCard({ ...made, host })}
              onAnother={() => setMade(null)}
            />
          ) : (
            <form className="form-panel gift-form" onSubmit={submit}>
              <fieldset className="gift-amounts" disabled={busy}>
                <legend>Amount</legend>
                <div className="amount-shortcuts">
                  {GIFT_PRESETS.map((x) => (
                    <button
                      type="button"
                      key={x}
                      className={preset === x ? "active" : ""}
                      aria-pressed={preset === x}
                      onClick={() => {
                        setPreset(x);
                        reset();
                      }}
                    >
                      {whole(x)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={preset === "custom" ? "active" : ""}
                    aria-pressed={preset === "custom"}
                    onClick={() => {
                      setPreset("custom");
                      reset();
                    }}
                  >
                    Custom
                  </button>
                </div>
              </fieldset>
              {preset === "custom" && (
                <label>
                  Credits ({whole(GIFT_MIN)} to {whole(GIFT_MAX)})
                  <input
                    type="number"
                    inputMode="numeric"
                    min={GIFT_MIN}
                    max={GIFT_MAX}
                    step="1"
                    value={custom}
                    autoFocus
                    aria-invalid={custom && amount == null ? "true" : undefined}
                    onChange={(e) => {
                      setCustom(e.target.value);
                      reset();
                    }}
                  />
                </label>
              )}
              <label>
                <span className="gift-note-label">
                  Note (optional)
                  <small>
                    {cleanNote.length}/{GIFT_NOTE_MAX}
                  </small>
                </span>
                <input
                  value={note}
                  maxLength={GIFT_NOTE_MAX}
                  placeholder="Happy birthday! Have fun with it."
                  onChange={(e) => {
                    setNote(e.target.value);
                    reset();
                  }}
                />
              </label>
              <div className="funding-estimate gift-estimate">
                <span>Leaves your balance now</span>
                <b>{amount == null ? "—" : `${whole(amount)} credits`}</b>
              </div>
              {error && <Notice type="error">{error}</Notice>}
              {notice && <Notice>{notice}</Notice>}
              <Button disabled={busy || demo || !user || amount == null}>
                {busy
                  ? "Making your gift…"
                  : confirm
                    ? `Confirm: gift ${whole(amount)} credits`
                    : "Make gift link"}
                <Icon name="arrow" />
              </Button>
              {confirm && !busy && (
                <button type="button" className="small-button gift-back" onClick={reset}>
                  Change something
                </button>
              )}
              {demo && <p className="gift-fine">Sample account: making a gift needs a signed-in account.</p>}
            </form>
          )}
        </div>
        <div className="gift-links-side">
          <h3>
            Your gifts
            {open > 0 && <span className="gift-count">{open} waiting</span>}
          </h3>
          {listMessage && <Notice type={listMessage.type}>{listMessage.text}</Notice>}
          <GiftList
            gifts={gifts}
            busy={busy}
            cancelling={cancelling}
            onAsk={setCancelling}
            onCancel={cancelGift}
          />
        </div>
      </div>
      {sheet}
    </section>
  );
}
