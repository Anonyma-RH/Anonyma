import React from "react";
import { Link } from "react-router-dom";
import { Icon } from "./ui.jsx";
import { shortHex } from "./onchain.js";
import { FIXED_LIMITS, parseContractRequest, readContractReply } from "./contract-reader.js";
import "./contract-chat.css";

// Contract Reader in the chat view: a saved reading opens as an ordinary
// conversation, so follow-up questions can use its facts and source. Its
// first message (the facts and source files) shows as this card instead of
// a row of file chips, and the reading itself as plain sections instead of
// its JSON. The full page, with the code viewer, is one click away. Loaded
// only when a conversation looks like a reading (src/Workspace.jsx checks
// its first line and facts block); anything that doesn't parse shows as it
// would have (`fallback`).
export default function ContractChat({ part, content, conversation, fallback = null }) {
  if (part === "card") {
    const request = parseContractRequest(content);
    return request ? <ContractChatCard request={request} conversation={conversation} /> : fallback;
  }
  const result = readContractReply(content).result;
  return result ? <ContractChatReply result={result} /> : fallback;
}

export function ContractChatCard({ request, conversation }) {
  const { facts, files } = request;
  return (
    <div className="ctr-chat-card">
      <b>
        <Icon name="contract" size={14} /> Contract Reader
      </b>
      <span>
        <span data-i18n="off">{facts.name || facts.token?.symbol || shortHex(facts.address)}</span>
        {" · "}
        <span data-i18n="off" title={facts.address}>
          {shortHex(facts.address)}
        </span>
        {" · "}
        {facts.chain.name}
      </span>
      <small>
        {facts.verified
          ? `${files.length} verified ${files.length === 1 ? "file" : "files"} and live facts were sent as data.`
          : "Its code isn't published: live facts and its bytecode's functions were sent as data."}
      </small>
      {conversation && <Link to={`/workspace/contracts?c=${encodeURIComponent(conversation)}`}>Open in Contract Reader</Link>}
    </div>
  );
}

const where = (p) => [p.fn, p.file ? `${p.file.split("/").pop()}${p.line ? ":" + p.line : ""}` : ""].filter(Boolean).join(" · ");
function List({ items }) {
  return (
    <ul>
      {items.map((p, i) => (
        <li key={i}>
          <b data-i18n="off">{p.title}</b>
          {p.detail && <span data-i18n="off"> {p.detail}</span>}
          {(p.who || p.fn || p.file) && (
            <small data-i18n="off"> {[p.who, where(p)].filter(Boolean).join(" · ")}</small>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ContractChatReply({ result }) {
  return (
    <div className="ctr-chat-reply">
      <p data-i18n="off">{result.summary}</p>
      {result.powers.length > 0 && (
        <>
          <h4>What they can do</h4>
          <List items={result.powers} />
        </>
      )}
      {result.checks.length > 0 && (
        <>
          <h4>Things to check</h4>
          <List items={result.checks} />
        </>
      )}
      <h4>What this can't tell you</h4>
      <ul>
        {FIXED_LIMITS.map((l) => (
          <li key={l}>{l}</li>
        ))}
        {result.limits.map((l, i) => (
          <li key={i} data-i18n="off">
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
