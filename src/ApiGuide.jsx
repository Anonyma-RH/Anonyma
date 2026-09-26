import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { CopyButton, Notice } from "./ui.jsx";
import { featureEnabled } from "./release-copy.js";
import { ApiGuideLimits } from "./ApiBoost.jsx";
import { apiBoostOf } from "./api-boost.js";

export function ApiExample() {
  const { config } = useApp();
  if (!featureEnabled(config, "api")) return null;
  const origin = globalThis.location?.origin || "https://YOUR_ANONYMA_DOMAIN";
  const example = `curl '${origin}/v1/chat/completions' \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H "Idempotency-Key: $REQUEST_ID" \\\n  -d '{"model":"YOUR_CALLABLE_CHAT_MODEL_ID",\n       "messages":[{"role":"user","content":"Hello"}],\n       "max_tokens":256,"stream":true}'`;
  return (
    <div className="code-example">
      <div>
        <span>CHAT COMPLETIONS</span>
        <CopyButton text={example} />
      </div>
      <pre>
        <code>{example}</code>
      </pre>
      <small>
        Set ANONYMA_API_KEY privately, choose a callable chat model, and set
        REQUEST_ID to a unique ID for this logical request. Reuse it only when
        retrying that same request.
      </small>
    </div>
  );
}

export default function ApiGuide() {
  const { config } = useApp();
  if (!featureEnabled(config, "api")) return null;
  return (
    <div className="api-guide">
      <Notice>
        {config.testMode
          ? "Local test API: responses and credits are fixtures."
          : "Developer API is enabled for this installation. Provider and model availability still apply."}
      </Notice>
      <h3>Connect and authenticate</h3>
      <p>
        Create a key in <Link to="/account/keys">Account → API keys</Link>; the
        secret is shown once. Keep it on your server. Send{" "}
        <code>Authorization: Bearer YOUR_KEY</code> to authenticated endpoints.
        A browser session cookie does not replace an API key. Clients use this
        website’s origin with <code>/v1</code> as the base URL.
      </p>
      {["mcp", "allowances", "connect"].every((id) =>
        featureEnabled(config, id),
      ) && (
        <p>
          MCP clients can also connect in one click: OAuth 2.1 with PKCE (S256)
          and dynamic registration of public clients, discovered from{" "}
          <code>/.well-known/oauth-protected-resource/mcp</code>. You approve
          each app with its own budget and expiry. Its access token works only
          on <code>/mcp</code>, never on <code>/v1</code>, and it carries no
          identity. The discovery, registration, token and revocation
          endpoints allow cross-origin calls without credentials.
        </p>
      )}
      <ul>
        <li>
          <code>GET /v1</code> — free connection check. Optional Bearer
          authentication; invalid or absent keys report unauthenticated.
          Terminal user agents receive text, other clients JSON.
        </li>
        <li>
          <code>GET /v1/models</code> — authenticated model list with id,
          object, owned_by and created. It can include image models; use type
          metadata from <code>/api/models</code> to select a chat model for chat
          completions.
        </li>
        <li>
          <code>GET /v1/balance</code> — authenticated{" "}
          <code>{'{"balance":1000,"available":950}'}</code>, in credits.
          Available excludes request holds; 1 USD = 1,000 credits.
        </li>
        <li>
          <code>POST /v1/chat/completions</code> — authenticated chat
          generation, billed to the account’s prepaid balance and subject to the
          key’s rolling 24-hour cap.
        </li>
      </ul>
      <h3>Request fields and limits</h3>
      <p>
        Send JSON with model and messages. Roles are system, user or assistant;
        API content must be a string. Array-content messages are skipped, the
        latest 40 usable messages are kept, and retained text is limited to
        120,000 characters. The body limit is 256 KB.
      </p>
      <p>
        max_tokens defaults to 4096, must be a positive integer, and is clamped
        to 8192. stream defaults to false; only true enables streaming.
        web_search: true (or plugins: [&#123;id: &quot;web&quot;&#125;])
        requests web search with the configured search fee. Other optional
        fields, including temperature, tools and response_format, are ignored.
        Tool calling, embeddings, audio and the Responses API are unsupported.
        This is a limited compatible interface, not support for every OpenAI
        client feature.
      </p>
      <ApiGuideLimits config={config} />
      <ApiExample />
      <h3>Responses and streaming</h3>
      <p>
        JSON responses include choices[0].message.content, usage and
        anonyma.credits_charged. The anonyma extension includes request_id and
        any citations; askr is a legacy alias. With stream: true, parse SSE data
        events, accumulate choices[].delta, read the final usage/charge event
        (which has empty choices), and finish at [DONE]. An error event can
        follow HTTP 200, so inspect every event.
      </p>
      <h3>Retries, charges and errors</h3>
      <p>
        Send a unique Idempotency-Key header (1–200 characters) for each logical
        paid request. It overrides the optional requestId body field. Repeating
        an accepted ID returns 409 duplicate_request without replaying output or
        charging again. If you omit both, the server generates a new ID on every
        attempt; blindly retrying can cause another charge. After an uncertain
        response, reuse the same ID and inspect account activity before starting
        new work.
      </p>
      <ul>
        <li>401 invalid_api_key — missing, invalid or revoked key.</li>
        <li>
          402 insufficient_credits — available balance cannot cover the
          reservation.
        </li>
        <li>
          403 feature_unreleased — the requested feature has not been enabled.
        </li>
        <li>
          404 model_not_found or unsupported_endpoint; 400 unsupported_model —
          check model and route.
        </li>
        {apiBoostOf(config) ? (
          <li>
            429 — rate limit or key_cap_exceeded. See the rate limits above;
            each key can also have a rolling 24-hour credit cap.
          </li>
        ) : (
          <li>
            429 — rate limit or key_cap_exceeded. Chat completions allows 120
            requests per minute per IP; each key can also have a rolling
            24-hour credit cap.
          </li>
        )}
        {featureEnabled(config, "allowances") && (
          <li>
            402 allowance_exhausted, 403 key_paused or key_expired — the key’s
            agent allowance is used up, paused or past its expiry.
          </li>
        )}
        {featureEnabled(config, "limits") && (
          <li>
            402 spending_limit — the request would go over the account’s own
            daily or monthly spending limit. Nothing is reserved; the
            spending_limit object says which limit and frees_at when room
            frees up.
          </li>
        )}
        <li>
          502 provider_unreadable or 504 provider_timeout — generation failed
          and the base estimate may still be charged.
        </li>
      </ul>
      <p>
        Errors include error.message, error.code, error.type and error.param.
        Errors with a charge include anonyma.credits_charged. Stopping or losing
        the connection may still incur charges for accepted work or partial
        output. Read the <Link to="/docs/billing">billing rules</Link> before
        integrating.
      </p>
      <h3>Contract and CLI</h3>
      <p>
        <a href="/api/openapi.json">The OpenAPI contract</a> follows this
        installation’s release gates. Cookie-authenticated /api routes serve the
        web workspace. No cross-origin browser access is enabled. CLI downloads
        are available at <a href="/cli.mjs">/cli.mjs</a>,{" "}
        <a href="/install.sh">/install.sh</a> and{" "}
        <a href="/install.ps1">/install.ps1</a> when Developer API &amp; CLI is
        enabled.
      </p>
    </div>
  );
}
