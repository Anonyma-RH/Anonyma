import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import { scanSecrets, seedGuardMessage } from "./seed-guard.js";
import "./seed-guard.css";

// Seed Guard: always on once released. Every place that sends text scans it
// here first (src/seed-guard.js) and, on a find, blocks sending with the
// notice below. Nothing is masked: a model can't use a masked phrase anyway.
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
  send: { anyway: "Send anyway", confirm: "Yes, send it" },
  save: { anyway: "Save anyway", confirm: "Yes, save it" },
};

// The inline block. `onProceed` is the explicit override: offered as
// "Send anyway" (or "Save anyway"), and run only after a second confirm.
// Without it (Memory, support messages) the only way on is to remove it.
export function SeedGuardNotice({ hit, onProceed, verb = "send", busy = false, children }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!hit) setConfirming(false);
  }, [hit]);
  if (!hit) return null;
  const words = VERBS[verb] || VERBS.send;
  return (
    <div className="seed-guard" role="alert">
      <span className="seed-guard-tile" aria-hidden="true">
        <Icon name="lock" size={16} />
      </span>
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
                  onProceed();
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
            {onProceed && (
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
