import React, { Suspense, lazy } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import "./redact.css";

// Redact Before You Send: what the composer shows on an image chip. The
// editor itself (ImageRedact.jsx and its canvas code) loads only when
// someone opens it.
const ImageRedact = lazy(() => import("./ImageRedact.jsx"));

export const redactReleased = (config) => !!config && isReleased(config, "redact");

// "Redact" on a chip, and the "Redacted" tag once a copy has replaced the
// original. Redacting again works on the redacted copy.
export function RedactChipTools({ item, onOpen, disabled = false }) {
  return (
    <span className="redact-chip-tools">
      {item.redacted && <span className="redact-tag">Redacted</span>}
      <button
        type="button"
        className="redact-open"
        onClick={onOpen}
        disabled={disabled}
        aria-label={"Redact " + item.name}
        title="Black out parts of this image before it's sent"
      >
        <Icon name="redact" size={13} />
        <span>Redact</span>
      </button>
    </span>
  );
}

export function RedactEditor({ item, onApply, onCancel }) {
  if (!item) return null;
  return (
    <Suspense fallback={null}>
      <ImageRedact item={item} onApply={onApply} onCancel={onCancel} />
    </Suspense>
  );
}
