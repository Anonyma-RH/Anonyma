// Imported first by main.jsx, so it runs before any other module: a sealed
// share link's key leaves the address bar before anything could read it
// (src/sealed-share.js). A link pasted over the open page changes only the
// fragment, which reloads nothing, so that key is taken out the same way and
// the page is told to open it.
import { captureShareKey, SEALED_KEY_EVENT } from "./sealed-share.js";

captureShareKey();
if (typeof window !== "undefined")
  window.addEventListener("hashchange", () => {
    if (!String(window.location.hash).startsWith("#k=")) return;
    captureShareKey();
    window.dispatchEvent(new Event(SEALED_KEY_EVENT));
  });
