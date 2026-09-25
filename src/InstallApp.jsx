import React, { useEffect, useState } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import "./install-app.css";

// Adds the installable-app shell — the manifest link, the apple-mobile-web-app
// meta tags and the service worker registration — but only once config
// confirms the "app" update is released (see server/releases.js). index.html
// itself never references any of this statically, so the app isn't
// installable while the update is off. Requires an actually-loaded config:
// isReleased() treats a still-loading (null) config as released so the rest
// of the app doesn't flash a locked state, but that default would defeat
// this gate on every page load (the effect below always runs before the
// initial /api/config fetch resolves), so wait for the real config instead.
export function useInstallAppGate(config) {
  useEffect(() => {
    if (!config || !isReleased(config, "app")) return;
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = "/manifest.webmanifest";
      document.head.appendChild(link);
    }
    for (const [name, content] of [
      ["apple-mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-status-bar-style", "black-translucent"],
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

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // Safari's own flag, set once the app is added to the home screen.
    window.navigator?.standalone === true
  );
}

function isIOSSafari() {
  const ua = navigator.userAgent || "";
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ requests desktop sites and reports as a Mac; multi-touch
    // is the tell.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const otherBrowserOnIOS = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return iOS && !otherBrowserOnIOS;
}

// Surfaces the browser's install prompt when it offers one
// (beforeinstallprompt, Chromium/Edge/Android), or a one-line manual hint on
// iOS Safari, which never fires that event.
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
  return {
    canInstall: !installed && !!deferred,
    showIOSHint: !installed && !deferred && isIOSSafari(),
    promptInstall,
  };
}

// Unobtrusive sidebar entry: a real button when the browser can install the
// app, a one-line hint on iOS Safari, and nothing otherwise.
export function InstallAppEntry() {
  const { canInstall, showIOSHint, promptInstall } = useInstallPrompt();
  if (canInstall)
    return (
      <button className="install-app-entry" onClick={promptInstall}>
        <Icon name="download" size={14} />
        Install app
      </button>
    );
  if (showIOSHint)
    return (
      <p className="install-app-hint">Share → Add to Home Screen</p>
    );
  return null;
}
