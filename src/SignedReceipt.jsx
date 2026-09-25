import React from "react";
import { useNavigate } from "react-router-dom";
import { Icon, CopyButton } from "./ui.jsx";
import { copyableReceipt, stashForVerify } from "./receipts.js";
import "./receipts.css";

// Shown next to a settled reply's cost once the receipts update is live:
// proof the reply is the one that was charged for, checkable by anyone.
export default function SignedReceipt({ signedReceipt }) {
  const navigate = useNavigate();
  if (!signedReceipt) return null;
  return (
    <span className="signed-receipt">
      <span className="signed-tag">
        <Icon name="shield" size={12} />
        Signed
      </span>
      <CopyButton
        text={copyableReceipt(signedReceipt)}
        label="Copy signed receipt"
      />
      <button
        type="button"
        className="small-button"
        onClick={() => {
          stashForVerify(signedReceipt);
          navigate("/verify");
        }}
      >
        <Icon name="external" size={14} />
        Verify
      </button>
    </span>
  );
}
