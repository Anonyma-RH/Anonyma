import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./lib.js";
import {
  MAX_CHARACTERS,
  characterPagePath,
  hasOpening,
  initialOf,
  monogram,
  parseAvatar,
} from "./characters.js";
import "./character-chat.css";

// Characters, the small half the workspace always carries: the account's
// list, a character's picture, and the line above the composer that says who
// a chat is with. The page itself (src/Characters.jsx) loads on its own.

// The signed-in account's characters, loaded once the update is live. Quiet
// on failure: the workspace works the same without them.
export function useCharacters(enabled, account) {
  const [state, setState] = useState({ list: [], loaded: false, max: MAX_CHARACTERS });
  const reload = useCallback(async () => {
    if (!enabled) {
      setState({ list: [], loaded: false, max: MAX_CHARACTERS });
      return;
    }
    try {
      const r = await api("/api/characters");
      setState({ list: r.characters || [], loaded: true, max: r.max_characters || MAX_CHARACTERS, limits: r.limits });
    } catch {
      setState((s) => ({ ...s, loaded: true }));
    }
  }, [enabled, account]);
  useEffect(() => {
    reload();
  }, [reload]);
  return useMemo(
    () => ({
      ...state,
      reload,
      byId: (id) => (id ? state.list.find((c) => c.id === id) || null : null),
    }),
    [state, reload],
  );
}

// A picture: the image the account chose, or a flat monogram (the first
// letter of the name on a colour from the house palette). The name is the
// account's own word, so it is never translated.
export function CharacterAvatar({ name, avatar, size = 40, className = "" }) {
  const picture = parseAvatar(avatar) || { kind: "none" };
  const box = { width: size, height: size };
  if (picture.kind === "image")
    return <img className={"character-avatar image " + className} style={box} src={avatar} alt="" draggable="false" />;
  const m = monogram(picture.kind === "mono" ? picture.color : undefined);
  return (
    <span
      className={"character-avatar mono " + className}
      style={{ ...box, background: m.hex, color: m.ink, fontSize: Math.round(size * 0.46) }}
      data-i18n="off"
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}

// The chat header's mark of who the chat is with.
export function CharacterChip({ character }) {
  return (
    <span className="character-chip">
      <CharacterAvatar name={character.name} avatar={character.avatar} size={22} />
      <b data-i18n="off">{character.name}</b>
    </span>
  );
}

// The composer's character line: who this chat is with, what goes with it,
// and a way out before the first message.
export function CharacterBar({ character, saved, fresh, note = "", picker = null, onLeave }) {
  return (
    <div className="character-bar">
      <CharacterAvatar name={character.name} avatar={character.avatar} size={30} />
      <span className="character-bar-text">
        <span>{saved ? "Chat with" : "New chat with"}</span>{" "}
        <Link to={characterPagePath(character)} data-i18n="off">
          {character.name}
        </Link>
        {character.instructions.trim() && <span className="character-bar-fact">Instructions on</span>}
        {hasOpening(character) && <span className="character-bar-fact">Opening message</span>}
      </span>
      {fresh && (
        <button type="button" className="character-bar-leave" onClick={onLeave}>
          Leave character
        </button>
      )}
      {fresh && picker}
      {fresh && character.instructions.trim() && (
        <p className="character-bar-note">
          Sent with every message after your standing instructions and the project's, in that order. Veil masks them
          like anything you type.
        </p>
      )}
      {note && <p className="character-bar-note">{note}</p>}
    </div>
  );
}
