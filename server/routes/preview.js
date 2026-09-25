import {
  PREVIEW_FRAME_PATH,
  previewFrameHeaders,
} from "../../src/security-headers.js";

// Live Preview (the "preview" update). The app frames this one document with
// sandbox="allow-scripts" and posts it the page to show (src/LivePreview.jsx,
// src/live-preview.js). Nothing runs here: the server only hands out this
// fixed page, which carries its own strict policy (previewFrameHeaders), and
// never sees what is previewed.
//
// The page waits for one message from the window that framed it, on the
// app's own origin, then replaces itself with that document. It asks for the
// document once it is listening, so none is lost to a race.
export const PREVIEW_FRAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Preview</title></head>
<body><script>
(function () {
  var origin = location.origin;
  function receive(event) {
    if (event.source !== parent || event.origin !== origin) return;
    var data = event.data;
    if (!data || data.type !== "anonyma-preview:render" || typeof data.html !== "string") return;
    removeEventListener("message", receive);
    document.open();
    document.write(data.html);
    document.close();
  }
  addEventListener("message", receive);
  if (parent !== window) parent.postMessage({ type: "anonyma-preview:ready" }, origin);
})();
</script></body></html>
`;

export function previewRoutes({ app }) {
  app.get(PREVIEW_FRAME_PATH, (req, res) => {
    // Only ever a frame: a browser that says it's loading something else
    // (a tab, an image, a script) gets nothing.
    const dest = req.get("sec-fetch-dest");
    if (dest && dest !== "iframe") return res.status(404).end();
    res.set(previewFrameHeaders());
    res.type("html").send(PREVIEW_FRAME_HTML);
  });
}
