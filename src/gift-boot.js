// Imported by main.jsx right after sealed-boot.js, before the app: on
// /gift, a gift link's #code leaves the address bar at once and is kept
// for this tab only (src/gift-links.js), so no other code, history entry or
// bookmark ever holds it. A link pasted over the open page changes only the
// fragment, so it's taken out the same way and the page is told.
import { captureGiftCode, GIFT_CODE_EVENT } from "./gift-links.js";

captureGiftCode();
if (typeof window !== "undefined")
  window.addEventListener("hashchange", () => {
    if (captureGiftCode()) window.dispatchEvent(new Event(GIFT_CODE_EVENT));
  });
