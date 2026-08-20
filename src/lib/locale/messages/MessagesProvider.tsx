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
    <MessagesContext.Provider value={{ locale, messages, t: createTranslator(messages) }}>
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
