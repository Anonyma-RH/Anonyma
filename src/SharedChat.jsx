import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApp } from "./context.jsx";
import { Logo, Mark, Icon, Button } from "./ui.jsx";
import { LanguageSwitch } from "./LanguageSwitch.jsx";
import { NotFound } from "./Pages.jsx";
import { api, isReleased } from "./lib.js";
import { SHARE_TOKEN } from "./share-links.js";
import "./share-links.css";

// Share a Chat, the public side: /s/<token> shows a read-only snapshot to
// anyone with the link, signed in or not. It shows only what the snapshot
// holds (src/share-links.js): no account, costs or receipts. Message text is
// rendered as Markdown the way the workspace renders it (raw HTML shows as
// text, never as markup; unsafe link protocols are dropped), except that
// remote images are never loaded and Veil tags show as the tags they are.

// [EMAIL_1]-style tags as <mark> nodes, left as written: the real values
// were never on the server, so there's nothing to restore.
const TAG = /\[([A-Z]+_\d+)\]/g;
function markTags(node) {
  if (!node?.children) return;
  const next = [];
  for (const child of node.children) {
    if (child.type !== "text") {
      markTags(child);
      next.push(child);
      continue;
    }
    let cursor = 0,
      m;
    TAG.lastIndex = 0;
    while ((m = TAG.exec(child.value))) {
      if (m.index > cursor)
        next.push({ type: "text", value: child.value.slice(cursor, m.index) });
      next.push({
        type: "veilTag",
        data: {
          hName: "mark",
          hProperties: {
            className: "shared-veil-tag",
            title: "Masked with Veil before it was sent. The real value isn't part of this snapshot.",
          },
        },
        children: [{ type: "text", value: m[0] }],
      });
      cursor = m.index + m[0].length;
    }
    if (!cursor) next.push(child);
    else if (cursor < child.value.length)
      next.push({ type: "text", value: child.value.slice(cursor) });
  }
  node.children = next;
}
const veilTags = () => (tree) => markTags(tree);
const markdownParts = {
  // Links open elsewhere and carry no referrer (the page's own policy is
  // no-referrer too), so a shared link's address never travels on.
  a: ({ node, href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
    </a>
  ),
  // Never fetch a remote image on a viewer's behalf.
  img: () => <span className="shared-placeholder">[image not shared]</span>,
};

function withheldLabel(n) {
  return n === 1 ? "[attachment not shared]" : `[${n} attachments not shared]`;
}

function SharedMessage({ m }) {
  return (
    <article className={"shared-message " + m.role}>
      <div className="shared-avatar" aria-hidden="true">
        {m.role === "user" ? <Icon name="chat" size={14} /> : <Mark />}
      </div>
      <div className="shared-body">
        <div className="shared-label">
          {m.role === "user" ? "Prompt" : "Reply"}
          {m.model && (
            <span className="shared-model" data-i18n="off">
              {m.model}
            </span>
          )}
        </div>
        {m.text && (
          <div className="markdown" data-i18n="off">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, veilTags]}
              components={markdownParts}
            >
              {m.text}
            </ReactMarkdown>
          </div>
        )}
        {m.withheld > 0 && (
          <p className="shared-placeholder">{withheldLabel(m.withheld)}</p>
        )}
        {m.interrupted && <p className="shared-note">Reply interrupted.</p>}
        {m.citations?.length > 0 && (
          <div className="shared-citations">
            <span>Sources</span>
            {m.citations.map((c, i) => (
              <a
                key={c.url + i}
                data-i18n="off"
                href={c.url}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
              >
                {c.title || new URL(c.url).hostname}
              </a>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export default function SharedChat() {
  const { token } = useParams();
  const { config, loading } = useApp();
  const [state, setState] = useState({ status: "loading" });
  // Keep this page out of search results, and its address out of any
  // Referer header (the server sends the same as HTTP headers).
  useEffect(() => {
    const tags = [
      ["robots", "noindex, nofollow"],
      ["referrer", "no-referrer"],
    ].map(([name, content]) => {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      return meta;
    });
    return () => tags.forEach((t) => t.remove());
  }, []);
  useEffect(() => {
    if (!SHARE_TOKEN.test(token || "")) {
      setState({ status: "missing" });
      return;
    }
    let live = true;
    api("/api/s/" + token).then(
      (data) => live && setState({ status: "ready", data }),
      (e) =>
        live &&
        setState(
          e.status === 404 || e.status === 403
            ? { status: "missing" }
            : { status: "error", message: e.message },
        ),
    );
    return () => {
      live = false;
    };
  }, [token]);
  if (loading)
    return (
      <main id="main" className="loading-page">
        Opening the shared conversation…
      </main>
    );
  if (config && !isReleased(config, "sharelinks")) return <NotFound />;
  const data = state.data;
  const when = data ? new Date(data.created).toLocaleDateString() : "";
  return (
    <main id="main" className="shared-chat">
      <header className="shared-top">
        <Logo />
        {state.status === "ready" && (
          <span className="shared-top-tag">
            <Icon name="eye" size={14} />
            Read-only snapshot
          </span>
        )}
        <LanguageSwitch config={config} className="on-light" />
      </header>
      {state.status === "ready" ? (
        <>
          <section className="shared-hero">
            <p className="eyebrow">SHARED CONVERSATION</p>
            <h1 data-i18n="off">{data.title}</h1>
            <p className="shared-origin">
              Shared from ANONYMA · snapshot from {when}
            </p>
          </section>
          <div className="shared-banner" role="note">
            <Icon name="history" size={16} />
            <span>
              A snapshot, not a window: this is the conversation as it was on{" "}
              {when}. Later messages aren't included, and it can't be replied
              to.
            </span>
          </div>
          <div className="shared-messages">
            {data.messages.map((m, i) => (
              <SharedMessage m={m} key={i} />
            ))}
          </div>
          <footer className="shared-foot">
            <p>
              Shared from ANONYMA · snapshot from {when}. Masked details stay
              masked, and attachments aren't shared.
            </p>
            <a
              className="button"
              href="https://askanonyma.com"
              rel="noopener noreferrer"
            >
              askanonyma.com <Icon name="diagonal" size={15} />
            </a>
          </footer>
        </>
      ) : (
        <section className="shared-missing" aria-live="polite">
          {state.status === "loading" ? (
            <h1>Opening the shared conversation…</h1>
          ) : state.status === "missing" ? (
            <>
              <p className="eyebrow">SHARED CONVERSATION</p>
              <h1>This shared conversation isn't available.</h1>
              <p>
                The link may have expired or been revoked, or the conversation
                was deleted.
              </p>
              <Button to="/">
                Back to ANONYMA <Icon name="arrow" />
              </Button>
            </>
          ) : (
            <>
              <h1>The shared conversation couldn't be loaded.</h1>
              <p>{state.message}</p>
            </>
          )}
        </section>
      )}
    </main>
  );
}
