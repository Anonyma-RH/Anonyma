import React from "react";
import { STATUS_LABEL, statusHint } from "./model-status.js";
import "./model-status.css";

// Model Status in the workspace (update "status"): the dot beside a model in
// the picker and the notice when the chosen model is down. The workspace
// shows them only once the update is released (src/model-status.js).

// A small green, amber or red dot beside a model's name, with what it
// means as its tooltip. Nothing shows while there's too little data.
export function StatusDot({ entry }) {
  const status = entry?.status;
  if (!["up", "degraded", "down"].includes(status)) return null;
  const hint = statusHint(entry);
  return <span className={"ms-dot " + status} role="img" aria-label={STATUS_LABEL[status]} title={hint} />;
}

// Under the model picker when the chosen model is down. It never blocks Send.
export function ModelDownNotice({ model }) {
  return (
    <div className="ms-notice" role="status">
      <span className="ms-dot down" aria-hidden="true" />
      <p>
        <b data-i18n="off">{model.name}</b> looks down: most requests to it failed or timed out in the last 15
        minutes. You can still send, or pick another model.
      </p>
      <a href="/status" target="_blank" rel="noreferrer" className="ms-notice-link">
        Model status
      </a>
    </div>
  );
}
