import React, { useState } from "react";
import { isReleased } from "./lib.js";
import { Icon } from "./ui.jsx";
import { aboutTokens, carriedContext, roughTokens } from "./catchup.js";
import "./catchup.css";

// Summarize & Continue (update "catchup"): "Catch me up" in the chat
// header of a long chat, and the banner and summary card a continued chat
// shows. The dialog that summarizes a chat and starts a fresh one from the
// summary (src/CatchUpDialog.jsx) loads only when it's opened.
export const catchupLive = (config) => isReleased(config, "catchup");

// The chat header's button. Hidden until a chat is long enough.
export function CatchUpButton({ disabled, onOpen }) {
  return (
    <button
      type="button"
      className="catchup-open"
      aria-label="Catch me up on this chat"
      title={disabled ? "Wait for the reply to finish" : "Summarize this chat, then continue fresh"}
      disabled={disabled}
      onClick={onOpen}
    >
      <Icon name="catchup" size={15} />
      <span>Catch me up</span>
    </button>
  );
}

// Phones: the header has no room for another button, so the same action
// sits under the newest message instead (shown by CSS at 480 px and below).
export function CatchUpNudge({ onOpen }) {
  return (
    <div className="catchup-nudge">
      <span>This chat is getting long.</span>
      <button type="button" onClick={onOpen}>
        <Icon name="catchup" size={14} />
        Catch me up
      </button>
    </div>
  );
}

// A continued chat: where it came from. A saved or Device Vault source opens
// from the link; an off-the-record one was never kept.
export function ContinuedBanner({ carried, onOpen }) {
  const from = carried?.from;
  return (
    <div className="branch-banner catchup-banner">
      <Icon name="catchup" size={14} />
      {from?.title ? (
        <>
          Continued from{" "}
          {onOpen ? (
            <button type="button" data-i18n="off" onClick={onOpen}>
              {from.title}
            </button>
          ) : (
            <b data-i18n="off">{from.title}</b>
          )}
        </>
      ) : carried?.kind === "ephemeral" || carried?.kind === "private" ? (
        "Continued from an off-the-record chat"
      ) : (
        "Continued from an earlier chat"
      )}
      <span>The original is unchanged.</span>
    </div>
  );
}

// The summary a continued chat carries, at the top of the chat. Collapsed
// once the conversation has started.
export function CarriedSummary({ summary, restore = (s) => s, started = false }) {
  const [open, setOpen] = useState(!started);
  const text = restore(summary);
  return (
    <div className={"carried-summary" + (open ? " open" : "")}>
      <button type="button" className="carried-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="carried-tile" aria-hidden="true">
          <Icon name="catchup" size={15} />
        </span>
        <span className="carried-title">
          <b>Summary carried into this chat</b>
          <small>{`Sent as context with each message · ≈${aboutTokens(roughTokens(carriedContext(summary).length))} tokens`}</small>
        </span>
        <Icon name="down" size={15} />
      </button>
      {open && (
        <div className="carried-body" data-i18n="off">
          {text}
        </div>
      )}
    </div>
  );
}
