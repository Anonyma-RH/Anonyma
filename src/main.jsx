import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/gfs-didot/latin-400.css";
import "@fontsource/gfs-didot/greek-400.css";
import "./fonts.css";
import App from "./App.jsx";
import "./styles.css";
import "./reference.css";
import "./brand.css";
import "./workspace.css";
// A referral link (?ref=CODE) is remembered for 30 days so whichever sign-in
// method the visitor uses later is credited to the person who shared it.
const ref = new URLSearchParams(location.search).get("ref");
if (ref && /^[a-z0-9]{6,16}$/i.test(ref))
  document.cookie = `anonyma_ref=${ref.toLowerCase()}; Max-Age=2592000; Path=/; SameSite=Lax`;
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
// Installable app shell. Only in built (production) bundles, and only where
// service workers are actually usable (isSecureContext covers https and the
// loopback addresses, e.g. a local test server on http://127.0.0.1).
if (
  import.meta.env.PROD &&
  "serviceWorker" in navigator &&
  window.isSecureContext
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
