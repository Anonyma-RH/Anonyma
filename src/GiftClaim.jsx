import React, { useEffect, useState } from "react";
import { useApp } from "./context.jsx";
import { Logo, Icon, Button, Notice } from "./ui.jsx";
import { LanguageSwitch } from "./LanguageSwitch.jsx";
import { NotFound } from "./Pages.jsx";
import { api, isReleased } from "./lib.js";
import { GiftCard } from "./GiftLinks.jsx";
import {
  GIFT_CODE_EVENT,
  GIFT_PATH,
  GIFT_STORE_KEY,
  forgetGiftCode,
  keptGiftCode,
  readCode,
} from "./gift-links.js";
import "./gift-links.css";

// Gift Links, the claim page (/gift, a 404 until released). The link's
// #code was taken out of the address bar before the app started
// (src/gift-boot.js) and waits in this tab only, so it survives signing in
// or creating an account on the way. It's sent only in a POST body, to look
// at the gift and to claim it; claiming (or finding the gift gone) forgets
// it. Nobody's name is shown: the claimer sees the amount and the note, the
// giver later sees only that it was claimed, and when.
const whole = (n) => Number(n).toLocaleString();
const date = (ms) => new Date(ms).toLocaleDateString();
const next = "?next=" + encodeURIComponent(GIFT_PATH);

const GONE = {
  claimed: {
    title: "This gift has already been claimed.",
    body: "A gift can be claimed once. If it was meant for you, ask the person who sent it for a new link.",
  },
  cancelled: {
    title: "This gift was cancelled.",
    body: "The person who sent it took it back before it was claimed. Its credits went back to them.",
  },
  expired: {
    title: "This gift wasn't claimed in time.",
    body: "Gifts wait 30 days. Its credits went back to the person who sent it.",
  },
  returned: {
    title: "This gift is no longer available.",
    body: "It was cancelled or wasn't claimed in time, so its credits went back to the person who sent it.",
  },
  missing: {
    title: "No gift matches this code.",
    body: "Check the link or the code and try again. A code has 28 letters and numbers.",
  },
};

function CodeForm({ onCode, error: shown }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  function submit(e) {
    e.preventDefault();
    const read = readCode(value);
    if (!read) return setError("That isn't a gift code. A code has 28 letters and numbers.");
    if (read.typo) return setError("That code has a typo. Check it and try again.");
    setError("");
    onCode(read.code);
  }
  return (
    <form className="gift-code-form" onSubmit={submit}>
      <label>
        Gift code or link
        <input
          value={value}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
          placeholder="Paste the link or type the code"
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
        />
      </label>
      {(error || shown) && <Notice type="error">{error || shown}</Notice>}
      <Button disabled={!value.trim()}>
        Open gift <Icon name="arrow" />
      </Button>
    </form>
  );
}

