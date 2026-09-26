// Injection Shield: finds the tricks a document can use to steer a model,
// before the document is sent. Pure and DOM-free so it runs in the browser
// and in node tests. Nothing here is logged, stored or sent: the workspace
// shows the findings and sends only the text the user chose to send.
//
// Part A (incoming text): attached documents, saved files and long pastes.
// - Invisible characters: zero-width (U+200B–U+200F, U+2060–U+2064,
//   U+FEFF), bidi controls (U+202A–U+202E, U+2066–U+2069), Unicode tag
//   characters (U+E0000–U+E007F, "ASCII smuggling", decoded to show what
//   they spell) and runs of variation selectors (bytes hidden after a
//   character, decoded the same way). Legitimate uses are left alone: a
//   byte-order mark, joiners inside emoji and in scripts that need them,
//   direction marks in right-to-left text, flag tag sequences, one
//   variation selector after an emoji or an ideograph.
// - Instruction-like phrases aimed at a model ("ignore previous
//   instructions", "you are now…", fake system prompts, "don't tell the
//   user", "send … to http…"), in English and Chinese with the basics in a
//   few more languages. They're matched on the visible text, so invisible
//   characters or full-width letters inside a phrase don't hide it.
// - Hidden-text markers where they're cheap to see: HTML comments and
//   CSS-hidden elements in text files, and the passages the PDF and DOCX
//   extractors report as hidden (see pdfHiddenText and file-formats.js).
//
// Part B (outgoing leaks) is in the renderer (src/Shield.jsx) with the URL
// helpers at the end of this file.
import { MAX_TOTAL_CHARS } from "./documents.js";

// Only what can be sent is scanned: attached text is capped at this many
// characters in total (documents.js applyBudget), so the rest never leaves.
export const SCAN_LIMIT = MAX_TOTAL_CHARS;
// A paste this long is treated as text from outside: every paste is checked
// for invisible characters, but only long ones for instruction-like phrases
// (a short paste is usually the user's own words).
export const LARGE_PASTE = 2000;
// Findings kept for the panel; counts go on past this.
const MAX_FINDINGS = 200;

// --- Invisible characters ---------------------------------------------------
export const INVISIBLE_CLASSES = ["zeroWidth", "bidi", "tag", "variation"];
export function invisibleClass(cp) {
  if ((cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff)
    return "zeroWidth";
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return "bidi";
  if (cp >= 0xe0000 && cp <= 0xe007f) return "tag";
  if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return "variation";
  return null;
}
const EMOJI_BEFORE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u20E3]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Scripts whose spelling uses ZWJ/ZWNJ (Persian, Urdu, the Indic scripts…).
const JOINING =
  /[\p{sc=Arabic}\p{sc=Syriac}\p{sc=Nko}\p{sc=Mongolian}\p{sc=Devanagari}\p{sc=Bengali}\p{sc=Gurmukhi}\p{sc=Gujarati}\p{sc=Oriya}\p{sc=Tamil}\p{sc=Telugu}\p{sc=Kannada}\p{sc=Malayalam}\p{sc=Sinhala}\p{sc=Myanmar}\p{sc=Khmer}\p{sc=Thaana}\p{sc=Tibetan}\p{sc=Hebrew}]/u;
const RTL = /[\p{sc=Hebrew}\p{sc=Arabic}\p{sc=Syriac}\p{sc=Thaana}\p{sc=Nko}]/u;
const IDEOGRAPH = /\p{Ideographic}/u;
const ch = (cp) => (cp == null ? "" : String.fromCodePoint(cp));
function cpBefore(text, i) {
  if (i <= 0) return null;
  const low = text.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(i - 2);
  }
  return low;
}
const cpAt = (text, i) => (i < text.length ? text.codePointAt(i) : null);
const width = (cp) => (cp > 0xffff ? 2 : 1);

