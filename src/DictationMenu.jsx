import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./ui.jsx";
import "./dictation-menu.css";

// Private Dictation: the composer's microphone menu, shown once the update
// is live. "On this device (free)" opens Private Dictation's panel
// (src/Dictation.jsx); "Paid transcription" opens the existing
// Voice-assisted chat, where it's available. Small on purpose: the panel and
// its engine load only when chosen.
export default function DictationMenu({ onDevice, onPaid, paid, disabled, active }) {
  const [open, setOpen] = useState(false),
    [place, setPlace] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const pick = (fn) => () => {
    setOpen(false);
    fn();
  };
  return (
    <span className="dictate-menu" ref={box}>
      <button
        type="button"
        className={"attachment-control dictate-button" + (active ? " on" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="Dictate with your voice"
        onClick={() => {
          // Kept inside the window on narrow screens: shifted left as needed.
          const r = box.current?.getBoundingClientRect();
          const vw = globalThis.innerWidth || 0;
          if (r && vw) {
            const width = Math.min(290, vw - 24);
            setPlace({ width, left: Math.max(12 - r.left, Math.min(0, vw - 12 - r.left - width)) });
          }
          setOpen((v) => !v);
        }}
      >
        <Icon name="mic" size={17} />
        <span>Dictate</span>
      </button>
      {open && <DictationOptions paid={paid} style={place} onDevice={pick(onDevice)} onPaid={pick(onPaid)} />}
    </span>
  );
}

// The two choices. Paid transcription is listed only where it exists: live,
// or with the reason it isn't offered here (Private Mode, Sealed Mode).
export function DictationOptions({ paid, onDevice, onPaid, style }) {
  return (
    <span className="dictate-options" role="menu" aria-label="Dictate" style={style || undefined}>
      <button type="button" role="menuitem" onClick={onDevice}>
        <b>On this device (free)</b>
        <small>Private: your voice never leaves this device. Less accurate.</small>
      </button>
      {paid?.available ? (
        <button type="button" role="menuitem" onClick={onPaid}>
          <b>Paid transcription</b>
          <small>More accurate. The audio goes to a speech provider.</small>
        </button>
      ) : (
        paid?.reason && (
          <span className="dictate-unavailable" role="menuitem" aria-disabled="true">
            <b>Paid transcription</b>
            <small>{paid.reason}</small>
          </span>
        )
      )}
    </span>
  );
}