export default function GiftClaim() {
  const { config, user, loading, refresh } = useApp();
  const [code, setCode] = useState(() => keptGiftCode());
  const [state, setState] = useState({ status: code ? "loading" : "enter" });
  const [busy, setBusy] = useState(false);
  const live = !!config && isReleased(config, "giftlinks");
  // A new link pasted over the open page (src/gift-boot.js).
  useEffect(() => {
    const arrived = () => setCode(keptGiftCode());
    window.addEventListener(GIFT_CODE_EVENT, arrived);
    return () => window.removeEventListener(GIFT_CODE_EVENT, arrived);
  }, []);
  useEffect(() => {
    if (!live) return;
    if (!code) return setState((s) => (s.status === "done" ? s : { status: "enter" }));
    let current = true;
    setState({ status: "loading" });
    api("/api/gifts/peek", { method: "POST", body: { code } })
      .then((r) => {
        if (!current) return;
        if (r.status !== "open") forgetGiftCode();
        setState({ status: r.status, gift: r });
      })
      .catch((e) => {
        if (!current) return;
        if (e.code === "gift_not_found") {
          forgetGiftCode();
          setState({ status: "missing" });
        } else setState({ status: "error", message: e.message });
      });
    return () => {
      current = false;
    };
  }, [code, live, user?.id]);

  function takeCode(value) {
    try {
      sessionStorage.setItem(GIFT_STORE_KEY, value);
    } catch {}
    setCode(value);
  }
  function another() {
    forgetGiftCode();
    setCode(null);
    setState({ status: "enter" });
  }
  async function claim() {
    setBusy(true);
    try {
      const r = await api("/api/gifts/claim", { method: "POST", body: { code } });
      forgetGiftCode();
      setState({ status: "done", gift: r });
      refresh();
    } catch (e) {
      // Claimed or returned while this page was open: it's gone for good.
      const gone = { gift_claimed: "claimed", gift_returned: "returned", gift_not_found: "missing" }[e.code];
      if (gone) {
        forgetGiftCode();
        setState({ status: gone });
      } else setState((s) => ({ ...s, claimError: e.message }));
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <main id="main" className="loading-page">
        Opening your gift…
      </main>
    );
  if (!live) return <NotFound />;
  return (
    <ClaimView
      config={config}
      user={user}
      state={state}
      busy={busy}
      onCode={takeCode}
      onAnother={another}
      onClaim={claim}
    />
  );
}

// What the page shows for each state, with no effects of its own.
export function ClaimView({ config, user, state, busy, onCode, onAnother, onClaim }) {
  const gift = state.gift;
  const open = state.status === "open";
  const done = state.status === "done";
  const gone = GONE[state.status];
  return (
    <main id="main" className="gift-page">
      <header className="gift-top">
        <Logo />
        <span className="gift-top-tag">
          <Icon name="gift" size={14} />
          Gift link
        </span>
        <LanguageSwitch config={config} className="on-light" />
      </header>
      <section className={"gift-hero" + (open || done ? " with-card" : "")}>
        <div className="gift-hero-copy">
          <p className="eyebrow">{done ? "CLAIMED" : open ? "A GIFT OF AI" : "GIFT LINK"}</p>
          {done ? (
            <h1>{whole(gift.amount)} credits are yours.</h1>
          ) : open ? (
            <h1>You've been gifted {whole(gift.amount)} credits.</h1>
          ) : gone ? (
            <h1>{gone.title}</h1>
          ) : state.status === "loading" ? (
            <h1>Opening your gift…</h1>
          ) : (
            <h1>Claim a gift.</h1>
          )}
          {(open || done) && gift.note && (
            <blockquote className="gift-hero-note" data-i18n="off">
              “{gift.note}”
            </blockquote>
          )}
          {state.status !== "loading" && (
          <p className="gift-hero-lede">
            {done
              ? `They're in your balance now, ready for any model: ${whole(gift.available)} credits available.`
              : open
                ? `Use them with any model on ANONYMA: chat, code, images, video and voice. Claim by ${date(gift.expires)}.`
                : gone
                  ? gone.body
                  : "Paste the link or type the code you were given. Credits work with every model on ANONYMA."}
          </p>
          )}
        </div>
        {(open || done) && (
          <div className="gift-hero-card">
            <GiftCard amount={gift.amount} note={gift.note} expires={open ? gift.expires : null} claimed={done} />
          </div>
        )}
      </section>
      <section className="gift-panel" aria-live="polite">
        {state.status === "enter" && <CodeForm onCode={onCode} />}
        {state.status === "error" && (
          <>
            <Notice type="error">{state.message}</Notice>
            <button type="button" className="small-button" onClick={onAnother}>
              Enter another code
            </button>
          </>
        )}
        {gone && (
          <>
            <CodeForm onCode={onCode} />
          </>
        )}
        {open && gift.own && (
          <>
            <Notice>
              This is your own gift. Send the link to someone else; you can
              cancel it in Account → Credits & funding.
            </Notice>
            <div className="gift-actions">
              <Button to="/account/credits#gift-links">
                Your gifts <Icon name="arrow" />
              </Button>
            </div>
          </>
        )}
        {open && !gift.own && !user && (
          <>
            <h2>Sign in to claim it.</h2>
            <p>
              Any account works, new or existing: a username and password, a
              passkey, email or a wallet. You'll come straight back here.
            </p>
            <div className="gift-actions">
              <Button to={"/register" + next}>
                Create an account to claim <Icon name="arrow" />
              </Button>
              <Button to={"/login" + next} secondary>
                Log in
              </Button>
            </div>
          </>
        )}
        {open && !gift.own && user && (
          <>
            <h2>Claim {whole(gift.amount)} credits.</h2>
            <p>
              They go into the balance of the account you're signed in to.
              {user.username && (
                <span className="gift-signed-in">
                  Signed in as <b data-i18n="off">@{user.username}</b>
                </span>
              )}
            </p>
            {state.claimError && <Notice type="error">{state.claimError}</Notice>}
            <div className="gift-actions">
              <Button onClick={onClaim} disabled={busy}>
                {busy ? "Claiming…" : `Claim ${whole(gift.amount)} credits`}
                <Icon name="arrow" />
              </Button>
            </div>
          </>
        )}
        {done && (
          <div className="gift-actions">
            <Button to="/workspace/chat">
              Start a chat <Icon name="arrow" />
            </Button>
            <Button to="/account/credits" secondary>
              See your balance
            </Button>
          </div>
        )}
        <ul className="gift-facts">
          <li>
            <Icon name="check" size={15} />
            One account can claim a gift, once.
          </li>
          <li>
            <Icon name="eyeoff" size={15} />
            The person who sent it sees that it was claimed, and when. Never
            who.
          </li>
          <li>
            <Icon name="lock" size={15} />
            The code stays out of your address bar and our logs; we keep only
            a fingerprint of it.
          </li>
          <li>
            <Icon name="shield" size={15} />
            Gift credits have no cash value and can't be refunded to cash.
          </li>
        </ul>
      </section>
    </main>
  );
}