// UTF-8 bytes hidden in variation selectors: VS1–VS16 are 0–15 and
// VS17–VS256 are 16–255.
const vsByte = (cp) => (cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16);
function decodeBytes(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}
// Tag characters mirror printable ASCII at U+E0020–U+E007E.
function decodeTags(text, start, end) {
  let out = "";
  for (let i = start; i < end; ) {
    const cp = text.codePointAt(i);
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
    i += width(cp);
  }
  return out;
}
const printable = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, "").trim();

// Every run of invisible characters in `text`: { start, end, cls, count }
// for the ones Shield flags, plus the messages hidden in tag characters or
// variation selectors ({ start, end, cls, decoded }).
export function scanInvisible(text) {
  const runs = [],
    messages = [],
    counts = { zeroWidth: 0, bidi: 0, tag: 0, variation: 0 };
  let rtl = null;
  const isRtlDoc = () => (rtl ??= RTL.test(text));
  const flag = (start, end, cls, count) => {
    counts[cls] += count;
    const last = runs.at(-1);
    if (last && last.cls === cls && last.end === start) {
      last.end = end;
      last.count += count;
    } else runs.push({ start, end, cls, count });
  };
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const cls = invisibleClass(cp);
    if (!cls) {
      i += width(cp);
      continue;
    }
    if (cls === "tag" || cls === "variation") {
      // The whole run of the same kind at once.
      let j = i,
        n = 0;
      const bytes = [];
      while (j < text.length) {
        const c = text.codePointAt(j);
        if (invisibleClass(c) !== cls) break;
        if (cls === "variation") bytes.push(vsByte(c));
        j += width(c);
        n++;
      }
      const prev = cpBefore(text, i);
      if (cls === "tag") {
        // An emoji flag for a region (England, Scotland, Wales): the black
        // flag, a few lowercase letters or digits in tags, a cancel tag.
        const inner = decodeTags(text, i, j);
        const last = text.codePointAt(j - 2);
        const flagSequence =
          prev === 0x1f3f4 && last === 0xe007f && /^[a-z0-9]{2,7}$/.test(inner);
        if (!flagSequence) {
          flag(i, j, cls, n);
          if (printable(inner)) messages.push({ start: i, end: j, cls, decoded: printable(inner) });
        }
      } else {
        // One selector picks an emoji's or a symbol's presentation, or an
        // ideograph's variant; a run of them carries bytes.
        const legit =
          n === 1 &&
          (text.codePointAt(i) <= 0xfe0f || IDEOGRAPH.test(ch(prev)));
        if (!legit) {
          flag(i, j, cls, n);
          const decoded = printable(decodeBytes(bytes));
          if (n > 1 && decoded.length >= 2) messages.push({ start: i, end: j, cls, decoded });
        }
      }
      i = j;
      continue;
    }
    const prev = cpBefore(text, i),
      next = cpAt(text, i + 1);
    let legit = false;
    if (cp === 0xfeff && i === 0) legit = true;
    else if (cp === 0x200d && EMOJI_BEFORE.test(ch(prev)) && PICTOGRAPHIC.test(ch(next)))
      legit = true;
    else if ((cp === 0x200c || cp === 0x200d) && JOINING.test(ch(prev)) && JOINING.test(ch(next)))
      legit = true;
    else if ((cp === 0x200e || cp === 0x200f) && isRtlDoc()) legit = true;
    // Embeddings and isolates are ordinary in right-to-left text; the two
    // overrides, which visibly reorder text, are always flagged.
    else if (cls === "bidi" && cp !== 0x202d && cp !== 0x202e && isRtlDoc()) legit = true;
    if (!legit) flag(i, i + 1, cls, 1);
    i += 1;
  }
  const total = counts.zeroWidth + counts.bidi + counts.tag + counts.variation;
  return { total, counts, runs, messages };
}

