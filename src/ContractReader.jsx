import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { t, useLanguage } from "./i18n.js";
import { Icon, Modal, Notice } from "./ui.jsx";
import { api, isReleased, readStore, saveStore, streamChat, uid } from "./lib.js";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { EphemeralToggle } from "./Ephemeral.jsx";
import { useCreditEstimate } from "./CreditEstimate.jsx";
import { formatCredits } from "./estimate.js";
import { pickPreset } from "./model-finder.js";
import { formatBytes } from "./documents.js";
import { ONCHAIN_CHAINS, explorerLink, formatAmount, shortHex } from "./onchain.js";
import {
  CONTROL_LABELS,
  DISCLAIMER,
  FIXED_LIMITS,
  PARTY_TYPES,
  POWER_GROUPS,
  citationIndex,
  factCheckText,
  groundCitation,
  parseContractInput,
  parseContractRequest,
  readContractReply,
} from "./contract-reader.js";
import "./contract-reader.css";

// Contract Reader: paste a contract's address (or its explorer link), see
// the facts ANONYMA's server read (who controls it, from live reads; its
// verified source, or what its bytecode exposes), then ask a model to
// explain it in plain English. Reading is free and kept 30 minutes in the
// server's memory (/api/contracts); the explanation is one /api/chat request
// held at exactly the maximum shown, saved as a conversation (?c=) unless
// it's off the record or in Private Mode. Each power links to its file and
// line in the code viewer. Read only: nothing is signed or sent.

