// Secret Guard: spots passwords, API keys and tokens in text before it leaves
// the browser, and masks or removes them. Pure and DOM-free (no storage, no
// network), so the chat composer, Canvas, Routines and Research Watch share
// one detector and node tests run it. Nothing here logs, stores or sends
// what it finds.
//
// It sits beside Seed Guard (src/seed-guard.js), whose hard block for wallet
// seed phrases and keys is unchanged and always goes first (secretGuardTurn).
//
// Rules keep false positives low. Each needs one of:
// - a known public prefix or shape: GitHub, GitLab, Slack, Stripe live and
//   restricted keys, Google API keys, OpenAI-style and Anthropic keys,
//   Twilio, SendGrid, npm, AWS access key ids;
// - a checksum or structure: GitHub's CRC32 suffix, a JWT's JSON header, a
//   PEM private key's base64 body;
// - a label plus a high-entropy value: .env-style PASSWORD=, SECRET=,
//   TOKEN=, API_KEY= (and the same names in JSON, YAML or code), an
//   Authorization: Bearer header, a database URL's password, and an AWS
//   secret key next to its access key id.
// Random base64, UUIDs, git SHAs and transaction hashes match none of them.
//
// Several patterns are adapted from gitleaks' rules (MIT License,
// https://github.com/gitleaks/gitleaks, config/gitleaks.toml).

// --- Helpers -------------------------------------------------------------
export function entropy(s) {
  if (!s) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let e = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}