// The text with Shield's hidden characters taken out and compatibility forms
// (full-width letters, mathematical letters, ligatures) folded to ASCII,
// plus where each character came from, so a phrase broken up by zero-width
// characters or dressed in look-alike letters still matches.
export function projectVisible(text) {
  let out = "";
  const starts = [],
    ends = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i),
      w = width(cp);
    if (!invisibleClass(cp)) {
      let piece = text.slice(i, i + w);
      if (cp >= 0x2000) {
        const folded = piece.normalize("NFKC");
        if (folded !== piece && /^[\x20-\x7e]+$/.test(folded)) piece = folded;
      }
      for (let k = 0; k < piece.length; k++) {
        starts.push(i);
        ends.push(i + w);
      }
      out += piece;
    }
    i += w;
  }
  return { visible: out, starts, ends };
}

// --- Instruction-like phrases --------------------------------------------
// Each pattern is a phrase a document has no business saying to a model.
// They're deliberately narrow: an article about AI, a manual or a contract
// shouldn't trip them (tests/shield.test.mjs keeps a set of ordinary
// documents clean). Every pattern is bounded, so a long document can't make
// one backtrack for long.
export const CATEGORIES = {
  override: "Tells the AI to ignore its instructions",
  role: "Tries to give the AI a new role or remove its limits",
  system: "Poses as a system prompt or asks for yours",
  secrecy: "Asks the AI to keep something from you",
  exfil: "Tries to send data to a web address",
  addressed: "Speaks directly to an AI reading the document",
};
const EARLIER =
  "(?:previous|prior|above|earlier|preceding|foregoing|former|original|initial|system|existing|old|all\\s+other)";
const ORDERS =
  "(?:instructions?|prompts?|directions?|directives?|rules|guidelines|messages?|context|commands?|orders|programming|constraints|guardrails)";
const DATA =
  "(?:conversation|chat|history|messages?|data|information|info|details|contents?|credentials?|passwords?|api\\s*keys?|tokens?|secrets?|e-?mails?|summary|context|replies|answers?|the\\s+user['’]?s?|personal|documents?|files?|cookies?)";
