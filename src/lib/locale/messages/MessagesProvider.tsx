"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { SiteLocale } from "@/lib/locale/locale-canonical";

import { createTranslator, type Messages, type Translator } from "./index";

const MessagesContext = createContext<{
  locale: SiteLocale;
  messages: Messages;
  t: Translator;
} | null>(null);

export function MessagesProvider({
  locale,
  messages,
  children,
}: {
  locale: SiteLocale;
  messages: Messages;
  children: ReactNode;
}) {
  return (
    <MessagesContext.Provider value={{ locale, messages, t: createTranslator(messages, locale) }}>
      {children}
    </MessagesContext.Provider>
  );
}

export function useT(): Translator {
  const ctx = useContext(MessagesContext);
  if (!ctx) {
    throw new Error("useT() requires MessagesProvider");
  }
  return ctx.t;
}

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.3): lets a client
 * component nested under `SiteShell`'s `MessagesProvider` (e.g. the locale
 * switcher) read the currently-served `SiteLocale` from context instead of
 * needing it threaded down as an extra prop through every intermediate
 * component — the same context already carries it for `useT()` above.
 */
export function useLocale(): SiteLocale {
  const ctx = useContext(MessagesContext);
  if (!ctx) {
    throw new Error("useLocale() requires MessagesProvider");
  }
  return ctx.locale;
}
