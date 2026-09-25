import React from "react";
import { Icon, Notice } from "./ui.jsx";
import { RETENTION_CHOICES, retentionLabel } from "./ephemeral.js";
import "./ephemeral.css";

// Composer control that starts an unsaved chat. Styled like the existing
// "Web" toggle so it reads as part of the same control group.
export function EphemeralToggle({ active, onToggle, disabled }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle" + (active ? " on" : "")}
      aria-pressed={active}
      disabled={disabled}
      title={
        disabled
          ? "Off the record is on for this chat because Private mode is on"
          : "Off the record: nothing about this chat is saved"
      }
      onClick={onToggle}
    >
      <Icon name={active ? "eyeoff" : "eye"} size={17} />
      <span>Off the record</span>
    </button>
  );
}
// Shown above the composer while off the record is active.
export function EphemeralNotice() {
  return (
    <Notice>
      Off the record — this chat isn't saved. Leaving or reloading clears it.
    </Notice>
  );
}
// Per-conversation auto-delete choice, used in the conversation's menu.
export function RetentionSelect({ value, onChange, disabled }) {
  return (
    <label className="retention-select">
      Auto-delete
      <select
        aria-label="Auto-delete this conversation"
        value={value == null ? "" : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      >
        {RETENTION_CHOICES.map((c) => (
          <option key={c.label} value={c.value == null ? "" : c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}
// "Deletes in N days" next to a conversation, once it has an expiry.
export function RetentionIndicator({ expires }) {
  const label = retentionLabel(expires);
  return label ? <small className="retention-indicator">{label}</small> : null;
}