const classes = (s) =>
  [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
const hasDigitAndLetter = (s) => /\d/.test(s) && /[A-Za-z]/.test(s);

let crcTable = null;
export function crc32(str) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++)
    crc = crcTable[(crc ^ str.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const B62_LOWER_FIRST = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function base62(n, alphabet) {
  let s = "";
  do {
    s = alphabet[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s.padStart(6, "0");
}
// GitHub's tokens end in a 6-character base62 CRC32 of the 30 random
// characters before it. Both published readings of the scheme are accepted
// (with or without the prefix, either base62 alphabet order): a random
// 36-character run passes by chance about once in 10^10 tries.
export function githubChecksumValid(token) {
  const m = /^(gh[pousr]_)([A-Za-z0-9]{30})([A-Za-z0-9]{6})$/.exec(token);
  if (!m) return false;
  for (const input of [m[2], m[1] + m[2]]) {
    const c = crc32(input);
    if (base62(c, B62) === m[3] || base62(c, B62_LOWER_FIRST) === m[3]) return true;
  }
  return false;
}

function base64UrlJSON(part) {
  try {
    let s = part.replace(/-/g, "+").replace(/_/g, "/");
    s += "===".slice((s.length + 3) % 4);
    const value = JSON.parse(atob(s));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
// A JWT: a base64url JSON header naming its algorithm, and a JSON payload.
export function jwtValid(token) {
  const [header, payload] = token.split(".");
  const h = base64UrlJSON(header);
  return !!h && typeof h.alg === "string" && !!base64UrlJSON(payload);
}

// Values that stand in for a secret rather than being one.
const PLACEHOLDER_WORD =
  /^(?:changeme|change_me|password|passw0rd|secret|example|placeholder|dummy|sample|redacted|none|null|nil|undefined|true|false|string|required|optional|todo|tbd|test|testing|guest|admin|root|postgres|mysql|user|qwerty|123456|12345678)$/i;
function placeholderValue(v) {
  return (
    PLACEHOLDER_WORD.test(v) ||
    /^(.)\1*$/.test(v) ||
    /x{4,}|X{4,}|\*{3,}|\.{3,}|…|<[^>]*>|\$\{|\{\{|%\(|%s|\[(?:[A-Z]+_\d+)\]/.test(v) ||
    /(?:your|my|insert|enter|replace|put)[\s_-]*(?:own[\s_-]*)?(?:api|secret|token|key|pass)/i.test(v)
  );
}
// A value that names or computes the secret instead of holding it: another
// variable, a call, a path, a URL, a number, an address.
function referenceValue(v) {
  return (
    /^\$[A-Za-z_{(]/.test(v) ||
    /process\.env|os\.environ|getenv|import\.meta|ENV\[|secrets\.|^env:|^vault:|^urn:/i.test(v) ||
    // A constant: GITHUB_TOKEN, SECRET, AES-256-GCM, TOKEN_ERROR__FROZEN.
    /^[A-Z]+$|^[A-Z][A-Z0-9]*(?:[_-]+[A-Z0-9]+)+[_-]*$/.test(v) ||
    // Member access and code: a.b.c, a?.b, !x, x[0], a || b, ++i, f(x), x$1.
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[!?]?$/.test(v) ||
    /\?\.|\?\?|\|\||&&|==|[()[\]{}]|\$\d+$|^[!?&*@\\]|^(?:\+\+|--)|(?:\+\+|--)$|\?[^?]*:/.test(v) ||
    // Words joined by slashes: a route or method name, not a key.
    /^[A-Za-z]+(?:\/[A-Za-z]+)+$/.test(v) ||
    /0x[0-9a-fA-F]{40}/.test(v) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ||
    /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(v) ||
    /\.(?:pem|key|json|txt|p12|pfx|crt|env|ya?ml)$/i.test(v) ||
    /^[\d.,:_-]+$/.test(v) ||
    /^\d+[a-z]{0,3}$/i.test(v) ||
    // An address or hash (0x…): public, and Seed Guard reads a 64-hex key.
    /^0x[0-9a-fA-F]+$/.test(v) ||
    // A lower_snake_case name: permit2_token_mismatch, cl100k_base.
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(v) ||
    // An email address names someone; it isn't a secret.
    /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)
  );
}
// Words, not a secret: a value with no digit made only of letters, maybe
// joined by - _ or . ("same-origin", "maxTokens", "no-cache").
const wordsValue = (v) => !/\d/.test(v) && /^[A-Za-z]+(?:[-_.][A-Za-z]+)*[-_.]?$/.test(v);
// A code identifier made of words (getBaseTokenL1Address, tempoAddr0,
// p256PrivateKey): its letter runs are long. A random token's aren't
// (c9LPDaEvTjeB…): its case flips every character or two.
function identifierValue(v) {
  v = v.replace(/[!?]$/, "");
  if (!/^[A-Za-z_$][\w$]*$/.test(v)) return false;
  const runs = v.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [];
  const letters = runs.reduce((n, r) => n + r.length, 0);
  return runs.length > 0 && letters / runs.length >= 3 && letters >= v.replace(/[_$]/g, "").length * 0.7;
}
// A labelled value that reads like a secret: long enough, varied enough,
// and not a placeholder or a reference. `code` is a value written without
// quotes after a lowercase or camelCase name (apiKey: someVariable), where
// a name made of words is a variable, not the secret itself. An
// UPPER_CASE setting (.env, docker-compose) takes its value literally.
function secretValue(v, { code = false } = {}) {
  if (v.length < 8 || v.length > 256) return false;
  // Printable ASCII with no spaces: sentences and translated text aren't keys.
  if (!/^[\x21-\x7e]+$/.test(v)) return false;
  const bare = v.replace(/=+$/, "");
  if (placeholderValue(bare) || referenceValue(bare) || wordsValue(bare)) return false;
  if (code && identifierValue(bare)) return false;
  return entropy(v) >= 3 && (classes(v) >= 2 || v.length >= 16);
}

// --- Rules ---------------------------------------------------------------
// Each rule finds { start, end } spans (the part to mask) in a text. Order
// is priority: when two finds start at the same place the earlier rule
// wins, so a GitHub token assigned to TOKEN= is named as a GitHub token.
const regexRule = (id, label, pattern, check) => ({
  id,
  label,
  find(text) {
    const out = [];
    for (const m of text.matchAll(pattern))
      if (!check || check(m[0])) out.push({ start: m.index, end: m.index + m[0].length });
    return out;
  },
});

// PEM private keys: from the BEGIN line to its END line, or over the base64
// lines after it when the paste was cut short. The body must hold at least
// 64 base64 characters, so a lone header in prose isn't flagged.
const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ ){0,3})PRIVATE KEY( BLOCK)?-----/g;
const pemRule = {
  id: "pem",
  label: "Private key",
  find(text) {
    const out = [];
    let from = 0;
    for (const m of text.matchAll(PEM_BEGIN)) {
      if (m.index < from) continue;
      const start = m.index,
        headEnd = start + m[0].length;
      const endMarker = `-----END ${m[1]}PRIVATE KEY${m[2] || ""}-----`;
      const endAt = text.indexOf(endMarker, headEnd);
      let end;
      if (endAt >= 0 && endAt - headEnd < 64000) end = endAt + endMarker.length;
      else {
        // Cut short: the header lines ("Proc-Type: …"), then base64 lines
        // (20 characters or more, or padded), up to the first other line.
        const line = /\r?\n([A-Za-z-]+:[^\n]*|[A-Za-z0-9+/=]*)(?=\r?\n|$)/y;
        line.lastIndex = headEnd;
        end = headEnd;
        let l,
          seen = false;
        while ((l = line.exec(text))) {
          const row = l[1].trim();
          if (!row) {
            if (seen) break;
          } else if (/^[A-Za-z0-9+/=]+$/.test(row)) {
            if (row.length < 20 && !row.includes("=")) break;
            seen = true;
          } else if (seen) break;
          end = line.lastIndex;
        }
      }
      const body = text
        .slice(headEnd, end)
        .split(/\r?\n/)
        .filter((l) => !/^[A-Za-z-]+:/.test(l) && !l.startsWith("-----"))
        .join("")
        .replace(/[^A-Za-z0-9+/=]/g, "");
      if (body.length >= 64) {
        out.push({ start, end });
        from = end;
      }
    }
    return out;
  },
};

// .env-style assignments and the same names in JSON, YAML or code:
// PASSWORD=, DB_PASS:, "api_key": "…", const clientSecret = "…". Only the
// value is masked, and only a value that reads like a secret.
const ASSIGNMENT =
  /(?<![\w.$-])["'`]?([A-Za-z_][\w.-]{0,63})["'`]?[ \t]*(?:=|:=|:|=>)[ \t]*(?:(["'`])([^"'`\n]{8,256})\2|([^\s"'`,;#&<>=|]{8,256}={0,2}))/dg;
// A key's words, split on _ . - and camelCase: "dbPassword" → "db_password".
const keyWords = (key) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[.-]/g, "_");
const SECRET_KEY =
  /password|passwd|passphrase|(?:^|_)(?:pass|pwd|secret|secrets|token|tokens|apikey|credential|credentials)(?:_|$)|(?:^|_)(?:api|access|private|auth|secret|client|signing|encryption|master|app)_key(?:_|$)|clientsecret|apisecret/;
function keyLabel(words) {
  if (/(?:^|_)aws(?:_|$)/.test(words) && /secret|access/.test(words)) return "AWS secret key";
  if (/twilio/.test(words)) return "Twilio auth token";
  if (/pass|pwd/.test(words)) return "Password";
  if (/token/.test(words)) return "Access token";
  if (/key/.test(words)) return "API key";
  return "Secret";
}
const assignmentRule = {
  id: "assignment",
  label: "Secret",
  find(text) {
    const out = [];
    for (const m of text.matchAll(ASSIGNMENT)) {
      const words = keyWords(m[1]);
      if (words === "pwd" || words === "oldpwd" || !SECRET_KEY.test(words)) continue;
      // Tokens and counts named after tokens (MAX_TOKENS, token_type) hold
      // no secret; the value checks turn those away.
      const g = m[3] !== undefined ? 3 : 4;
      const value = m[g];
      const envStyle = /^[A-Z][A-Z0-9_]*$/.test(m[1]);
      if (!secretValue(value, { code: g === 4 && !envStyle })) continue;
      const [start, end] = m.indices[g];
      out.push({ start, end, label: keyLabel(words) });
    }
    return out;
  },
};

// An Authorization header's bearer token (a pasted curl command).
const BEARER = /\bauthorization["']?[ \t]*[:=][ \t]*["']?bearer[ \t]+([A-Za-z0-9._~+/=-]{20,})/dgi;
const bearerRule = {
  id: "bearer",
  label: "Access token",
  find(text) {
    const out = [];
    for (const m of text.matchAll(BEARER)) {
      if (entropy(m[1]) < 3.5 || placeholderValue(m[1])) continue;
      const [start, end] = m.indices[1];
      out.push({ start, end });
    }
    return out;
  },
};

// A database URL's password: postgres://app:<password>@host/db. Only the
// password is masked, so the rest of the URL still reads.
const DB_URL =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|cockroachdb|clickhouse):\/\/[^\s:@/]+:([^\s@/]+)@[^\s/?#]+/dgi;
const dbUrlRule = {
  id: "dburl",
  label: "Database password",
  find(text) {
    const out = [];
    for (const m of text.matchAll(DB_URL)) {
      const value = m[1];
      if (value.length < 3 || placeholderValue(value) || /^[$%{<]/.test(value)) continue;
      const [start, end] = m.indices[1];
      out.push({ start, end });
    }
    return out;
  },
};

// AWS: the access key id by its published prefixes, and its secret key (40
// base64 characters) on the same line or the next two, as in a credentials
// CSV or a console copy. A labelled secret is found by assignmentRule.
const AWS_ID = /(?<![A-Za-z0-9])(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}(?![A-Za-z0-9])/g;
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const awsSecretLike = (v) =>
  /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9/+]/.test(v) && entropy(v) >= 4;
const awsRule = {
  id: "aws",
  label: "AWS access key",
  find(text) {
    const out = [];
    for (const m of text.matchAll(AWS_ID)) {
      out.push({ start: m.index, end: m.index + m[0].length });
      let lineEnd = m.index;
      for (let i = 0; i < 3 && lineEnd >= 0; i++) lineEnd = text.indexOf("\n", lineEnd + 1);
      const near = text.slice(m.index + m[0].length, lineEnd < 0 ? text.length : lineEnd);
      for (const s of near.matchAll(AWS_SECRET))
        if (awsSecretLike(s[0])) {
          const start = m.index + m[0].length + s.index;
          out.push({ start, end: start + 40, label: "AWS secret key" });
          break;
        }
    }
    return out;
  },
};

const tailOf = (token) => token.replace(/^sk-(?:[a-z0-9]{2,8}-){0,2}/, "");
export const SECRET_RULES = [
  pemRule,
  regexRule(
    "github",
    "GitHub token",
    /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g,
    githubChecksumValid,
  ),
  regexRule("github", "GitHub token", /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{82}(?![A-Za-z0-9_])/g),
  regexRule(
    "gitlab",
    "GitLab token",
    /(?<![\w-])gl(?:pat|dt|rt|ptt|ft|soat|cbt|imt|oas)-[\w-]{20,}(?:\.[0-9a-z]{9})?(?![\w-])/g,
    (v) => entropy(v) >= 3,
  ),
  regexRule("slack", "Slack token", /(?<![\w-])xox[abpr]-\d+-[A-Za-z0-9-]{10,}(?![\w-])/g),
  regexRule("slack", "Slack token", /(?<![\w-])xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]{20,}(?![\w-])/g),
  regexRule("stripe", "Stripe live key", /(?<![\w])(?:sk|rk)_live_[A-Za-z0-9]{20,247}(?![A-Za-z0-9])/g),
  regexRule("google", "Google API key", /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g),
  regexRule(
    "anthropic",
    "Anthropic API key",
    /(?<![\w-])sk-ant-[a-z]+\d*-[A-Za-z0-9_-]{32,}(?![\w-])/g,
    (v) => hasDigitAndLetter(v),
  ),
  regexRule(
    "openai",
    "OpenAI-style API key",
    /(?<![\w-])sk-(?!ant-)(?:[a-z0-9]{2,8}-){0,2}[A-Za-z0-9_-]{32,}(?![\w-])/g,
    (v) => {
      const tail = tailOf(v);
      return hasDigitAndLetter(tail) && entropy(tail) >= 3.5 && /[A-Za-z0-9]{20,}/.test(tail);
    },
  ),
  regexRule("twilio", "Twilio API key", /(?<![A-Za-z0-9])SK[0-9a-f]{32}(?![A-Za-z0-9])/g, (v) => entropy(v) >= 3),
  regexRule("sendgrid", "SendGrid API key", /(?<![\w.-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![\w-])/g),
  regexRule(
    "npm",
    "npm token",
    /(?<![\w])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    (v) => hasDigitAndLetter(v.slice(4)) && entropy(v) >= 3.5,
  ),
  awsRule,
  regexRule(
    "jwt",
    "JSON Web Token",
    /(?<![\w-])ey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*(?![\w-])/g,
    jwtValid,
  ),
  dbUrlRule,
  bearerRule,
  assignmentRule,
];

// Every secret in `text`, in order and never overlapping:
// [{ rule, label, start, end, value }]. `value` is the part to mask.
export function findSecrets(text) {
  if (typeof text !== "string" || text.length < 8) return [];
  const raw = [];
  SECRET_RULES.forEach((rule, priority) => {
    for (const hit of rule.find(text))
      raw.push({ rule: rule.id, label: hit.label || rule.label, start: hit.start, end: hit.end, priority });
  });
  raw.sort(
    (a, b) => a.start - b.start || a.priority - b.priority || b.end - b.start - (a.end - a.start),
  );
  const out = [];
  let lastEnd = -1;
  for (const m of raw) {
    if (m.start < lastEnd) continue;
    out.push({ rule: m.rule, label: m.label, start: m.start, end: m.end, value: text.slice(m.start, m.end) });
    lastEnd = m.end;
  }
  return out;
}

// The 1-based line a position is on.
export const lineOf = (text, index) => {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
};

// How a find is shown: partly hidden, its first 4 and last 2 characters
// (a private key shows its base64 body's). Shorter values show less.
export function previewSecret(value, rule) {
  let v = value;
  if (rule === "pem")
    v = value
      .split(/\r?\n/)
      .filter((l) => !l.startsWith("-----") && !/^[A-Za-z-]+:/.test(l))
      .join("")
      .trim();
  if (v.length < 12) return v.slice(0, 2) + "••••" + v.slice(-1);
  return v.slice(0, 4) + "••••" + v.slice(-2);
}

// Everything a surface is about to send, as parts: [{ text, name? }] (a
// string counts as an unnamed part). Each find says where it is: the part,
// its file name if any, the line, and a partly hidden preview.
export function scanParts(parts) {
  const list = (Array.isArray(parts) ? parts : [parts])
    .flat(Infinity)
    .map((p) => (typeof p === "string" ? { text: p } : p))
    .filter((p) => p && typeof p.text === "string" && p.text);
  const finds = [];
  list.forEach((p, part) => {
    for (const f of findSecrets(p.text))
      finds.push({
        part,
        name: p.name || "",
        rule: f.rule,
        label: f.label,
        line: lineOf(p.text, f.start),
        preview: previewSecret(f.value, f.rule),
      });
  });
  return finds;
}

// --- Masking ---------------------------------------------------------------
// Placeholders use Veil's tag format ([SECRET_1]) and its state shape
// ({ map, counters, valueToTag }), so Veil's unveil() and its Markdown
// plugin put the real value back in the reply, in this browser only. The
// same value keeps the same tag for as long as the state lives.
export const SECRET_TAG = /^SECRET_\d+$/;
export function secretTag(state, value) {
  state.map ||= {};
  state.counters ||= {};
  state.valueToTag ||= {};
  const key = "SECRET\u0000" + value;
  let tag = state.valueToTag[key];
  if (!tag) {
    state.counters.SECRET = (state.counters.SECRET || 0) + 1;
    tag = `SECRET_${state.counters.SECRET}`;
    state.valueToTag[key] = tag;
    state.map[tag] = value;
  }
  return tag;
}
// Replaces each secret with its placeholder, recording it in `state`.
export function maskSecrets(text, state) {
  const finds = findSecrets(text);
  if (!finds.length) return { text: text || "", count: 0, tags: [] };
  let out = "",
    cursor = 0;
  const tags = [];
  for (const f of finds) {
    out += text.slice(cursor, f.start);
    const tag = secretTag(state, f.value);
    out += `[${tag}]`;
    tags.push(tag);
    cursor = f.end;
  }
  return { text: out + text.slice(cursor), count: finds.length, tags };
}
// Deletes each secret (a database URL loses its ":password").
export function removeSecrets(text) {
  const finds = findSecrets(text);
  if (!finds.length) return { text: text || "", count: 0 };
  let out = "",
    cursor = 0;
  for (const f of finds) {
    const start = f.rule === "dburl" && text[f.start - 1] === ":" ? f.start - 1 : f.start;
    out += text.slice(cursor, start);
    cursor = f.end;
  }
  return { text: out + text.slice(cursor), count: finds.length };
}

// The chat composer's parts: the typed prompt and each attached text file or
// document (a page Link Reader fetched is public text, not the user's, and
// isn't passed in). Masking or removing changes the prompt and each
// document's text; everything else about a document stays.
export function scanComposer({ prompt = "", documents = [] }) {
  return scanParts([{ text: prompt }, ...documents.map((d) => ({ text: d.text || "", name: d.name || "" }))]);
}
export function maskComposer({ prompt = "", documents = [] }, state) {
  let count = 0;
  const fix = (text) => {
    const r = maskSecrets(text, state);
    count += r.count;
    return r.text;
  };
  const next = {
    prompt: fix(prompt),
    documents: documents.map((d) => (d.source === "link" ? d : { ...d, text: fix(d.text || "") })),
  };
  return { ...next, count };
}
export function removeFromComposer({ prompt = "", documents = [] }) {
  let count = 0;
  const fix = (text) => {
    const r = removeSecrets(text);
    count += r.count;
    return r.text;
  };
  return {
    prompt: fix(prompt),
    documents: documents.map((d) => (d.source === "link" ? d : { ...d, text: fix(d.text || "") })),
    count,
  };
}

// Which guard speaks first. Seed Guard's notice always comes first; Secret
// Guard's waits until the person has answered it ("Send anyway" for a seed
// phrase, "It's not a key" for 64-hex), and never overrides it.
export function secretGuardTurn({ seedHit = null, finds = [], seedAnswered = false }) {
  if (seedHit && !seedAnswered) return "seed";
  return finds.length ? "secret" : null;
}

// Whether Secret Guard checks this surface: released, not the demo (which
// sends nothing), and not switched off for the account.
export const secretGuardActive = ({ released, demo = false, enabled = true }) =>
  !!released && !demo && enabled !== false;
