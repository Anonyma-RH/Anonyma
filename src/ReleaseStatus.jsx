import React from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { releaseCopy } from "./release-copy.js";
import { Notice } from "./ui.jsx";

export default function ReleaseStatus({ payment = false }) {
  const { config } = useApp();
  const copy = releaseCopy(config);
  return (
    <Notice>
      <strong>{copy.label}</strong>
      {" · "}
      {copy.summary} {payment && <>{copy.payment} </>}
      <Link to="/roadmap">See feature availability</Link>.
    </Notice>
  );
}
