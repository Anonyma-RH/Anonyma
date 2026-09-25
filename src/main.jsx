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
// The installable app shell (manifest link, apple-mobile-web-app meta tags,
// service worker registration) is added from within the app once config
// confirms the "app" update is released — see useInstallAppGate in
// InstallApp.jsx, called from context.jsx. index.html never references any
// of it statically, so the app isn't installable while the update is off.