const MODEL_KEY = "contracts:model";
const CHAIN_KEY = "contracts:chain";
// "Try USDG": the stablecoin ANONYMA takes payments in, an upgradeable proxy.
const SAMPLE = { value: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", chain: 4663 };
const NOTES = {
  no_live_reads: "Live reads weren't available from this chain's explorer right now, so owners, roles and paused state aren't shown.",
  reads_incomplete: "Some live reads didn't answer, so a role may be missing here.",
  source_unavailable: "A source of verified code didn't answer, so \"not published\" may be wrong. Try again in a minute.",
  sources_trimmed: "The verified source was over 1.5 MB, so only the main contract and what it inherits from were kept.",
  proxy_source_skipped: "This address is a proxy: the reading covers the implementation it points to, not the proxy's own code.",
};
const plural = (n, one, many) => `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;

export default function ContractReader({ demo, user, models, config, refresh }) {
  const live = !demo && !!user && isReleased(config, "contractreader") && isReleased(config, "onchain");
  const [params, setParams] = useSearchParams();
  const [value, setValue] = useState(""),
    [chain, setChain] = useState(() => Number(readStore(CHAIN_KEY, 4663)) || 4663),
    [reading, setReading] = useState(false),
    [readError, setReadError] = useState(""),
    [notice, setNotice] = useState(""),
    [read, setRead] = useState(null),
    [saved, setSaved] = useState(null),
    [openReads, setOpenReads] = useState([]),
    [viewer, setViewer] = useState(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    saveStore(CHAIN_KEY, chain);
  }, [chain]);

  const readId = params.get("read") || "";
  const savedId = params.get("c") || "";
  const setParam = useCallback(
    (changes, replace = false) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
          return next;
        },
        { replace },
      ),
    [setParams],
  );
  const listOpen = useCallback(() => {
    if (!live) return;
    api("/api/contracts")
      .then((r) => mounted.current && setOpenReads(r.data || []))
      .catch(() => {});
  }, [live]);
  useEffect(listOpen, [listOpen]);

  // The read in the URL: opened again on reload while it's still in memory.
  useEffect(() => {
    if (!live || !readId) return setRead(null);
    if (read?.id === readId) return;
    let stop = false;
    api("/api/contracts/" + encodeURIComponent(readId))
      .then((r) => !stop && setRead(r))
      .catch((e) => {
        if (stop) return;
        setRead(null);
        if (!savedId) setNotice(e?.message || "That contract couldn't be opened.");
        setParam({ read: null, file: null, line: null, end: null }, true);
      });
    return () => {
      stop = true;
    };
  }, [live, readId]);
  // A saved reading (?c=): its facts, the files that were sent and the reply.
  useEffect(() => {
    if (!live || !savedId) return setSaved(null);
    if (saved?.id === savedId) return;
    let stop = false;
    api("/api/conversations/" + encodeURIComponent(savedId))
      .then((c) => {
        if (stop) return;
        const request = parseContractRequest(c.messages?.find((m) => m.role === "user")?.content);
        const reply = c.messages?.find((m) => m.role === "assistant");
        const parsed = reply ? readContractReply(reply.content?.text ?? reply.content) : null;
        if (!request || !parsed?.result) {
          setNotice("That conversation isn't a Contract Reader reading.");
          return setParam({ c: null }, true);
        }
        setSaved({
          id: c.id,
          facts: request.facts,
          files: request.files,
          result: parsed.result,
          model: reply.model,
          charged: reply.credits,
          created: reply.created,
        });
      })
      .catch((e) => {
        if (stop) return;
        setNotice(e?.message || "That reading couldn't be opened.");
        setParam({ c: null }, true);
      });
    return () => {
      stop = true;
    };
  }, [live, savedId]);

  let inputProblem = "";
  let target = null;
  if (value.trim())
    try {
      target = parseContractInput(value, chain);
    } catch (e) {
      inputProblem = e.message;
    }
  // An explorer link names its chain: the picker follows it.
  useEffect(() => {
    if (target?.from === "link" && target.chain !== chain) setChain(target.chain);
  }, [target?.from, target?.chain]);

  async function readContract(e) {
    e?.preventDefault();
    if (!live || reading || !target) return;
    setReading(true);
    setReadError("");
    setNotice("");
    try {
      const r = await api("/api/contracts", { method: "POST", body: { value: value.trim(), chain: target.chain } });
      if (!mounted.current) return;
      setRead(r);
      setSaved(null);
      setValue("");
      setParam({ read: r.id, c: null, file: null, line: null, end: null });
      listOpen();
    } catch (err) {
      if (mounted.current) setReadError(err?.message || "The contract couldn't be read.");
    } finally {
      if (mounted.current) setReading(false);
    }
  }
  async function forget(id) {
    try {
      await api("/api/contracts/" + encodeURIComponent(id), { method: "DELETE" });
    } catch {}
    if (read?.id === id) {
      setRead(null);
      setParam({ read: null, file: null, line: null, end: null });
    }
    setNotice("Forgotten. Nothing of that contract is kept on the server.");
    listOpen();
  }

  // What's on screen: a live read, a saved reading, or both (a reading
  // saved from the read that's still open).
  const facts = read?.facts || saved?.facts || null;
  const sameContract =
    read && saved && read.facts.address === saved.facts.address && read.facts.chain.id === saved.facts.chain.id;
  const files = useMemo(() => {
    if (read && (!saved || sameContract)) return read.files.map((f) => ({ ...f, lineCount: f.lines, lines: undefined }));
    if (saved) return saved.files.map((f) => ({ path: f.path, sent: true, lineCount: f.lines.at(-1)?.n || 0, savedLines: f.lines, truncated: f.truncated }));
    return [];
  }, [read, saved, sameContract]);
  const index = useMemo(() => {
    if (saved && !sameContract) return citationIndex(saved.files);
    return new Map(
      (read?.files || []).filter((f) => f.sent).map((f) => [f.path, { lines: f.lines, functions: f.functions || [] }]),
    );
  }, [read, saved, sameContract]);

  // ---- The code viewer (URL: file, line and end) ----
  const fileParam = params.get("file") || "";
  const lineParam = Number(params.get("line")) || 0;
  const endParam = Number(params.get("end")) || lineParam;
  const openFile = useCallback(
    (path, start = 0, end = start) =>
      setParam({ file: path, line: start ? String(start) : null, end: end > start ? String(end) : null }),
    [setParam],
  );
  useEffect(() => {
    if (!fileParam || !facts) return setViewer(null);
    const kept = files.find((f) => f.path === fileParam);
    if (read && (!saved || sameContract)) {
      let stop = false;
      setViewer((v) => (v?.path === fileParam ? v : { path: fileParam, loading: true }));
      api(`/api/contracts/${encodeURIComponent(read.id)}/file?path=${encodeURIComponent(fileParam)}`)
        .then((f) => !stop && setViewer({ path: f.path, lines: f.text.split("\n").map((text, i) => ({ n: i + 1, text })), bytes: f.bytes, sent: f.sent }))
        .catch((e) => !stop && setViewer({ path: fileParam, error: e?.message || "That file couldn't be opened." }));
      return () => {
        stop = true;
      };
    }
    setViewer(kept?.savedLines ? { path: fileParam, lines: kept.savedLines, saved: true } : { path: fileParam, error: "That file isn't in this reading." });
  }, [fileParam, read?.id, saved?.id, sameContract]);

  const expiresIn = read ? Math.ceil(read.forgotten_in / 60000) : 0;
  return (
    <section className="ctr-page">
      <div className={"ctr-head" + (facts ? " compact" : "")}>
        <p className="eyebrow">ONCHAIN</p>
        <h1>Contract Reader</h1>
        {!facts && (
          <p>
            Paste a token or contract address. See who controls it and what they can do, in plain English, before you
            touch it.
          </p>
        )}
      </div>
      <form className={"ctr-form" + (facts ? " compact" : "")} onSubmit={readContract}>
        <label htmlFor="ctr-input">{facts ? "Read another contract" : "Contract address or explorer link"}</label>
        <div className="ctr-row">
          <input
            id="ctr-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("0x… or an explorer link")}
            value={value}
            maxLength={2048}
            disabled={!live || reading}
            data-i18n="off"
            onChange={(e) => setValue(e.target.value)}
          />
          <select aria-label={t("Chain")} value={chain} disabled={!live || reading || target?.from === "link"} onChange={(e) => setChain(Number(e.target.value))}>
            {ONCHAIN_CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="submit" className="button" disabled={!live || reading || !target}>
            {reading ? "Reading…" : "Read contract"}
          </button>
        </div>
        {inputProblem && <small className="ctr-problem">{inputProblem}</small>}
        {!facts && live && !value && (
          <p className="ctr-fine">
            <button type="button" className="ctr-textbutton" onClick={() => (setValue(SAMPLE.value), setChain(SAMPLE.chain))}>
              Try USDG on Robinhood Chain
            </button>
          </p>
        )}
        <p className="ctr-fine">
          {facts
            ? "Free and read only. Sourcify, the explorer and the node see ANONYMA's server, not you."
            : "Free and read only: nothing is signed or sent, and no wallet is connected. ANONYMA's server reads the chain, Sourcify and the explorer, so they see our server, not you. What it reads stays in the server's memory for 30 minutes, then it's forgotten. Veil doesn't apply: an address and public code have nothing of yours to mask."}
          {!live && " Sign in to read a contract."}
        </p>
      </form>
      {reading && (
        <div className="ctr-progress" role="status">
          <span className="ctr-spinner" aria-hidden="true" />
          <span>
            <b>Reading the contract…</b>
            <small>Live reads from the chain, then its verified source from Sourcify or the explorer.</small>
          </span>
        </div>
      )}
      {readError && <Notice type="error">{readError}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {openReads.some((r) => r.id !== read?.id) && (
        <div className="ctr-open" aria-label={t("Open contracts")}>
          <span>Open now</span>
          {openReads.map((r) => (
            <button
              key={r.id}
              type="button"
              className={"ctr-chip" + (r.id === read?.id ? " on" : "")}
              aria-pressed={r.id === read?.id}
              onClick={() => setParam({ read: r.id, c: null, file: null, line: null, end: null })}
            >
              <Icon name="contract" size={13} />
              <span data-i18n="off">{r.name || shortHex(r.address)}</span>
              <small>{r.chain.name}</small>
            </button>
          ))}
        </div>
      )}
      {facts ? (
        <div className="ctr-grid">
          <ContractCard
            facts={facts}
            files={files}
            read={read && (!saved || sameContract) ? read : null}
            savedOnly={!!saved && !sameContract}
            expiresIn={expiresIn}
            onOpen={openFile}
            onForget={read ? () => forget(read.id) : null}
          />
          <Reading
            key={(read?.id || "") + ":" + (saved?.id || "")}
            live={live}
            facts={facts}
            read={read && (!saved || sameContract) ? read : null}
            saved={saved}
            index={index}
            config={config}
            models={models}
            refresh={refresh}
            onOpen={openFile}
            onSaved={(id) => setParam({ c: id }, true)}
          />
        </div>
      ) : (
        <ol className="ctr-steps">
          <li>
            <b>Read a contract</b>
            <span>Paste its address or explorer link. The server reads the chain; your browser never contacts it.</span>
          </li>
          <li>
            <b>See who controls it</b>
            <span>Owners, admins and roles come from live reads, not a guess.</span>
          </li>
          <li>
            <b>Get it in plain English</b>
            <span>Every power the code gives someone, with a link to its file and line.</span>
          </li>
        </ol>
      )}
      {viewer && facts && (
        <Modal title={viewer.path} onClose={() => setParam({ file: null, line: null, end: null })}>
          <FileView view={viewer} start={lineParam} end={endParam} />
        </Modal>
      )}
    </section>
  );
}

function Address({ facts, address }) {
  const href = explorerLink(facts.chain.id, "address", String(address).toLowerCase());
  return (
    <a className="ctr-address" href={href || undefined} target="_blank" rel="noopener noreferrer nofollow" title={address} data-i18n="off">
      {shortHex(address)}
    </a>
  );
}

function ContractCard({ facts, files, read, savedOnly, expiresIn, onOpen, onForget }) {
  const title = facts.name || facts.token?.symbol || shortHex(facts.address);
  const sentCount = files.filter((f) => f.sent).length;
  return (
    <aside className="ctr-side">
      <div className="ctr-card">
        <div className="ctr-card-title">
          <Icon name="contract" size={18} />
          <b data-i18n="off">{title}</b>
        </div>
        <p className="ctr-card-address">
          <a
            href={explorerLink(facts.chain.id, "address", facts.address.toLowerCase()) || undefined}
            target="_blank"
            rel="noopener noreferrer nofollow"
            data-i18n="off"
          >
            {facts.address}
          </a>
        </p>
        <div className="ctr-tags">
          <span className="ctr-tag">{facts.chain.name}</span>
          {facts.verified ? (
            <span className="ctr-tag ok">{`Verified on ${facts.verified.via}`}</span>
          ) : (
            <span className="ctr-tag warn">Not verified</span>
          )}
          {facts.verified?.match === "partial" && <span className="ctr-tag">Partial match</span>}
          {facts.proxy && (
            <span className="ctr-tag" data-i18n="off">
              {facts.proxy.kind}
            </span>
          )}
          {facts.token?.symbol && (
            <span className="ctr-tag" data-i18n="off">
              {facts.token.symbol}
            </span>
          )}
          {facts.paused === true && <span className="ctr-tag warn">Paused</span>}
        </div>
        <dl className="ctr-facts">
          {facts.token?.supply && (
            <>
              <dt>Total supply</dt>
              <dd title={facts.token.supply} data-i18n="off">
                {formatAmount(facts.token.supply)}
              </dd>
            </>
          )}
          {facts.proxy?.implementation && (
            <>
              <dt>Implementation</dt>
              <dd>
                <Address facts={facts} address={facts.proxy.implementation} />
                {facts.proxy.implementation_name && <small data-i18n="off"> {facts.proxy.implementation_name}</small>}
              </dd>
            </>
          )}
          {facts.verified?.compiler && (
            <>
              <dt>Compiler</dt>
              <dd data-i18n="off">{facts.verified.compiler}</dd>
            </>
          )}
          {facts.code_size != null && (
            <>
              <dt>Code size</dt>
              <dd>{formatBytes(facts.code_size)}</dd>
            </>
          )}
        </dl>
        {read ? (
          <p className="ctr-fine">
            {`In memory for ${expiresIn} more ${expiresIn === 1 ? "minute" : "minutes"}, then forgotten.`}{" "}
            <button type="button" className="ctr-textbutton" onClick={onForget}>
              Forget now
            </button>
          </p>
        ) : savedOnly ? (
          <p className="ctr-fine">A saved reading: these are the facts and files as they were when it was explained.</p>
        ) : null}
        {read?.hidden_removed > 0 && (
          <p className="ctr-fine">{`Injection Shield removed ${plural(read.hidden_removed, "invisible character", "invisible characters")}.`}</p>
        )}
      </div>
      {files.length > 0 ? (
        <nav className="ctr-files" aria-label={t("Source files")}>
          <h3>
            Source files
            <small>{savedOnly ? plural(files.length, "file sent", "files sent") : `${plural(files.length, "file", "files")} · ${sentCount} sent to the AI`}</small>
          </h3>
          <ul>
            {files.map((f) => (
              <li key={f.path}>
                <button type="button" className="ctr-file" title={f.path} onClick={() => onOpen(f.path)}>
                  <span data-i18n="off">
                    {f.path.includes("/") && <small>{f.path.slice(0, f.path.lastIndexOf("/") + 1)}</small>}
                    {f.path.split("/").pop()}
                  </span>
                  <span className="ctr-file-tags">
                    {f.main && <em>Main</em>}
                    {f.flagged && <em className="warn" title={t("Injection Shield: this file has text that reads like instructions to an AI. It's sent as data, and the model is told not to follow it.")}>Reads like instructions</em>}
                    {!savedOnly && f.sent && <em className="sent">Sent to AI</em>}
                    <small>{Number(f.lineCount || 0).toLocaleString("en-US")}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : facts.bytecode ? (
        <div className="ctr-files">
          <h3>
            Functions in its bytecode
            <small>{`Matched ${facts.bytecode.functions.length} of ${facts.bytecode.selectors} selectors`}</small>
          </h3>
          {facts.bytecode.functions.length ? (
            <ul>
              {facts.bytecode.functions.map((f) => (
                <li key={f.signature} className="ctr-fn">
                  <code data-i18n="off">{f.signature}</code>
                  <small>{POWER_GROUPS[f.group]}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ctr-fine ctr-pad">None of the functions ANONYMA knows by name were found.</p>
          )}
          <p className="ctr-fine ctr-pad">Matched against a small built-in list of common functions; nothing is looked up online.</p>
        </div>
      ) : null}
    </aside>
  );
}

function ControlList({ facts }) {
  const rows = facts.control || [];
  if (!rows.length)
    return (
      <p className="ctr-fine">
        {facts.notes?.includes("no_live_reads")
          ? "Live reads weren't available, so who controls it couldn't be read."
          : "No owner, admin or role was found in its live reads. Powers may still be held in other ways: see what they can do."}
      </p>
    );
  return (
    <ul className="ctr-control">
      {rows.map((c, i) => (
        <li key={c.role + (c.name || "") + i}>
          <div className="ctr-control-head">
            {c.role === "role" ? (
              <b data-i18n="off">{c.name + "()"}</b>
            ) : (
              <b>{CONTROL_LABELS[c.role] || c.role}</b>
            )}
            {c.role === "role_admins" ? (
              <span>{plural(c.count, "holder", "holders")}</span>
            ) : c.renounced ? (
              <span className="ctr-none">No one</span>
            ) : (
              <Address facts={facts} address={c.address} />
            )}
          </div>
          {c.renounced ? (
            <p className="ctr-fine">Ownership was renounced: it's set to the zero address, so owner-only functions can't be called.</p>
          ) : c.role === "role_admins" ? (
            <p className="ctr-fine ctr-members">
              {(c.members || []).map((m) => (
                <Address key={m} facts={facts} address={m} />
              ))}
              {c.count > (c.members || []).length && <span>{`and ${c.count - c.members.length} more`}</span>}
            </p>
          ) : (
            c.type && <p className="ctr-fine">{PARTY_TYPES[c.type]}</p>
          )}
          <small className="ctr-via" data-i18n="off">
            {c.via}
          </small>
        </li>
      ))}
    </ul>
  );
}

function Cite({ item, index, onOpen }) {
  const cite = groundCitation(item, index);
  if (!cite) return item.fn ? <code className="ctr-fn-name" data-i18n="off">{item.fn}</code> : null;
  const label = `${cite.file.split("/").pop()}${cite.line ? ":" + cite.line : ""}`;
  return (
    <button type="button" className="ctr-cite" title={cite.file} onClick={() => onOpen(cite.file, cite.line, cite.end || cite.line)} data-i18n="off">
      {item.fn ? `${item.fn} · ${label}` : label}
    </button>
  );
}

function Items({ items, index, onOpen }) {
  return (
    <ul className="ctr-items">
      {items.map((p, i) => (
        <li key={i}>
          <div className="ctr-item-head">
            <b data-i18n="off">{p.title}</b>
            {p.who && (
              <span className="ctr-who" data-i18n="off">
                {p.who}
              </span>
            )}
          </div>
          {p.detail && <p data-i18n="off">{p.detail}</p>}
          {(p.fn || p.file) && <Cite item={p} index={index} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

function Reading({ live, facts, read, saved, index, config, models, refresh, onOpen, onSaved }) {
  const [model, setModel] = useState(() => readStore(MODEL_KEY, "")),
    [privateOn, setPrivateOn] = useState(false),
    [offRecord, setOffRecord] = useState(false),
    [gen, setGen] = useState(null),
    [formError, setFormError] = useState("");
  const controller = useRef(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const privateLive = privateModeReleased(config);
  const offRecordLive = isReleased(config, "ephemeral");
  const uncensored = config?.releases?.uncensoredModels || [];
  // Chat models only, as on the other tool pages; no Auto on this page.
  const choices = useMemo(
    () =>
      models.filter(
        (m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateOn || m.private),
      ),
    [models, privateOn, config],
  );
  useEffect(() => {
    setModel((prev) =>
      choices.some((m) => m.id === prev) ? prev : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || "",
    );
  }, [choices]);
  useEffect(() => {
    if (model) saveStore(MODEL_KEY, model);
  }, [model]);
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;
  const lang = useLanguage();
  const busy = gen?.status === "writing";
  const noPrivate = privateOn && !choices.length;
  const unsaved = privateOn || offRecord;
  // The reading on screen: this page's own, or the saved one (?c=).
  const result = gen?.result || (saved && (!read || saved.facts.address === facts.address) ? saved.result : null);
  // The explanation is written in the site's language.
  const quoteBody = useMemo(
    () =>
      live && read && model && !busy && !result
        ? {
            model,
            contract: { id: read.id, lang: ["zh", "es"].includes(lang) ? lang : "en" },
            ...(privateOn ? { private: true } : {}),
            ...(unsaved ? { ephemeral: true } : {}),
          }
        : null,
    [live, read?.id, model, busy, result, privateOn, unsaved, lang],
  );
  const estimate = useCreditEstimate(quoteBody);
  const short = estimate.status === "ready" && estimate.available != null && estimate.credits > estimate.available;
  const limited = estimate.status === "ready" && !short && estimate.room != null && estimate.credits > estimate.room;

  async function explain() {
    if (!quoteBody || busy) return;
    if (!model) return setFormError(privateOn ? "No private models are available right now." : "No callable chat model is available.");
    setFormError("");
    const ctl = new AbortController();
    controller.current = ctl;
    const started = { model, modelName: modelName(model), private: privateOn, saved: !unsaved };
    setGen({ status: "writing", ...started, items: 0 });
    let text = "",
      receipt = null,
      failure = null,
      conversation = null;
    try {
      await streamChat(
        { ...quoteBody, requestId: uid() },
        (event) => {
          if (event.contract && Number.isFinite(event.contract.started) && mounted.current)
            setGen((g) => (g?.status === "writing" ? { ...g, items: event.contract.started } : g));
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && text.length < 400000) text += delta;
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) receipt = event.anonyma;
          if (typeof event.conversationId === "string") conversation = event.conversationId;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Error(failure.message || "The model request failed.");
      const parsed = readContractReply(text, { finishReason: receipt?.finish_reason });
      if (!parsed.result) throw Error("The model's reply couldn't be read as a contract reading.");
      if (!mounted.current) return;
      setGen({ status: "done", ...started, result: parsed.result, charged: receipt?.credits_charged });
      if (!unsaved && conversation) onSaved(conversation);
    } catch (err) {
      const stopped = err.name === "AbortError";
      if (mounted.current)
        setGen({
          status: stopped ? "stopped" : "failed",
          ...started,
          error: stopped ? "Stopped. Nothing was charged." : err.message,
        });
    } finally {
      if (controller.current === ctl) controller.current = null;
      refresh?.();
    }
  }

  const meta = gen?.result
    ? { modelName: gen.modelName, charged: gen.charged, private: gen.private, saved: gen.saved }
    : saved
      ? { modelName: modelName(saved.model), charged: saved.charged, saved: true }
      : null;
  const factChecks = (facts.checks || []).map(factCheckText).filter(Boolean);
  const notes = (facts.notes || []).map((n) => NOTES[n]).filter(Boolean);
  const sentFiles = read ? read.files.filter((f) => f.sent).length : 0;
  return (
    <div className="ctr-reading">
      <p className="ctr-disclaimer">
        <Icon name="warning" size={14} />
        <span>{DISCLAIMER}</span>
      </p>
      {result && (
        <section className="ctr-section ctr-summary">
          <h2>In plain English</h2>
          <p data-i18n="off">{result.summary}</p>
          {meta && (
            <small className="ctr-meta">
              <span data-i18n="off">{meta.modelName}</span>
              {Number.isFinite(meta.charged) && <span>{`${formatCredits(meta.charged)} credits`}</span>}
              {meta.private ? <span>Private Mode</span> : meta.saved ? <span>Saved to your chats</span> : <span>Off the record</span>}
            </small>
          )}
        </section>
      )}
      <section className="ctr-section">
        <h2>
          Who controls it <small>From live reads</small>
        </h2>
        <ControlList facts={facts} />
      </section>
      <section className="ctr-section">
        <h2>What they can do</h2>
        {result ? (
          result.powers.length ? (
            <Items items={result.powers} index={index} onOpen={onOpen} />
          ) : (
            <p className="ctr-fine">The reading found no special powers over this contract.</p>
          )
        ) : (
          <p className="ctr-fine">
            {facts.verified
              ? "Explain it to see each power the code gives someone, linked to its file and line."
              : "Explain it to see what the functions found in its bytecode could let someone do."}
          </p>
        )}
      </section>
      <section className="ctr-section">
        <h2>Things to check</h2>
        {factChecks.length > 0 && (
          <ul className="ctr-items ctr-checks">
            {factChecks.map(([title, detail], i) => (
              <li key={"f" + i}>
                {title && (
                  <div className="ctr-item-head">
                    <b>{title}</b>
                    <span className="ctr-who ctr-from">From the chain</span>
                  </div>
                )}
                <p>{detail}</p>
              </li>
            ))}
          </ul>
        )}
        {result?.checks.length > 0 && <Items items={result.checks} index={index} onOpen={onOpen} />}
        {!factChecks.length && !result?.checks.length && (
          <p className="ctr-fine">{result ? "Nothing specific was flagged. That isn't a clean bill of health." : "Explain it to add the points the code raises."}</p>
        )}
      </section>
      <section className="ctr-section">
        <h2>What this can't tell you</h2>
        <ul className="ctr-limits">
          {FIXED_LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {notes.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {(result?.limits || []).map((l, i) => (
            <li key={"m" + i} data-i18n="off">
              {l}
            </li>
          ))}
        </ul>
      </section>

      {read && !result && (
        <section className="ctr-section ctr-explain">
          <h2>Explain it in plain English</h2>
          <p className="ctr-fine">
            {facts.verified
              ? `The model gets these facts and ${plural(sentFiles, "source file", "source files")} (${plural(read.sent.chars, "character", "characters")}, comment lines left out), sent as data with fixed instructions. Nothing else: no chats, memory or instructions of yours.`
              : "The model gets these facts and the functions found in the bytecode, sent as data with fixed instructions. Nothing else: no chats, memory or instructions of yours."}
          </p>
          <div className="ctr-controls">
            <label className="ctr-field ctr-model">
              Model
              <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
                {choices.map((m) => (
                  <option key={m.id} value={m.id} data-i18n="off">
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            {live && privateLive && (
              <PrivateModeToggle active={privateOn} disabled={busy} onToggle={() => setPrivateOn((on) => !on)} />
            )}
            {live && offRecordLive && (
              <EphemeralToggle
                active={offRecord || privateOn}
                disabled={busy || privateOn}
                reason={t("Off the record is on because Private mode is on")}
                onToggle={() => setOffRecord((on) => !on)}
              />
            )}
          </div>
          {noPrivate && <NoPrivateModelsNotice />}
          {formError && <Notice type="error">{formError}</Notice>}
          <div className="ctr-send">
            {busy ? (
              <button type="button" className="ctr-secondary" onClick={() => controller.current?.abort()}>
                <Icon name="stop" size={14} />
                Stop
              </button>
            ) : (
              <button type="button" className="button" disabled={!live || !model || noPrivate || short} onClick={explain}>
                {`Explain with ${modelName(model)}`}
              </button>
            )}
            {quoteBody && estimate.status === "ready" && (
              <span
                className={"credit-estimate " + (short ? "short" : limited ? "limited" : "ready")}
                role="status"
                title={t("The most this reading can cost, and exactly what's held while it's written: these facts and files and a full reply budget at the model's published rates. You're charged only for what's used, and nothing if the reading can't be used.")}
              >
                <Icon name="coins" size={13} />
                {`Up to ${formatCredits(estimate.credits)} credits`}
                {short && <b> · over your balance</b>}
                {limited && <b> · over your spending limit</b>}
              </span>
            )}
            {quoteBody && estimate.status === "loading" && <span className="credit-estimate loading">Updating estimate…</span>}
            {quoteBody && estimate.status === "unavailable" && (
              <span className="credit-estimate unavailable" title={estimate.message}>
                Estimate unavailable
              </span>
            )}
          </div>
          {busy && (
            <p className="ctr-fine" role="status">
              <span className="ctr-spinner" aria-hidden="true" />{" "}
              {gen.items ? `${gen.modelName} is reading… ${plural(gen.items, "point", "points")} so far` : `${gen.modelName} is reading the code…`}
            </p>
          )}
          {gen?.error && <Notice type="error">{gen.error}</Notice>}
          <p className="ctr-fine">
            {privateOn
              ? "Private Mode: zero-data-retention models only, and nothing is saved."
              : offRecord
                ? "Off the record: billed like a message, and the reading stays on this page only."
                : "Billed like a message and saved to your chats, so a reload reopens it and you can ask follow-ups there."}
          </p>
        </section>
      )}
      {!read && saved && (
        <p className="ctr-fine">To explain it again with today's facts, read the contract again above.</p>
      )}
    </div>
  );
}

function FileView({ view, start, end }) {
  const box = useRef(null);
  useEffect(() => {
    if (!start || !view.lines) return;
    box.current?.querySelector(`[data-line="${start}"]`)?.scrollIntoView?.({ block: "center" });
  }, [view.lines, start]);
  if (view.loading) return <p className="ctr-fine">Opening the file…</p>;
  if (view.error) return <Notice type="error">{view.error}</Notice>;
  let prev = 0;
  return (
    <div className="ctr-viewer">
      <p className="ctr-fine ctr-meta">
        <span>{plural(view.lines.length, "line", "lines")}</span>
        {view.bytes != null && <span>{formatBytes(view.bytes)}</span>}
        {start > 0 && <span>{end > start ? `Lines ${start}–${end} highlighted` : `Line ${start} highlighted`}</span>}
        {view.saved ? <span>What the AI read: comment and blank lines left out</span> : view.sent === false ? <span>Not sent to the AI</span> : null}
      </p>
      <div className="ctr-code" ref={box} data-i18n="off">
        {view.lines.map((l) => {
          const gap = view.saved && l.n > prev + 1;
          prev = l.n;
          const hit = start && l.n >= start && l.n <= (end || start);
          return (
            <React.Fragment key={l.n}>
              {gap && <div className="gap" aria-hidden="true"><span className="ctr-ln">⋯</span><span className="ctr-lc" /></div>}
              <div data-line={l.n} className={hit ? "hit" : undefined}>
                <span className="ctr-ln">{l.n}</span>
                <span className="ctr-lc">{l.text || " "}</span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
