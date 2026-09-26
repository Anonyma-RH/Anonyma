import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import { SEALED_OFF } from "./sealed.js";
import "./sealed-mode.css";

// Sealed Mode (update "sealed"): end-to-end encrypted chat on open-weight
// private models that run inside a hardware-verified enclave. The crypto
// (src/sealed-client.js) loads only once the switch is on; everything here is
// the switch, the verification panel and the note under a sealed reply.

// Released, and the server has a billing mode for it (never unknown billing).
export const sealedLiveFor = (config) =>
  isReleased(config, "sealed") && config?.services?.sealed === true;

export const SEALED_COPY = [
  "Sealed Mode encrypts your message in your browser to a hardware-verified enclave. ANONYMA only relays ciphertext.",
  "On open-weight private models, which run inside that enclave, neither ANONYMA nor our providers can read your prompt or reply.",
  "We still see metadata (model, time, size, tokens), and you're trusting the open-source page code we serve.",
];

const loadClient = () => import("./sealed-client.js");

// The enclave's verification for this tab: done when the switch goes on,
// redone once it's older than the maximum age, and required (fresh) before
// every send. A failure leaves nothing to send with.
export function useSealedEnclave(enabled) {
  const [state, setState] = useState({ status: "idle" });
  const current = useRef(null);
  const pending = useRef(null);
  function verify({ fresh = false } = {}) {
    if (pending.current) return pending.current;
    setState((s) => ({ status: "verifying", attestation: s.attestation }));
    pending.current = loadClient()
      .then((client) => client.attest({ fresh }))
      .then(
        (attestation) => {
          current.current = attestation;
          setState({ status: "verified", attestation });
          return attestation;
        },
        (e) => {
          current.current = null;
          setState({
            status: "failed",
            error: e?.message || "The enclave failed verification. Nothing was sent.",
          });
          throw e;
        },
      )
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }
  useEffect(() => {
    if (enabled) {
      if (!current.current) verify().catch(() => {});
    } else {
      current.current = null;
      setState({ status: "idle" });
    }
  }, [enabled]);
  async function fresh() {
    const client = await loadClient();
    return current.current && client.isFresh(current.current)
      ? current.current
      : verify();
  }
  return {
    state,
    retry: () => verify().catch(() => {}),
    // Verifies (if the last check is stale), then seals and sends.
    async chat(options) {
      const client = await loadClient();
      const attestation = await fresh();
      return client.sealedChat({
        ...options,
        attestation,
        reattest: () => verify({ fresh: true }),
      });
    },
    async billing(requestId) {
      const client = await loadClient();
      return client.sealedBilling(requestId);
    },
  };
}

// Composer switch, styled like the Private and Off the record toggles.
export function SealedToggle({ active, onToggle, disabled }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle sealed-toggle" + (active ? " on" : "")}
      aria-pressed={active}
      disabled={disabled}
      title="Sealed Mode: encrypted in your browser, readable only in the enclave"
      onClick={onToggle}
    >
      <Icon name="lock" size={17} />
      <span>Sealed</span>
    </button>
  );
}

const short = (value, n = 12) =>
  value && value.length > n * 2 ? `${value.slice(0, n)}…${value.slice(-6)}` : value || "";

// The panel above the composer while Sealed Mode is on: what it does, the
// enclave's verification, and what's switched off.
export function SealedPanel({ state, onRetry, holdCredits, noModels }) {
  const a = state.attestation;
  const verified = state.status === "verified" && a;
  return (
    <section className={"sealed-panel " + state.status} aria-live="polite">
      <header>
        <Icon name="lock" size={16} />
        <b>Sealed Mode</b>
        <span className="sealed-status">
          {state.status === "verified"
            ? "Enclave verified"
            : state.status === "failed"
              ? "Verification failed"
              : "Verifying the enclave…"}
        </span>
      </header>
      <ul className="sealed-copy">
        {SEALED_COPY.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {noModels && <p className="sealed-error">No sealed models are available right now.</p>}
      {state.status === "failed" && (
        <p className="sealed-error">
          {state.error} <button type="button" className="sealed-link" onClick={onRetry}>Verify again</button>
        </p>
      )}
      {verified && (
        <dl className="sealed-facts">
          <div>
            <dt>Enclave measurement</dt>
            <dd>
              <code data-i18n="off" title={a.measurement}>{short(a.measurement)}</code>
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <a
                data-i18n="off"
                href={`https://github.com/${a.repository}/commit/${a.commit}`}
                target="_blank"
                rel="noreferrer"
              >
                {a.repository} @ {a.commit.slice(0, 7)}
              </a>
              {a.releaseTag && <span data-i18n="off"> · {a.releaseTag}</span>}
              <span className="sealed-sub">Signed release, checked with Sigstore</span>
            </dd>
          </div>
          <div>
            <dt>Hardware</dt>
            <dd>
              {a.hardware}
              <span className="sealed-sub">Report checked against AMD's roots in this browser</span>
            </dd>
          </div>
          <div>
            <dt>Verified</dt>
            <dd>{new Date(a.verifiedAt).toLocaleString("en-US")}</dd>
          </div>
        </dl>
      )}
      {verified && Number.isFinite(holdCredits) && holdCredits > 0 && (
        <p className="sealed-hold">
          {`This message holds up to ${holdCredits.toFixed(2)} credits; you're charged for what it uses.`}
        </p>
      )}
      <details className="sealed-off">
        <summary>What Sealed Mode turns off</summary>
        <ul>
          {SEALED_OFF.map((f) => (
            <li key={f.id}>{f.text}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

// The line under a sealed reply: sealed, not saved, and its charge.
export function SealedReplyNote({ info }) {
  if (!info) return null;
  const b = info.billing;
  const charge =
    !b
      ? info.pending
        ? "Checking the charge…"
        : "Charge not confirmed yet"
      : b.status === "settled"
        ? `${b.charged} credits charged`
        : b.status === "released"
          ? "Nothing charged"
          : `${b.held} credits held until the charge is confirmed`;
  return (
    <p className="sealed-reply-note">
      <Icon name="lock" size={12} />
      {`Sealed · decrypted only in the enclave · not saved on our servers · ${charge}`}
    </p>
  );
}
