import React, { useEffect, useState } from "react";
import { Icon } from "./ui.jsx";
import { installHintFor, isReleased } from "./lib.js";
import "./install-app.css";

// Adds the installable-app shell — the manifest link, the apple-mobile-web-app
// meta tags and the service worker registration — but only once config
// confirms the "app" update is released (see server/releases.js). index.html
// itself never references any of this statically, so the app isn't
// installable while the update is off. Nothing happens until config has
// actually loaded: a failed or pending /api/config leaves everything as is.
export function useInstallAppGate(config) {
  useEffect(() => {
    if (!config) return;
    if (!isReleased(config, "app")) {
      // Only matters if the update is ever withdrawn after a release: retire
      // the worker and caches an earlier visit installed. Reading existing
      // registrations never creates one.
      retireServiceWorker();
      return;
    }
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = "/manifest.webmanifest";
      document.head.appendChild(link);
    }
    for (const [name, content] of [
      ["apple-mobile-web-app-capable", "yes"],
      ["mobile-web-app-capable", "yes"],
      // "default" keeps the page below the clock and notch. The translucent
      // style draws it underneath them, and nothing on the site pads for that.
      ["apple-mobile-web-app-status-bar-style", "default"],
      ["apple-mobile-web-app-title", "ANONYMA"],
    ]) {
      if (document.querySelector(`meta[name="${name}"]`)) continue;
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
    }
    // Only in built (production) bundles, and only where service workers are
    // actually usable (isSecureContext covers https and the loopback
    // addresses, e.g. a local test server on http://127.0.0.1).
    if (
      import.meta.env.PROD &&
      "serviceWorker" in navigator &&
      window.isSecureContext
    ) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, [config]);
}

function retireServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .getRegistrations()
    .then((list) => list.forEach((r) => r.unregister()))
    .catch(() => {});
  if (typeof caches !== "undefined")
    caches
      .keys()
      .then((names) =>
        names
          .filter((n) => n.startsWith("anonyma-"))
          .forEach((n) => caches.delete(n)),
      )
      .catch(() => {});
}

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // Safari's own flag, set once the app is added to the home screen.
    window.navigator?.standalone === true
  );
}

const HINTS = {
  ios: "Share → Add to Home Screen",
  mac: "File → Add to Dock",
};

function currentInstallHint() {
  if (typeof navigator === "undefined") return null;
  return installHintFor(
    navigator.userAgent || "",
    navigator.platform || "",
    navigator.maxTouchPoints || 0,
  );
}

// Surfaces the browser's install prompt when it offers one
// (beforeinstallprompt, Chromium/Edge/Android), or a one-line manual hint where
// the browser never fires that event (iPhone, iPad, Safari on a Mac).
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(isStandalone());
    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setDeferred(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  async function promptInstall() {
    if (!deferred) return;
    deferred.prompt();
    try {
      await deferred.userChoice;
    } catch {
      // Ignored: the prompt can be dismissed without a choice.
    }
    setDeferred(null);
  }
  const hint = !installed && !deferred ? currentInstallHint() : null;
  return {
    canInstall: !installed && !!deferred,
    hint: hint ? HINTS[hint] : null,
    promptInstall,
  };
}

// Unobtrusive sidebar entry: a real button when the browser can install the
// app, a one-line hint where installing is manual, and nothing otherwise.
export function InstallAppEntry() {
  const { canInstall, hint, promptInstall } = useInstallPrompt();
  if (canInstall)
    return (
      <button className="install-app-entry" onClick={promptInstall}>
        <Icon name="download" size={14} />
        Install app
      </button>
    );
  if (hint) return <p className="install-app-hint">{hint}</p>;
  return null;
}

// The same entry for the site footer, so visitors who aren't signed in can
// install the app too. Rendered only once the app update is released.
export function InstallAppFooterLink() {
  const { canInstall, hint, promptInstall } = useInstallPrompt();
  if (canInstall)
    return (
      <button type="button" className="install-app-footer" onClick={promptInstall}>
        Install app
      </button>
    );
  if (hint)
    return (
      <span className="install-app-footer-hint">
        <span>Install app</span>
        <small>{hint}</small>
      </span>
    );
  return null;
}
