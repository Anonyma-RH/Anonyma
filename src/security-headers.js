// Inline styles support React and wallet UI. Scripts stay same-origin; WASM
// supports the bundled animation renderer without enabling JavaScript eval.
//
// Live Preview (the "preview" update) runs previewed pages in their own
// frame document, served at PREVIEW_FRAME_PATH with previewFrameHeaders().
// A srcdoc, blob: or data: frame would inherit this page's policy (and its
// script-src 'self'), so previewed inline scripts couldn't run without
// loosening the app's own script-src. Instead the app's frame-src gains that
// one exact URL, and only once the update is live (`previewFrame`).
export function securityHeaders({ previewFrame } = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "media-src 'self' blob: https:",
      "worker-src 'self' blob:",
      // WalletConnect, RPC and signed provider media use HTTPS/WSS endpoints.
      "connect-src 'self' https: wss:",
      "frame-src " +
        [
          ...(previewFrame ? [previewFrame] : []),
          "https://verify.walletconnect.com",
          "https://verify.walletconnect.org",
        ].join(" "),
    ].join("; "),
    "Permissions-Policy":
      "camera=(), microphone=(self), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
}

// Where the preview frame document is served (server/routes/preview.js).
export const PREVIEW_FRAME_PATH = "/preview-frame.html";

// The policy every previewed page runs under. It is sent as the frame
// document's header and injected again as the first element of each
// previewed page (src/live-preview.js). Nothing may reach the network:
// scripts, styles, images, fonts and media come only from the page itself
// (inline, data: or blob:), and fetch/XHR/WebSocket, frames, workers, forms
// and <base> are refused.
export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' blob:",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// Headers for the preview frame document. `sandbox allow-scripts` gives it an
// opaque origin even if it were opened on its own; only the app itself may
// frame it.
export function previewFrameHeaders() {
  return {
    "Content-Security-Policy": `sandbox allow-scripts; ${PREVIEW_CSP}; frame-ancestors 'self'`,
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "X-DNS-Prefetch-Control": "off",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
    "Cache-Control": "no-cache",
  };
}
