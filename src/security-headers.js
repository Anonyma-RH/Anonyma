// Inline styles support React and wallet UI. Scripts stay same-origin; WASM
// supports the bundled animation renderer without enabling JavaScript eval.
export function securityHeaders() {
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
      "frame-src https://verify.walletconnect.com https://verify.walletconnect.org",
    ].join("; "),
    "Permissions-Policy":
      "camera=(), microphone=(self), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
}