const PHRASES = [
  // --- override
  ["override", new RegExp(`\\b(?:ignore|disregard|forget|override|skip|bypass|abandon|discard)\\s+(?:all\\s+|any\\s+|every\\s+|each\\s+)?(?:of\\s+)?(?:the\\s+|your\\s+|my\\s+|these\\s+|those\\s+)?${EARLIER}\\s+${ORDERS}\\b`, "giu")],
  ["override", /\b(?:ignore|disregard|forget)\s+(?:all|everything)\s+(?:(?:you\s+(?:were|have\s+been|had\s+been)\s+told)|(?:(?:that\s+)?(?:came\s+|was\s+|is\s+)?(?:before|above|earlier|previously)))\b/giu],
  ["override", /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+)?(?:your|its)\s+(?:instructions|rules|guidelines|programming|training|safety\s+(?:rules|guidelines|policies|filters)|content\s+polic(?:y|ies)|guardrails)\b/giu],
  ["override", /\byour\s+(?:new|real|actual|true|updated|revised)\s+(?:instructions|task|goal|objective|purpose|orders)\s+(?:is|are)\b/giu],
  ["override", /\b(?:ignora|ignore|olvida|olvide)\s+(?:todas\s+)?(?:las\s+)?instrucciones\s+(?:anteriores|previas)/giu],
  ["override", /\b(?:ignore[sz]?|oublie[sz]?)\s+(?:toutes\s+)?(?:les\s+)?instructions\s+(?:précédentes|antérieures|ci-dessus)/giu],
  ["override", /\b(?:ignoriere|ignorieren\s+sie|vergiss|vergessen\s+sie)\s+(?:alle\s+)?(?:vorherigen|bisherigen|vorigen|obigen)\s+(?:anweisungen|instruktionen|befehle)/giu],
  ["override", /(?:игнорируй|игнорируйте|забудь|забудьте)\s+(?:все\s+)?(?:предыдущие|прежние)\s+(?:инструкции|указания)/giu],
  ["override", /(?:以前|前|上記|これまで)の(?:指示|命令|指令)を(?:すべて|全て)?(?:無視|忘れ)/gu],
  ["override", /(?:请)?(?:忽略|无视|忽视|不要理会|别管|忘记|忘掉)(?:掉)?(?:你)?(?:之前|以前|先前|此前|上面|上述|以上|前面|前述|原来|原有|所有|全部|一切)(?:的)?(?:所有|全部|一切)?(?:的)?(?:指令|指示|说明|提示词?|规则|要求|设定|命令|对话|限制)/gu],
  // --- role
  ["role", /\byou\s+are\s+now\s+(?:(?:a|an|the|my|in|acting\s+as|operating\s+(?:as|in))\s+)?(?:[\w-]+\s+){0,3}?(?:ai|assistant|chatbot|bot|dan|persona|character|mode|jailbroken|unrestricted|unfiltered|uncensored|free\s+from)\b/giu],
  ["role", /\bfrom\s+now\s+on,?\s+(?:you\s+(?:are|will|must|shall|should)\s+)?(?:only\s+)?(?:act|behave|respond|reply|answer|pretend|roleplay|role-play|play)\s+(?:as|like|only|in)\b/giu],
  ["role", /\b(?:act|behave|respond|operate)\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|rogue|amoral|unaligned)\b/giu],
  ["role", /\bpretend\s+(?:that\s+)?(?:you\s+are|to\s+be|you['’]re)\b[^.\n]{0,60}?\b(?:no|without)\s+(?:any\s+)?(?:restrictions|rules|limits|filters|guidelines|censorship)\b/giu],
  ["role", /\byou\s+(?:have|has)\s+no\s+(?:restrictions|rules|limits|limitations|filters|guidelines|content\s+polic(?:y|ies))\b/giu],
  ["role", /\bdo\s+anything\s+now\b/giu],
  ["role", /\b(?:developer|god|jailbreak|dan|sudo)\s+mode\s+(?:is\s+)?(?:now\s+)?(?:enabled|activated|on|unlocked)\b/giu],
  ["role", /\b(?:enable|activate|enter)\s+(?:developer|jailbreak|dan|god)\s+mode\b/giu],
  ["role", /(?:你现在是|从现在(?:开始|起)[，,]?\s*你(?:是|将|要|必须|只能)?)(?:一个|一名)?[^。\n]{0,20}?(?:没有|不受|无|解除|摆脱)(?:任何)?(?:限制|约束|审查|过滤|规则)/gu],
  ["role", /(?:你现在是|从现在(?:开始|起)[，,]?\s*你(?:就)?(?:是|将是|要扮演)|扮演|进入)[^。\n]{0,10}?(?:DAN|越狱模式|开发者模式)/giu],
  ["role", /(?:越狱模式|开发者模式)(?:已)?(?:启用|开启|激活)/gu],
  // --- system
  ["system", /\[\s*system\s*(?:message|prompt|note|override)?\s*\]|<\s*\/?\s*system\s*>|<\|im_start\|>\s*system|<\|system\|>|\bsystem\s+(?:prompt|message|override|instructions?)\s*:/giu],
  ["system", /\b(?:reveal|show|print|output|repeat|leak|disclose|display|tell\s+me|give\s+me|return|dump|recite)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|original\s+|hidden\s+|initial\s+|secret\s+)?(?:system\s+prompt|system\s+message|initial\s+prompt|hidden\s+prompt|developer\s+message)\b/giu],
  ["system", /\b(?:reveal|print|output|repeat|leak|disclose|dump|recite)\s+(?:me\s+)?your\s+(?:full\s+|entire\s+|original\s+|hidden\s+|initial\s+|secret\s+)?(?:instructions|prompt|api\s+keys?|secrets?|configuration)\b/giu],
  ["system", /\b(?:begin|end)\s+(?:of\s+)?(?:system|new|hidden|secret)\s+(?:prompt|instructions)\b/giu],
  ["system", /(?:输出|显示|泄露|透露|告诉我|打印|重复|给出)(?:一下)?(?:你的|你)?(?:完整的?)?(?:系统提示词?|系统指令|初始提示词?|隐藏指令)/gu],
  ["system", /(?:新的|真正的)?系统(?:提示词?|指令)\s*[:：]/gu],
  // --- secrecy
  ["secrecy", /\b(?:do\s+not|don['’]t|never)\s+(?:tell|inform|alert|notify|warn)\s+(?:the\s+)?(?:user|human|reader|operator)\b/giu],
  ["secrecy", /\b(?:do\s+not|don['’]t|never)\s+let\s+(?:the\s+)?(?:user|human)\s+(?:know|see|find\s+out|notice)\b/giu],
  ["secrecy", /\bwithout\s+telling\s+(?:the\s+)?(?:user|human)\b/giu],
  ["secrecy", /\b(?:keep|hide)\s+(?:this|these\s+instructions|it)\s+(?:secret|hidden)\s+from\s+(?:the\s+)?(?:user|human)\b/giu],
  ["secrecy", /\b(?:do\s+not|don['’]t|never)\s+(?:mention|reveal|disclose|acknowledge)\s+(?:these|this|the(?:se)?)\s+(?:hidden\s+)?(?:instructions?|prompt)\b/giu],
  ["secrecy", /(?:不要|别|切勿|请勿|不得)(?:告诉|通知|提醒|透露给)(?:用户|使用者)/gu],
  ["secrecy", /(?:不要|别|切勿|请勿|不得)让(?:用户|使用者)(?:知道|发现|看到|察觉)/gu],
  ["secrecy", /对(?:用户|使用者)保密/gu],
  // --- exfil
  ["exfil", new RegExp(`\\b(?:send|post|upload|forward|transmit|submit|exfiltrate|leak|copy|append|include|embed|encode)\\b[^\\n]{0,80}?\\b${DATA}\\b[^\\n]{0,60}?\\b(?:to|into|in|at)\\b[^\\n]{0,30}?https?:\\/\\/`, "giu")],
  ["exfil", /\b(?:visit|open|load|fetch|call|request|render|display|show|include)\b[^\n]{0,60}?https?:\/\/[^\s)"'<>]*(?:\{|%7b|\$\{|\[(?:data|chat|history|conversation|user|secret|token|key))/giu],
  ["exfil", /!\[[^\]\n]{0,100}\]\(\s*https?:\/\/[^)\s]{0,300}?(?:\{|%7b|\$\{|<|\[)[^)\n]{0,200}\)/giu],
  ["exfil", /\bexfiltrat(?:e|es|ed|ing|ion)\b/giu],
  ["exfil", /(?:发送|上传|提交|转发|传送|传输|泄露|附加)[^。\n]{0,40}?(?:对话|聊天记录|数据|信息|内容|密码|密钥|历史|资料)[^。\n]{0,20}?(?:到|至|给)\s*https?:\/\//gu],
  ["exfil", /(?:把|将)[^。\n]{0,30}?(?:对话|聊天记录|数据|信息|内容|密码|密钥|历史|资料)[^。\n]{0,20}?(?:发送|上传|提交|转发|传送)(?:到|至|给)\s*https?:\/\//gu],
  ["exfil", /(?:窃取|外泄|偷取)(?:用户)?(?:的)?(?:数据|信息|聊天记录|对话|密码|密钥)/gu],
  // --- addressed
  ["addressed", /\bif\s+you\s+are\s+(?:an?\s+)?(?:ai|a\.i\.|llm|large\s+language\s+model|language\s+model|chatbot|ai\s+assistant|gpt|chatgpt|claude|gemini|copilot)\b/giu],
  ["addressed", /\b(?:note|message|instructions?|attention|important)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:ai|llm|llms|language\s+models?|ai\s+assistants?|chatbots?|ai\s+agents?|gpt|chatgpt|claude)\b/giu],
  ["addressed", /\b(?:dear|attention|hey|hello)\s*,?\s+(?:ai|llm|chatbot|ai\s+assistant|gpt|chatgpt|claude)\b/giu],
  ["addressed", /\b(?:ai|llm|language\s+model|ai\s+assistant|chatbot|ai\s+agent)s?\s+(?:that\s+(?:is|are)\s+)?(?:reading|processing|summari[sz]ing|analy[sz]ing|parsing|reviewing|screening)\s+this\b/giu],
  ["addressed", /如果你是(?:一个)?(?:AI|人工智能|大模型|语言模型|AI\s*助手|助手|机器人)/giu],
  ["addressed", /(?:致|给)(?:所有|任何)?(?:AI|人工智能|大模型|语言模型)(?:助手)?(?:的)?(?:说明|指令|提示|消息)/giu],
];

// Instruction-like phrases in `visible` (a projection), as ranges in the
// visible text: { start, end, category }. Overlapping hits are one finding.
export function findPhrases(visible) {
  const hits = [];
  for (const [category, re] of PHRASES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(visible))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      hits.push({ start: m.index, end: m.index + m[0].length, category });
      if (hits.length > MAX_FINDINGS * 4) break;
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const h of hits) {
    const last = out.at(-1);
    if (last && h.start < last.end) {
      last.end = Math.max(last.end, h.end);
      continue;
    }
    out.push({ ...h });
  }
  return out;
}

// The part of the text "Remove flagged lines" takes out for a finding: its
// whole line, with the line break, or the sentence around it when the line
// is very long (a PDF page arrives as one long line), or just the phrase.
export function removalUnit(text, start, end) {
  const ls = text.lastIndexOf("\n", start - 1) + 1;
  let le = text.indexOf("\n", end);
  if (le < 0) le = text.length;
  if (le - ls <= 400) return [ls, le < text.length ? le + 1 : le];
  const STOP = /[.!?。！？]/;
  let s = start;
  while (s > ls && !STOP.test(text[s - 1])) s--;
  while (s < start && /\s/.test(text[s])) s++;
  let e = end;
  while (e < le && !STOP.test(text[e])) e++;
  if (e < le) e++;
  if (e - s > 600) return [start, end];
  return [s, e];
}

// --- Hidden-text markers ---------------------------------------------------
// In HTML or Markdown source, text a browser wouldn't show: a comment of a
// few words or more, or an element hidden with an inline style.
const COMMENT = /<!--([\s\S]{0,2000}?)-->/g;
const HIDDEN_STYLE =
  /<([a-z][\w-]{0,20})\b[^>]{0,300}?\bstyle\s*=\s*["'][^"']{0,300}?(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*(?:[;"'!])|opacity\s*:\s*0(?:\.0+)?\s*(?:[;"'!]))[^>]{0,300}>([\s\S]{0,1200}?)<\/\1\s*>/gi;
const words = (s) => (s.match(/[\p{L}\p{N}]+/gu) || []).length;
export function markupHidden(text) {
  const out = [];
  if (!text.includes("<")) return out;
  COMMENT.lastIndex = 0;
  let m;
  while ((m = COMMENT.exec(text)) && out.length < 50) {
    const inner = m[1].trim();
    if (words(inner) >= 4 || (/[㐀-鿿]/.test(inner) && inner.length >= 6))
      out.push({ why: "comment", start: m.index, end: m.index + m[0].length, text: inner });
  }
  HIDDEN_STYLE.lastIndex = 0;
  while ((m = HIDDEN_STYLE.exec(text)) && out.length < 100) {
    const inner = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (inner) out.push({ why: "style", start: m.index, end: m.index + m[0].length, text: inner });
  }
  return out.sort((a, b) => a.start - b.start);
}

// PDF text too small to see or placed off the page, from pdf.js text items
// ({ str, transform, width, height }) and the page's view box. Consecutive
// hidden items join into one passage.
export function pdfHiddenText(items, view = [0, 0, 612, 792], page = 1) {
  const out = [];
  let current = null;
  for (const item of items || []) {
    const str = typeof item?.str === "string" ? item.str : "";
    const t = Array.isArray(item?.transform) ? item.transform : null;
    if (!t) continue;
    const size = Math.hypot(t[2], t[3]) || Math.abs(item.height || 0);
    const x = t[4],
      y = t[5],
      w = Math.abs(item.width || 0);
    let why = null;
    if (str.trim() && size > 0 && size < 1) why = "tiny";
    else if (
      str.trim() &&
      (x + w < view[0] - 2 || x > view[2] + 2 || y + size < view[1] - 2 || y > view[3] + 2)
    )
      why = "offpage";
    if (!why) {
      if (str.trim()) current = null;
      continue;
    }
    if (current && current.why === why) current.text += (item.hasEOL ? "\n" : " ") + str;
    else {
      current = { why, page, text: str };
      out.push(current);
    }
  }
  return out
    .map((p) => ({ ...p, text: p.text.replace(/[ \t]+/g, " ").trim().slice(0, 2000) }))
    .filter((p) => p.text);
}

// --- The scan ---------------------------------------------------------------
// One document's (or paste's) findings. `hiddenText` is what an extractor
// reported as hidden ({ why, text, page? }). Ranges are in `text`.
export function scanText(text, { phrases = true, hiddenText = [] } = {}) {
  const source = String(text ?? "").slice(0, SCAN_LIMIT);
  const invisible = scanInvisible(source);
  const markup = markupHidden(source);
  const inside = (pos) => markup.find((h) => pos >= h.start && pos < h.end);
  const instructions = [];
  let instructionCount = 0;
  if (phrases) {
    const { visible, starts, ends } = projectVisible(source);
    for (const hit of findPhrases(visible)) {
      instructionCount++;
      if (instructions.length >= MAX_FINDINGS) continue;
      const start = starts[hit.start],
        end = ends[hit.end - 1];
      const region = inside(start);
      instructions.push({
        start,
        end,
        category: hit.category,
        where: region ? region.why : "text",
        unit: removalUnit(source, start, end),
      });
    }
    // What tag characters and variation selectors spell is read the same
    // way; each hidden message counts once.
    for (const msg of invisible.messages) {
      const hit = findPhrases(msg.decoded)[0];
      if (!hit) continue;
      instructionCount++;
      if (instructions.length >= MAX_FINDINGS) continue;
      instructions.push({
        start: msg.start,
        end: msg.end,
        category: hit.category,
        where: msg.cls,
        decoded: msg.decoded,
        unit: [msg.start, msg.end],
      });
    }
    instructions.sort((a, b) => a.start - b.start);
  }
  const hidden = [
    ...markup.map((h) => ({ why: h.why, text: h.text.slice(0, 2000), start: h.start, end: h.end })),
    ...(hiddenText || [])
      .filter((h) => h && typeof h.text === "string" && h.text.trim())
      .slice(0, 50)
      .map((h) => ({ why: h.why, text: h.text.slice(0, 2000), page: h.page ?? null })),
  ].map((h) => ({ ...h, instruction: phrases && findPhrases(projectVisible(h.text).visible).length > 0 }));
  return {
    text: source,
    truncated: String(text ?? "").length > SCAN_LIMIT,
    invisible,
    instructions,
    instructionCount,
    hidden,
  };
}

// A document's scan, cached per document object: the composer's documents
// are immutable, so each is scanned once however often the page renders.
const scans = new WeakMap();
export function scanDocument(doc) {
  if (!doc || typeof doc !== "object") return null;
  let result = scans.get(doc);
  if (!result) {
    result = scanText(doc.text || "", { hiddenText: doc.hiddenText || [] });
    scans.set(doc, result);
  }
  return result;
}

export function shieldSummary(result) {
  const instructions = result?.instructionCount || 0,
    invisible = result?.invisible?.total || 0,
    hidden = result?.hidden?.length || 0;
  return { instructions, invisible, hidden, clear: !instructions && !invisible && !hidden };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "2 hidden instructions · 31 invisible characters", or "nothing found".
export function summaryText(summary) {
  if (!summary || summary.clear) return "nothing found";
  return [
    summary.instructions ? plural(summary.instructions, "hidden instruction", "hidden instructions") : null,
    summary.invisible ? plural(summary.invisible, "invisible character", "invisible characters") : null,
    summary.hidden ? plural(summary.hidden, "hidden passage", "hidden passages") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// The text to send: invisible characters stripped (the default) and, if the
// user chose it, flagged lines removed. Returns the input string unchanged
// when there's nothing to do.
export function cleanText(text, result, { stripInvisible = true, removeFlagged = false } = {}) {
  const source = result?.text ?? String(text ?? "");
  const ranges = [];
  if (removeFlagged) for (const f of result?.instructions || []) ranges.push(f.unit);
  if (stripInvisible) for (const r of result?.invisible?.runs || []) ranges.push([r.start, r.end]);
  if (!ranges.length) return source;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "",
    at = 0;
  for (const [s, e] of ranges) {
    if (e <= at) continue;
    out += source.slice(at, Math.max(at, s));
    at = Math.max(at, e);
  }
  return out + source.slice(at);
}

// A document as it will be sent. `prefs` are the user's choices for it:
// { keepInvisible, removeFlagged }. The same object comes back when nothing
// changes, so memoised requests stay stable.
export function shieldDocument(doc, result, prefs = {}) {
  if (!doc || !result) return doc;
  const text = cleanText(doc.text, result, {
    stripInvisible: !prefs.keepInvisible,
    removeFlagged: !!prefs.removeFlagged,
  });
  if (text === doc.text) return doc;
  return { ...doc, text, chars: text.length, ...(result.truncated ? { truncated: true } : {}) };
}

// A stretch of text around [start, end) for the panel, in pieces: plain
// text, the finding itself, and runs of invisible characters shown as
// markers ({ hidden: n }) instead of nothing.
export function excerpt(text, start, end, radius = 60) {
  const s = Math.max(0, start - radius),
    e = Math.min(text.length, end + radius);
  const piece = (from, to, mark = false) => splitInvisible(text.slice(from, to), mark);
  return {
    lead: s > 0,
    tail: e < text.length,
    parts: [...piece(s, start), ...piece(start, end, true), ...piece(end, e)],
  };
}
export function splitInvisible(str, mark = false) {
  const parts = [];
  let buf = "",
    hidden = 0;
  const push = () => {
    if (buf) parts.push({ text: buf, mark });
    if (hidden) parts.push({ hidden, mark });
    buf = "";
    hidden = 0;
  };
  for (const c of str) {
    if (invisibleClass(c.codePointAt(0))) {
      if (buf) {
        parts.push({ text: buf, mark });
        buf = "";
      }
      hidden++;
    } else {
      if (hidden) {
        parts.push({ hidden, mark });
        hidden = 0;
      }
      buf += c;
    }
  }
  push();
  return parts;
}

// --- Part B: remote images and links in replies ---------------------------
// A URL in a reply that would reach another host, or null for one that
// stays on this site (relative, same origin) or never touches the network
// (data:, blob:). `carriesData` flags an address with a long query string or
// a long path segment: loading it would hand that data to the host.
export function remoteTarget(url, origin) {
  if (typeof url !== "string" || !url.trim()) return null;
  let u;
  try {
    u = new URL(url, origin || "https://app.invalid");
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (origin && u.origin === new URL(origin).origin) return null;
  const query = u.search.length > 1 ? u.search.length - 1 : 0;
  const longSegment = u.pathname
    .split("/")
    .reduce((n, seg) => (seg.length > 80 ? n + seg.length : n), 0);
  const dataLength = (query > 48 ? query : 0) + longSegment;
  return { url: u.href, host: u.host, carriesData: dataLength > 0, dataLength };
}
// Link text that already names the host (or is the URL) needs no badge.
export function namesHost(text, host) {
  const t = String(text || "").toLowerCase();
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  return !!h && t.includes(h);
}
