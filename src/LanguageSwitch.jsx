import React, { useEffect } from "react";
import { isReleased } from "./lib.js";
import {
  useLanguage,
  setLanguage,
  loadDictionary,
  startTranslator,
  stopTranslator,
} from "./i18n.js";
import "./i18n.css";

// Everything here waits for the "zh" release: until then the switch is
// hidden and the translator never runs, whatever was stored.
export const languageReleased = (config) => isReleased(config, "zh");

const CHOICES = [
  ["en", "EN", "English", "en"],
  ["zh", "中文", "简体中文", "zh-CN"],
];

// "EN / 中文". Its own labels are never translated (data-i18n="off").
export function LanguageSwitch({ config, className = "" }) {
  const language = useLanguage();
  if (!languageReleased(config)) return null;
  return (
    <div
      className={"language-switch " + className}
      role="group"
      aria-label="Language / 语言"
      data-i18n="off"
    >
      {CHOICES.map(([id, label, name, lang]) => (
        <button
          key={id}
          type="button"
          lang={lang}
          title={name}
          aria-pressed={language === id}
          onClick={() => setLanguage(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Mounted once for the whole app: runs the translator while 中文 is chosen.
export function Translation({ config }) {
  const on = useLanguage() === "zh" && languageReleased(config);
  useEffect(() => {
    if (!on) return;
    let current = true;
    loadDictionary().then(
      (dict) => current && startTranslator(dict),
      () => current && setLanguage("en"),
    );
    return () => {
      current = false;
      stopTranslator();
    };
  }, [on]);
  return null;
}

// Account → settings.
export function LanguageSettings({ config }) {
  if (!languageReleased(config)) return null;
  return (
    <section>
      <div>
        <h2>Language.</h2>
        <p>
          Show the site in English or Simplified Chinese. Your chats stay
          exactly as written.
        </p>
      </div>
      <LanguageSwitch config={config} className="on-light" />
    </section>
  );
}
