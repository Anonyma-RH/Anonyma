import React, { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { stashForVerify } from "./receipts.js";
import { readTrail, trailRows } from "./privacy-trail.js";
import "./training-labels.css";
import "./privacy-trail.css";

// Privacy Trail: a small "Privacy" chip under a reply that opens "Where this
// prompt went". Everything shown comes from the server's privacy object for
// that request (see src/privacy-trail.js); a reply without one shows nothing.
export const privacyTrailReleased = (config) => isReleased(config, "trail");

export function PrivacyTrail({ privacy, models = [], receiptsLive = false }) {
  const [open, setOpen] = useState(false);
  const [receiptError, setReceiptError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const panelId = useId();
  const trail = readTrail(privacy);
  if (!trail) return null;
  const model = models.find((m) => m.id === trail.model);
  const rows = trailRows(trail, {
    modelName: model?.name,
    privateModel: model?.private === true,
    receiptsLive,
  });
  // The signed receipt is fetched by id (owner-only), then handed to /verify
  // the same way the Verify button beside a receipt does.
  async function verify(id) {
    setReceiptError("");
    setLoading(true);
    try {
      const signed = await api("/api/receipts/" + encodeURIComponent(id));
      stashForVerify(signed);
      navigate("/verify");
    } catch {
      setReceiptError("Couldn't load the signed receipt.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className={"privacy-trail" + (open ? " open" : "")}>
      <button
        type="button"
        className="privacy-chip"
        aria-expanded={open}
        aria-controls={panelId}
        title="Where this prompt went"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="route" size={12} />
        <span>Privacy</span>
      </button>
      {open && (
        <section className="privacy-panel" id={panelId} aria-label="Where this prompt went">
          <p className="privacy-panel-title">Where this prompt went</p>
          <dl>
            {rows.map((row) => (
              <div key={row.key} className={"privacy-row " + row.key}>
                <dt>{row.label}</dt>
                <dd>
                  {row.key === "model" ? (
                    <>
                      <span data-i18n="off">{row.value}</span>
                      {row.provider ? (
                        <span className="privacy-provider" data-i18n="off">
                          {row.provider}
                        </span>
                      ) : (
                        <span className="privacy-provider">Provider not listed</span>
                      )}
                    </>
                  ) : row.key === "retention" ? (
                    <>
                      <span className={row.zdr ? "privacy-zdr" : undefined}>{row.value}</span>
                      {row.trainsOnPrompts && (
                        <span
                          className="training-tag"
                          title="The provider says it uses what you send to this model to improve its products."
                        >
                          Trains on prompts
                        </span>
                      )}
                      {row.note && <small>{row.note}</small>}
                    </>
                  ) : row.key === "receipt" ? (
                    row.receiptId ? (
                      <>
                        <code data-i18n="off" title={row.receiptId}>
                          {row.receiptId.slice(0, 12)}
                        </code>
                        <button
                          type="button"
                          className="privacy-verify"
                          disabled={loading}
                          onClick={() => verify(row.receiptId)}
                        >
                          Verify
                          <Icon name="external" size={12} />
                        </button>
                        {receiptError && <small role="alert">{receiptError}</small>}
                      </>
                    ) : (
                      <span className="privacy-muted">{row.value}</span>
                    )
                  ) : row.key === "veil" ? (
                    <span className={row.on ? undefined : "privacy-muted"}>{row.value}</span>
                  ) : (
                    row.value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
