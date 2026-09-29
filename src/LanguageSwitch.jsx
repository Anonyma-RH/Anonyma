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

// Each language waits for its own release ("zh" for Chinese, "es" for
// Spanish): until then its button is hidden and its translator never runs,
// whatever was stored. English is always on.
const RELEASE = { en: null, es: "es", zh: "zh" };
// With a language: whether that one is released. Without: whether the
// switch has anything to offer at all.
export const languageReleased = (config, lang) =>
  lang
    ? !RELEASE[lang] || isReleased(config, RELEASE[lang])
    : isReleased(config, "zh") || isReleased(config, "es");

const CHOICES = [
  ["en", "EN", "English", "en"],
  ["es", "ES", "Español", "es"],
  ["zh", "中文", "简体中文", "zh-CN"],
];

// The stored language, or English while it isn't released.
export function useShownLanguage(config) {
  const language = useLanguage();
  return languageReleased(config, language) ? language : "en";
}

// "EN / ES / 中文". Its own labels are never translated (data-i18n="off").
export function LanguageSwitch({ config, className = "" }) {
  const language = useShownLanguage(config);
  if (!languageReleased(config)) return null;
  const choices = CHOICES.filter(([id]) => languageReleased(config, id));
  return (
    <div
      className={"language-switch " + className + (choices.length > 2 ? " three" : "")}
      role="group"
      aria-label={choices.length > 2 ? "Language / Idioma / 语言" : "Language / 语言"}
      data-i18n="off"
    >
      {choices.map(([id, label, name, lang]) => (
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

// Mounted once for the whole app: runs the translator while Español or 中文
// is chosen (and released). The dictionary loads on demand.
export function Translation({ config }) {
  const lang = useShownLanguage(config);
  useEffect(() => {
    if (lang === "en") return;
    let current = true;
    loadDictionary(lang).then(
      (dict) => current && startTranslator(dict),
      () => current && setLanguage("en"),
    );
    return () => {
      current = false;
      stopTranslator();
    };
  }, [lang]);
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
          {isReleased(config, "es")
            ? "Show the site in English, Spanish or Simplified Chinese. Your chats stay exactly as written."
            : "Show the site in English or Simplified Chinese. Your chats stay exactly as written."}
        </p>
      </div>
      <LanguageSwitch config={config} className="on-light" />
    </section>
  );
}
