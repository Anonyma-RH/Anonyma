import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "./context.jsx";
import { PageIntro } from "./Pages.jsx";
import { Icon, Notice, CopyButton, ComingSoon } from "./ui.jsx";
import { api, isReleased, releaseUpdate } from "./lib.js";
import { takeVerifyPrefill, verifyReceipt } from "./receipts.js";
import "./receipts.css";

const reasons = {
  unknown_key: "This receipt's key isn't recognized by this service.",
  invalid_signature: "The signature does not match this receipt. Something was changed.",
};
const snippet = (pem) =>
  `const crypto = require("node:crypto");\nconst publicKey = crypto.createPublicKey(${JSON.stringify(pem || "-----BEGIN PUBLIC KEY-----...")});\n\n// Sort object keys recursively before signing or verifying.\nconst canonical = (v) =>\n  Array.isArray(v) ? v.map(canonical)\n  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))\n  : v;\n\nconst bytes = Buffer.from(JSON.stringify(canonical(receipt)));\nconst signature = Buffer.from(signatureBase64, "base64");\nconsole.log(crypto.verify(null, bytes, publicKey, signature)); // true\n`;

function fieldTable(receipt) {
  const rows = [
    ["Model", receipt.model],
    [
      "Tokens",
      receipt.usage
        ? `${receipt.usage.input_tokens ?? "?"} in / ${receipt.usage.output_tokens ?? "?"} out`
        : "—",
    ],
    [
      "Credits",
      `${receipt.credits_charged ?? "?"} charged` +
        (receipt.credits_released ? ` · ${receipt.credits_released} released` : ""),
    ],
    ["Issued", receipt.issued ? new Date(receipt.issued).toLocaleString() : "—"],
    ["Key ID", receipt.key_id],
  ];
  return (
    <div className="table-scroll">
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th>{label}</th>
              <td data-i18n="off">{value ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default function Verify() {
  const { config } = useApp();
  const [text, setText] = useState(() => takeVerifyPrefill());
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [publicKey, setPublicKey] = useState(null);
  useEffect(() => {
    let ignore = false;
    api("/api/receipts/key")
      .then((k) => !ignore && setPublicKey(k))
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);
  const parsedReceipt = useMemo(() => {
    try {
      const parsed = JSON.parse(text).receipt;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }, [text]);
  async function submit(e) {
    e.preventDefault();
    setError("");
    setResult(null);
    setBusy(true);
    try {
      setResult(await verifyReceipt(text, answer.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (!isReleased(config, "receipts"))
    return (
      <main id="main">
        <PageIntro eyebrow="VERIFY A RECEIPT" title="Signed receipts">
          Check that a reply's signed receipt is genuine.
        </PageIntro>
        <div className="content-width">
          <ComingSoon update={releaseUpdate(config, "receipts")} />
        </div>
      </main>
    );
  return (
    <main id="main">
      <PageIntro
        eyebrow="VERIFY A RECEIPT"
        title="Check what ran, and what it cost."
      >
        Every settled reply gets a receipt signed with ANONYMA's Ed25519 key.
        Paste one below to confirm it's genuine, unaltered, and — if you have
        it — that a specific answer is the one it charged for.
      </PageIntro>
      <div className="content-width verify-layout">
        <form onSubmit={submit} className="form-panel">
          <label>
            Signed receipt (JSON)
            <textarea
              required
              rows="10"
              spellCheck="false"
              data-i18n="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='{"receipt": {...}, "signature": "..."}'
            />
          </label>
          <label>
            Answer text (optional)
            <textarea
              rows="4"
              data-i18n="off"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Paste the reply text to check it against this receipt"
            />
          </label>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
            <Icon name="shield" size={15} />
          </button>
          {error && <Notice type="error">{error}</Notice>}
        </form>
        {result && (
          <div className={"verify-result " + (result.valid ? "valid" : "invalid")}>
            <h2>
              <Icon name={result.valid ? "check" : "warning"} size={20} />
              {result.valid ? "Valid signature" : "Not valid"}
            </h2>
            <p>
              {result.valid
                ? "This receipt was signed by ANONYMA and has not been altered."
                : reasons[result.reason] || "This receipt could not be verified."}
            </p>
            {"answer_matches" in result && (
              <p className={result.answer_matches ? "match" : "mismatch"}>
                <Icon name={result.answer_matches ? "check" : "close"} size={15} />
                {result.answer_matches
                  ? "The answer text matches what was charged for."
                  : "The answer text does not match what was charged for."}
              </p>
            )}
            {parsedReceipt && fieldTable(parsedReceipt)}
          </div>
        )}
        <div className="verify-key">
          <h2>Verify it yourself</h2>
          <p>
            No account or network call is required: verify offline with the
            public key below.
          </p>
          {publicKey && (
            <>
              <code className="key-secret">{publicKey.public_key_pem}</code>
              <CopyButton text={publicKey.public_key_pem} label="Copy public key" />
            </>
          )}
          <div className="code-example">
            <div>
              <span>NODE.JS</span>
              <CopyButton text={snippet(publicKey?.public_key_pem)} />
            </div>
            <pre>
              <code>{snippet(publicKey?.public_key_pem)}</code>
            </pre>
            <small>
              Also published at /api/receipts/key and
              /.well-known/anonyma-receipts.json.
            </small>
          </div>
        </div>
      </div>
    </main>
  );
}
