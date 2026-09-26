import React from "react";
import { Icon } from "./ui.jsx";
import { cleanNote } from "./clean-notes.js";
import "./clean-uploads.css";

// Clean Uploads' small line under a file: what was removed (or, for a chat
// document whose text alone is sent, what stays behind), that the original
// is kept, or that the file couldn't be cleaned.
export function CleanNote({ result, keep = false, notSent = false }) {
  const note = cleanNote(result, { keep, notSent });
  if (!note) return null;
  return (
    <small className={"clean-note " + note.tone}>
      {note.tone === "warn" && <Icon name="warning" size={12} />}
      {note.text}
    </small>
  );
}

// Off by default: for someone who needs the file's details to go with it.
export function KeepOriginal({ checked, onChange, disabled = false }) {
  return (
    <label className="clean-keep">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      Keep original
    </label>
  );
}

// A reference image in the composer, with its note and Keep original. An
// image that couldn't be cleaned is held back (dimmed, not sent) until the
// user keeps the original or removes it (or redacts it). HEIC photos are
// converted, so they have no original to keep, and neither has a redacted
// copy. `children` are Redact Before You Send's tools (src/Redact.jsx).
export function CleanImageChip({ item, onKeep, onRemove, children }) {
  return (
    <span className={"clean-chip" + (item.url ? "" : " held")}>
      <img src={item.url || item.originalUrl} alt={item.name} data-i18n="off" />
      <span className="clean-chip-text">
        <CleanNote result={item.clean} keep={item.keep} />
        {item.originalUrl && <KeepOriginal checked={item.keep} onChange={onKeep} />}
        {children}
      </span>
      <button type="button" aria-label={"Remove " + item.name} onClick={onRemove}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}
