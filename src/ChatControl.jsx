import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./lib.js";
import { nearLatest, chargePresentation, mergeCharge } from "./chat-control.js";
import "./chat-control.css";

export function useReadingPosition({ enabled, end, composer, messages, busy }) {
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  function jump() {
    follow.current = true;
    setAway(false);
    if (end.current) {
      end.current.style.scrollMarginBottom =
        (composer.current?.offsetHeight || 0) + "px";
      end.current.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }
  function reset() {
    follow.current = true;
    setAway(false);
  }
  useEffect(() => {
    if (!enabled) return;
    const onScroll = () => {
      if (!end.current) return;
      const near = nearLatest(
        end.current.getBoundingClientRect().bottom,
        window.innerHeight,
        composer.current?.offsetHeight || 0,
      );
      follow.current = near;
      setAway(!near);
    };
    // Stop following as soon as upward intent arrives, before the next chunk.
    const onWheel = (e) => {
      if (e.deltaY < 0) {
        follow.current = false;
        setAway(true);
      }
    };
    const onKey = (e) => {
      if (
        !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) &&
        ["PageUp", "Home", "ArrowUp"].includes(e.key)
      ) {
        follow.current = false;
        setAway(true);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled]);
  useLayoutEffect(() => {
    if (!enabled) return;
    if (follow.current) jump();
    else if (end.current) setAway(true);
  }, [enabled, messages, busy]);
  return { away, jump, reset };
}

export function useRequestCharge(enabled) {
  const active = useRef(null),
    [state, setState] = useState(null),
    [checking, setChecking] = useState(false);
  const isCurrent = (id) => active.current === id;
  function reset() {
    active.current = null;
    setState(null);
    setChecking(false);
  }
  function begin(id) {
    if (!enabled) return;
    active.current = id;
    setChecking(false);
    setState({ requestId: id, status: "sending" });
  }
  function accept(id, value) {
    if (enabled && isCurrent(id) && value)
      setState((s) => mergeCharge(s, { ...value, requestId: id }));
  }
  async function recover(id = active.current) {
    if (!enabled || !id || !isCurrent(id)) return;
    setChecking(true);
    try {
      accept(id, await api("/api/requests/" + encodeURIComponent(id)));
    } catch {
      accept(id, { status: "unknown" });
    } finally {
      if (isCurrent(id)) setChecking(false);
    }
  }
  useEffect(
    () => () => {
      active.current = null;
    },
    [],
  );
  return { state, checking, begin, accept, recover, reset, isCurrent };
}

export function ChargeStatus({ state, checking, recover }) {
  const view = chargePresentation(state);
  if (!view) return null;
  return (
    <div className="charge-status" data-charge-state={state.status}>
      <div role="status" aria-live="polite">
        <strong>{view.title}</strong>
        <span>{view.detail}</span>
      </div>
      <small>Request {state.requestId}</small>
      {view.canCheck && (
        <button
          type="button"
          className="small-button"
          disabled={checking}
          onClick={() => recover()}
        >
          {checking ? "Checking…" : "Check charge status"}
        </button>
      )}
    </div>
  );
}
