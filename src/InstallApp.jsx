import React, { useEffect, useState } from "react";
import { Icon } from "./ui.jsx";
import "./install-app.css";

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
