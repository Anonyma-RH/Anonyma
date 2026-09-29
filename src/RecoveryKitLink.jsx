import React from "react";
import { recoveryKitReleased } from "./recovery-kit.js";
import "./recovery-kit-link.css";

// Recovery Kit's "Use a recovery code", under the sign-in form once
// released. Kept apart from src/RecoveryKit.jsx so the sign-in page loads
// the rest of the flow only when someone opens it.
export function RecoveryKitLink({ config, onClick }) {
  if (!recoveryKitReleased(config)) return null;
  return (
    <button type="button" className="text-link recovery-link recovery-kit-link" onClick={onClick}>
      Use a recovery code
    </button>
  );
}
