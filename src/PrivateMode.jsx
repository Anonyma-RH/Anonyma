import React from "react";
import { Icon, Notice } from "./ui.jsx";
import { isReleased } from "./lib.js";
import "./private-mode.css";

// One switch: private models only, nothing saved, Veil on. Needs Ephemeral
// Chats released too (it always takes that path) — see releaseGuard's
// dependency check in server/releases.js.
export const privateModeReleased = (config) =>
  isReleased(config, "private") && isReleased(config, "ephemeral");

// Exact copy pending a policy check (see AGENTS.md / the brief); kept as a
// single constant so the owner can update it in one place.
export const PRIVATE_ROUTE_NOTE =
  "Private mode: this chat isn't saved, goes only to models whose provider says it doesn't keep data, and Veil masks your details before sending.";

// Composer control, styled like the existing Off the record/Web toggles.
export function PrivateModeToggle({ active, onToggle, disabled }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle" + (active ? " on" : "")}
      aria-pressed={active}
      disabled={disabled}
      title="Private mode: private models only, nothing saved, Veil on"
      onClick={onToggle}
    >
      <Icon name={active ? "shield" : "eyeoff"} size={17} />
      <span>Private</span>
    </button>
  );
}
// Shown in the composer zone while private mode is active.
export function PrivateModeNotice() {
  return <Notice>{PRIVATE_ROUTE_NOTE}</Notice>;
}
// Shown instead, in place of the notice, when no private model can be
// reached: Send stays disabled until this clears.
export function NoPrivateModelsNotice() {
  return (
    <Notice type="error">No private models are available right now.</Notice>
  );
}
// Small tag next to a private model in the picker, even outside private mode.
export function PrivateModelTag() {
  return <span className="private-tag">Private</span>;
}
// Muted line under a private-mode reply. `info` is the server's
// anonyma.private ({ provider, stored }); `masked` is Veil's mask count for
// the matching request, when this browser still has it (omitted otherwise).
export function PrivateReplyNote({ info, masked }) {
  if (!info) return null;
  return (
    <p className="private-reply-note">
      Sent to {info.provider || "the provider"} · not saved
      {Number.isFinite(masked) && masked > 0
        ? ` · ${masked} detail${masked === 1 ? "" : "s"} masked`
        : ""}
    </p>
  );
}
