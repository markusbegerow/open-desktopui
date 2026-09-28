import { createContext, createElement, useContext, type ReactNode } from "react";
import en from "./en";
import de from "./de";
import es from "./es";

export type Dictionary = typeof en;
export type Language = "en" | "es" | "de";

const DICTIONARIES: Record<Language, Dictionary> = { en, es, de };

// pref wins if the user picked a specific language; "auto" (or unset) falls
// back to `detected` (from Open WebUI's user info — itself best-effort and
// possibly absent), mapped down to a supported language, defaulting to
// English if nothing usable was found.
export function resolveLanguage(
  pref: "auto" | Language | undefined,
  detected: string | null | undefined,
): Language {
  if (pref && pref !== "auto") return pref;
  const code = detected?.toLowerCase().slice(0, 2);
  if (code === "es" || code === "de") return code;
  return "en";
}

function lookup(dict: Dictionary, key: string): string {
  const value = key.split(".").reduce<unknown>((node, part) => {
    if (node && typeof node === "object" && part in node) {
      return (node as Record<string, unknown>)[part];
    }
    return undefined;
  }, dict);
  return typeof value === "string" ? value : key;
}

const I18nContext = createContext<Language>("en");

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  return createElement(I18nContext.Provider, { value: language }, children);
}

export function useTranslation() {
  const language = useContext(I18nContext);
  const dict = DICTIONARIES[language];
  function t(key: string): string {
    return lookup(dict, key);
  }
  return { t, language };
}
