import React from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import { unveil } from "./veil.js";
import { useLanguage } from "./i18n.js";
import {
  ONCHAIN_CHAINS,
  chainById,
  chainList,
  explorerLink,
  formatAmount,
  isChainFactsDocument,
  parseChainFacts,
  shortHex,
} from "./onchain.js";
import "./onchain.css";

// Onchain Explainer (update "onchain"). The composer offers "Explain
// on-chain" when it holds a transaction hash, an address or an explorer
// link; the server looks it up (POST /api/onchain/lookup, free, read only)
// and the facts go with the message as a <document> block (src/onchain.js),
// drawn in the conversation as the "Chain facts" card below. The card is
// built from those facts, never from model text; the model's explanation
// is the reply under it.
export const onchainReleased = (config) => isReleased(config, "onchain");

// --- The composer chip -------------------------------------------------------
// `hit` is detectOnchain's result; `choice` the chain picker's value ("auto"
// or a chain id). Nothing leaves the browser until Explain is pressed.
export function OnchainChip({ hit, choice, setChoice, onExplain, onDismiss, busy, looking, error, blocked, veilOn }) {
  if (!hit) return null;
  const tx = hit.kind === "transaction";
  return (
    <div className="onchain-chip" role="group" aria-label="Onchain Explainer">
      <span className="onchain-tile" aria-hidden="true">
        <Icon name="chain" size={16} />
      </span>
      <div className="onchain-chip-body">
        <p className="onchain-eyebrow">ONCHAIN EXPLAINER</p>
        <div className="onchain-chip-row">
          <span className="onchain-chip-what">
            {tx ? "Transaction" : "Address"}{" "}
            <code data-i18n="off" title={hit.value}>
              {shortHex(hit.value)}
            </code>
          </span>
          <label className="onchain-chain">
            <span className="sr-only">Chain</span>
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={looking}
              aria-label="Chain"
            >
              <option value="auto">Any chain</option>
              {ONCHAIN_CHAINS.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="onchain-button solid"
            onClick={onExplain}
            disabled={busy || looking || blocked}
          >
            {looking ? "Looking up…" : "Explain on-chain"}
          </button>
          <button
            type="button"
            className="onchain-dismiss"
            aria-label="Not now"
            title="Not now"
            onClick={onDismiss}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="onchain-note">
          {choice === "auto" && <span>{`Tries ${chainList()} in turn.`}</span>}
          <span>
            Looked up by ANONYMA's server, so the explorer never sees you. The lookup is free and read only; the explanation is billed like any message.
          </span>
        </p>
        {veilOn && (
          <p className="onchain-note">
            {tx
              ? "Veil is on: addresses reach the model as placeholders, but a transaction hash can't be hidden that way, since anyone can look it up."
              : "Veil is on: the address reaches the model as a placeholder."}
          </p>
        )}
        {blocked && <p className="onchain-note">Seed Guard found a secret in this message. Remove it first.</p>}
        {error && (
          <p className="onchain-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// --- The Chain facts card ------------------------------------------------------
const Amount = ({ amount, symbol }) =>
  amount == null ? null : (
    <span className="onchain-amount" data-i18n="off" title={`${amount} ${symbol || ""}`.trim()}>
      {formatAmount(amount)} {symbol}
    </span>
  );

function Party({ party, chainId }) {
  if (!party?.address) return <span className="onchain-muted">—</span>;
  const href = explorerLink(chainId, "address", party.address);
  return (
    <span className="onchain-party">
      {party.name && (
        <b data-i18n="off" className="onchain-party-name">
          {party.name}
        </b>
      )}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
        data-i18n="off"
        title={party.address}
      >
        <code>{shortHex(party.address)}</code>
      </a>
      {party.type && (
        <span className="onchain-tag">
          {party.type === "contract" ? "contract" : party.smart_wallet ? "smart wallet" : "wallet"}
        </span>
      )}
      {party.verified === true && <span className="onchain-tag">verified</span>}
      {party.flagged && <span className="onchain-tag warn">flagged</span>}
    </span>
  );
}

const Token = ({ token }) =>
  token?.symbol || token?.name ? (
    <span data-i18n="off">{token.symbol || token.name}</span>
  ) : (
    <code data-i18n="off">{shortHex(token?.address)}</code>
  );

const STATUS = { success: "Success", failed: "Failed", pending: "Pending" };

function Row({ label, children }) {
  if (children == null || children === false) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function When({ time }) {
  const lang = useLanguage();
  const d = new Date(time);
  if (!time || !Number.isFinite(d.getTime())) return null;
  return (
    <span data-i18n="off">
      {new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d)}
    </span>
  );
}

function Transfers({ facts }) {
  const list = facts.transfers || [];
  if (!list.length && !facts.internal_transfers?.length) return null;
  return (
    <div className="onchain-section">
      <p className="onchain-label">Transfers</p>
      <ul className="onchain-list">
        {list.map((t, i) => (
          <li key={i}>
            <span className="onchain-move">
              {t.amount != null ? (
                <Amount amount={t.amount} symbol={t.token?.symbol || t.token?.name} />
              ) : t.token_id != null ? (
                <span data-i18n="off">
                  {t.token?.symbol || t.token?.name || "NFT"} #{t.token_id}
                </span>
              ) : (
                <Token token={t.token} />
              )}
              {t.mint && <span className="onchain-tag">minted</span>}
              {t.burn && <span className="onchain-tag">burned</span>}
            </span>
            <span className="onchain-route">
              <Party party={t.from} chainId={facts.chain.id} />
              <Icon name="arrow" size={12} />
              <Party party={t.to} chainId={facts.chain.id} />
            </span>
          </li>
        ))}
        {(facts.internal_transfers || []).map((t, i) => (
          <li key={"i" + i}>
            <span className="onchain-move">
              <Amount amount={t.amount} symbol={t.symbol} />
              <span className="onchain-tag">internal</span>
            </span>
            <span className="onchain-route">
              <Party party={t.from} chainId={facts.chain.id} />
              <Icon name="arrow" size={12} />
              <Party party={t.to} chainId={facts.chain.id} />
            </span>
          </li>
        ))}
      </ul>
      {facts.more_transfers ? (
        <p className="onchain-muted">
          {typeof facts.more_transfers === "number"
            ? facts.more_transfers === 1
              ? "1 more transfer isn't shown."
              : `${facts.more_transfers} more transfers aren't shown.`
            : "More transfers aren't shown."}
        </p>
      ) : null}
    </div>
  );
}

function Approvals({ facts }) {
  if (!facts.approvals?.length) return null;
  return (
    <div className="onchain-section">
      <p className="onchain-label">Approvals</p>
      <ul className="onchain-list">
        {facts.approvals.map((a, i) => (
          <li key={i}>
            <span className="onchain-move">
              {a.revoke ? (
                <span className="onchain-tag">revoked</span>
              ) : a.all ? (
                <span className="onchain-tag warn">all tokens</span>
              ) : a.amount === "unlimited" ? (
                <span className="onchain-tag warn">unlimited</span>
              ) : a.amount != null ? (
                <Amount amount={a.amount} symbol={a.token?.symbol} />
              ) : null}{" "}
              <Token token={a.token} />
            </span>
            <span className="onchain-route">
              <span className="onchain-muted">Spender</span>
              <Party party={a.spender} chainId={facts.chain.id} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Worth({ facts }) {
  const items = facts.worth_checking || [];
  if (!items.length) return null;
  return (
    <div className="onchain-worth">
      <p className="onchain-label">
        <Icon name="warning" size={13} /> Worth checking
      </p>
      <ul>
        {items.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

function TxBody({ facts }) {
  const id = facts.chain.id;
  return (
    <>
      <dl className="onchain-rows">
        <Row label="Time">{facts.time ? <When time={facts.time} /> : null}</Row>
        <Row label="From">
          <Party party={facts.from} chainId={id} />
        </Row>
        <Row label={facts.contract_created ? "New contract" : "To"}>
          <Party party={facts.contract_created || facts.to} chainId={id} />
        </Row>
        <Row label="Action">
          {facts.method || facts.selector ? (
            <code data-i18n="off" title={facts.call || facts.selector}>
              {facts.method || facts.selector}
            </code>
          ) : facts.to && !facts.transfers ? (
            "Plain transfer"
          ) : null}
        </Row>
        <Row label="Value">
          <Amount amount={facts.value?.amount} symbol={facts.value?.symbol} />
        </Row>
        <Row label="Fee">
          {facts.fee ? <Amount amount={facts.fee.amount} symbol={facts.fee.symbol} /> : null}
        </Row>
        <Row label="Block">{facts.block != null ? <span data-i18n="off">{facts.block.toLocaleString("en")}</span> : null}</Row>
      </dl>
      <Transfers facts={facts} />
      <Approvals facts={facts} />
    </>
  );
}

function AddressBody({ facts }) {
  const id = facts.chain.id;
  return (
    <>
      <dl className="onchain-rows">
        <Row label="Name">{facts.name ? <b data-i18n="off">{facts.name}</b> : null}</Row>
        <Row label="Labels">
          {facts.labels?.length ? <span data-i18n="off">{facts.labels.join(" · ")}</span> : null}
        </Row>
        <Row label="Type">
          <span>
            {facts.type === "contract" ? "Contract" : facts.smart_wallet ? "Smart wallet" : "Wallet"}
            {facts.type === "contract" && facts.verified === true && (
              <span className="onchain-tag">verified</span>
            )}
            {facts.type === "contract" && facts.verified === false && (
              <span className="onchain-tag warn">not verified</span>
            )}
            {facts.flagged && <span className="onchain-tag warn">flagged</span>}
          </span>
        </Row>
        <Row label="Balance">
          <Amount amount={facts.balance?.amount} symbol={facts.balance?.symbol} />
        </Row>
        <Row label="Transactions">
          {facts.transactions != null ? <span data-i18n="off">{facts.transactions.toLocaleString("en")}</span> : null}
        </Row>
        <Row label="Sent">
          {facts.sent_transactions != null ? (
            <span data-i18n="off">{facts.sent_transactions.toLocaleString("en")}</span>
          ) : null}
        </Row>
        <Row label="Token">
          {facts.token ? (
            <span data-i18n="off">
              {facts.token.name}
              {facts.token.symbol ? ` (${facts.token.symbol})` : ""}
              {facts.token.supply ? ` · ${formatAmount(facts.token.supply)}` : ""}
            </span>
          ) : null}
        </Row>
        <Row label="Holders">
          {facts.token?.holders != null ? <span data-i18n="off">{facts.token.holders.toLocaleString("en")}</span> : null}
        </Row>
        <Row label="Creator">
          {facts.creator ? <Party party={{ address: facts.creator }} chainId={id} /> : null}
        </Row>
      </dl>
      {facts.tokens?.length ? (
        <div className="onchain-section">
          <p className="onchain-label">Tokens held</p>
          <ul className="onchain-list compact">
            {facts.tokens.map((t, i) => (
              <li key={i}>
                <Amount amount={t.amount} symbol={t.symbol || t.name} />
              </li>
            ))}
          </ul>
          {facts.more_tokens && <p className="onchain-muted">More tokens aren't shown.</p>}
        </div>
      ) : null}
      {facts.tokens_checked && (
        <p className="onchain-muted">Only NYMA is checked for token balances on this chain.</p>
      )}
      {facts.activity === false && (
        <p className="onchain-muted">
          {facts.checked?.length > 1
            ? `No activity on ${facts.checked.join(", ").replace(/, ([^,]*)$/, " or $1")}.`
            : "No activity on this chain."}
        </p>
      )}
    </>
  );
}

export function ChainFactsCard({ facts }) {
  const chain = chainById(facts?.chain?.id);
  if (!chain) return null;
  const tx = facts.kind === "transaction";
  const value = tx ? facts.hash : facts.address;
  const href = explorerLink(chain.id, facts.kind, tx ? facts.hash : facts.address);
  return (
    <section className="onchain-card" aria-label="Chain facts">
      <header className="onchain-card-head">
        <span className="onchain-tile" aria-hidden="true">
          <Icon name="chain" size={16} />
        </span>
        <div className="onchain-card-title">
          <p className="onchain-eyebrow">
            CHAIN FACTS · <span data-i18n="off">{chain.name}</span>
          </p>
          <p className="onchain-card-name">
            {tx ? "Transaction" : "Address"}{" "}
            <code data-i18n="off" title={value}>
              {shortHex(value)}
            </code>
          </p>
        </div>
        {tx && (
          <span className={"onchain-status " + (facts.status || "pending")}>
            {STATUS[facts.status] || "Pending"}
          </span>
        )}
      </header>
      {tx ? <TxBody facts={facts} /> : <AddressBody facts={facts} />}
      <Worth facts={facts} />
      <footer className="onchain-card-foot">
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
            View on explorer <Icon name="external" size={12} />
          </a>
        )}
        <span>
          {facts.source?.startsWith("Robinhood Chain public node")
            ? "Read by ANONYMA's server from Robinhood Chain's public node. Names here come from ANONYMA or the token itself."
            : "Read by ANONYMA's server from the Blockscout explorer. Names and labels come from the explorer."}
        </span>
      </footer>
    </section>
  );
}

// The cards for the chain-facts documents of a saved message. With Veil on,
// the saved text holds [TAG_n] placeholders; this browser's map restores
// them on screen only, as MessageDocuments does.
export function MessageChainFacts({ documents, veilMap }) {
  const cards = (documents || [])
    .filter(isChainFactsDocument)
    .map((d) => parseChainFacts(veilMap ? unveil(d.text, veilMap) : d.text))
    .filter(Boolean);
  if (!cards.length) return null;
  return (
    <div className="onchain-cards">
      {cards.map((facts, i) => (
        <ChainFactsCard key={i} facts={facts} />
      ))}
    </div>
  );
}
