import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import { scanSecrets, seedGuardMessage, isSoft } from "./seed-guard.js";
import "./seed-guard.css";

// Seed Guard: always on once released. Every place that sends text scans it
// here first (src/seed-guard.js) and, on a find, holds sending with the
// notice below: a hard block for a seed phrase, WIF or xprv key, a soft one
// for 64-hex (a private key or a transaction hash). Nothing is masked: a
// model can't use a masked phrase anyway.
// The scan runs in this tab only; nothing about a match is logged, stored
// or sent, and the notice never repeats the words it found.
export const seedGuardLive = (config) => isReleased(config, "seedguard");

// `text` is a string or an array of strings. Pass a stable array (useMemo)
// so large attachments are scanned only when they change.
export function useSeedScan(live, text) {
  return useMemo(() => (live ? scanSecrets(text) : null), [live, text]);
}

const CONFIRM = {
  seed: "Anyone with this phrase controls its wallet. Continue only if it's a test phrase with no funds.",
  key: "Anyone with this key controls its wallet. Continue only if it's a test key with no funds.",
};
const VERBS = {
  send: { anyway: "Send anyway", confirm: "Yes, send it", notKey: "It's not a key, send" },
  save: { anyway: "Save anyway", confirm: "Yes, save it", notKey: "It's not a key, save" },
};

const Tile = () => (
  <span className="seed-guard-tile" aria-hidden="true">
    <Icon name="lock" size={16} />
  </span>
);

// The soft notice for 64-hex: one click on "It's not a key, send" goes
// straight on, with no second confirm. Stateless on purpose. With Onchain
// Explainer released and a 0x transaction hash in the message, `onExplain`
// adds "Explain this transaction", which also says it isn't a key.
export function SeedGuardSoftNotice({ hit, onProceed, onExplain, verb = "send", busy = false }) {
  const words = VERBS[verb] || VERBS.send;
  return (
    <div className="seed-guard soft" role="status">
      <Tile />
      <div className="seed-guard-body">
        <p className="seed-guard-eyebrow">SEED GUARD</p>
        <p className="seed-guard-message">{seedGuardMessage(hit)}</p>
        {(onProceed || onExplain) && (
          <div className="seed-guard-actions">
            {onExplain && (
              <button
                type="button"
                className="seed-guard-button solid"
                disabled={busy}
                onClick={onExplain}
              >
                Explain this transaction
              </button>
            )}
            {onProceed && (
              <button
                type="button"
                className="seed-guard-button"
                disabled={busy}
                onClick={onProceed}
              >
                {words.notKey}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The inline block. `onProceed` is the explicit override. For a seed phrase,
// WIF or xprv it is offered as "Send anyway" (or "Save anyway") and runs only
// after a second confirm, unless `hardOverride` is false (support messages).
// Without it (Memory) the only way on is to remove it.
export function SeedGuardNotice({
  hit,
  onProceed,
  onExplain,
  verb = "send",
  busy = false,
  hardOverride = true,
  children,
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!hit) setConfirming(false);
  }, [hit]);
  if (!hit) return null;
  if (isSoft(hit))
    return (
      <SeedGuardSoftNotice hit={hit} onProceed={onProceed} onExplain={onExplain} verb={verb} busy={busy} />
    );
  const words = VERBS[verb] || VERBS.send;
  const override = hardOverride ? onProceed : null;
  return (
    <div className="seed-guard" role="alert">
      <Tile />
      <div className="seed-guard-body">
        <p className="seed-guard-eyebrow">SEED GUARD</p>
        <p className="seed-guard-message">{seedGuardMessage(hit)}</p>
        {confirming ? (
          <>
            <p className="seed-guard-note">{CONFIRM[hit.kind] || CONFIRM.seed}</p>
            <div className="seed-guard-actions">
              <button
                type="button"
                className="seed-guard-button solid"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  override();
                }}
              >
                {words.confirm}
              </button>
              <button
                type="button"
                className="seed-guard-button"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="seed-guard-note">
              Checked in this browser. Nothing about it is saved or sent.
            </p>
            {children}
            {override && (
              <div className="seed-guard-actions">
                <button
                  type="button"
                  className="seed-guard-button"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  {words.anyway}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
