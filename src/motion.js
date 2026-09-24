// One motion switch for the whole site. It follows the system "reduce motion"
// setting unless the visitor overrides it with the landing page's motion
// button (remembered in this browser). It sets <html data-motion="on|off">;
// the stylesheets key their reduced-motion rules on data-motion="off".
import { useSyncExternalStore } from "react";

const system = matchMedia("(prefers-reduced-motion: reduce)");
const listeners = new Set();
let choice = null; // "on", "off", or null to follow the system
try {
  choice = localStorage.getItem("anonyma-motion");
} catch {}

// Shaped like a MediaQueryList so existing callers keep using .matches.
export const reducedMotion = {
  get matches() {
    return choice === "off" || (choice !== "on" && system.matches);
  },
  addEventListener: (_, fn) => listeners.add(fn),
  removeEventListener: (_, fn) => listeners.delete(fn),
};

function changed() {
  document.documentElement.dataset.motion = reducedMotion.matches ? "off" : "on";
  listeners.forEach((fn) => fn());
}
system.addEventListener("change", changed);
changed();

export function setMotion(on) {
  choice = on ? "on" : "off";
  try {
    localStorage.setItem("anonyma-motion", choice);
  } catch {}
  changed();
}

export function useReducedMotion() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => reducedMotion.matches,
  );
}
