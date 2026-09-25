import React, { useState } from "react";
import { Icon } from "./ui.jsx";
import "./veil.css";

// The composer's on/off switch, styled like the existing "Web" toggle.
export function VeilToggle({ on, onToggle }) {
  return (
    <button
      type="button"
      className={"attachment-control veil-toggle" + (on ? " on" : "")}
      aria-pressed={on}
      title="Mask private details (emails, phone numbers, cards, keys…) in your browser before sending"
      onClick={onToggle}
    >
      <Icon name="shield" size={17} />
      <span>Veil</span>
    </button>
  );
}

// "Veiled 3 details" receipt note plus a popover: what got masked in the
// last request (tag -> original value, kept only in this browser) and the
// "always veil" word list editor.
export function VeilPanel({ note, words, onWordsChange }) {
  const [draft, setDraft] = useState("");
  const addWord = (e) => {
    e.preventDefault();
    const value = draft.trim();
    if (value && !words.includes(value)) onWordsChange([...words, value]);
    setDraft("");
  };
  return (
    <details className="veil-panel">
      <summary>
        {note?.count
          ? `Veiled ${note.count} detail${note.count === 1 ? "" : "s"}`
          : "Veil settings"}
      </summary>
      <div className="veil-popover">
        {note?.entries?.length > 0 && (
          <div className="veil-entries">
            <p>What the model saw instead. Kept only in this browser.</p>
            <ul>
              {note.entries.map((e) => (
                <li key={e.tag}>
                  <code>[{e.tag}]</code>
                  <span>{e.value}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="veil-words">
          <p>Always veil these words</p>
          <div className="veil-word-list">
            {words.map((w, i) => (
              <span key={w + i} className="veil-word">
                {w}
                <button
                  type="button"
                  aria-label={"Remove " + w}
                  onClick={() => onWordsChange(words.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
          <form onSubmit={addWord}>
            <input
              aria-label="Add a word to always veil"
              placeholder="Name, company, project…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="small-button">
              Add
            </button>
          </form>
        </div>
      </div>
    </details>
  );
}

// Turns [TAG_n] veil tags in a markdown AST into <mark> nodes so react-markdown
// can render the restored value with a dotted-underline hint, without a
// rehype-raw dependency. Text nodes are visited and split by hand — this is a
// small, self-contained walker rather than a full unist-util-visit import.
function splitVeilText(text, map) {
  const re = /\[([A-Z]+_\d+)\]/g;
  let cursor = 0,
    m;
  const out = [];
  while ((m = re.exec(text))) {
    if (m.index > cursor) out.push({ type: "text", value: text.slice(cursor, m.index) });
    const value = map[m[1]];
    out.push(
      value
        ? {
            type: "mark",
            data: {
              hName: "mark",
              hProperties: {
                className: "veil-mark",
                title: `Veiled — the model saw [${m[1]}]`,
              },
            },
            children: [{ type: "text", value }],
          }
        : { type: "text", value: m[0] },
    );
    cursor = m.index + m[0].length;
  }
  if (!out.length) return null;
  if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
  return out;
}
function replaceVeilTags(node, map) {
  if (!node?.children) return;
  const next = [];
  for (const child of node.children) {
    const split = child.type === "text" ? splitVeilText(child.value, map) : null;
    if (split) next.push(...split);
    else {
      replaceVeilTags(child, map);
      next.push(child);
    }
  }
  node.children = next;
}
export function veilRemarkPlugin({ map } = {}) {
  return (tree) => {
    if (map && Object.keys(map).length) replaceVeilTags(tree, map);
  };
}
