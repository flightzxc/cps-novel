import type { SiteLocale } from "@/lib/locale/locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

import { en, type Messages } from "./en";
import ar from "./ar";
import cs from "./cs";
import de from "./de";
import es from "./es";
import fr from "./fr";
import id from "./id";
import ja from "./ja";
import ko from "./ko";
import pl from "./pl";
import ptBR from "./pt-BR";
import ru from "./ru";
import th from "./th";
import vi from "./vi";
import zhHant from "./zh-Hant";

export type { Messages } from "./en";
export { en };

export type MessageVars = Record<string, string | number>;

type MessageLeaves<T, Prefix extends string = ""> = T extends string
  ? Prefix
  : {
      [K in keyof T & string]: MessageLeaves<T[K], Prefix extends "" ? K : `${Prefix}.${K}`>;
    }[keyof T & string];

export type MessageKey = MessageLeaves<Messages>;

export class MissingMessagesError extends Error {
  readonly locale: SiteLocale;

  constructor(locale: SiteLocale, detail?: string) {
    super(detail ? `Missing messages for locale "${locale}": ${detail}` : `Missing messages for locale "${locale}"`);
    this.name = "MissingMessagesError";
    this.locale = locale;
  }
}

const CATALOGS: Record<SiteLocale, Messages | Partial<Messages>> = {
  en,
  es,
  "pt-BR": ptBR,
  id,
  vi,
  th,
  ja,
  ko,
  "zh-Hant": zhHant,
  ar,
  fr,
  de,
  pl,
  cs,
  ru,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lookup(tree: unknown, path: string[]): unknown {
  let current: unknown = tree;
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function assertComplete(catalog: unknown, locale: SiteLocale, node: unknown, path: string[]): void {
  if (typeof node === "string") {
    const value = lookup(catalog, path);
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new MissingMessagesError(locale, path.join("."));
    }
    return;
  }
  if (!isRecord(node)) {
    throw new MissingMessagesError(locale, path.join(".") || "<root>");
  }
  for (const [key, child] of Object.entries(node)) {
    assertComplete(catalog, locale, child, [...path, key]);
  }
}

/** Load a locale catalog. Incomplete catalogs throw — never merge onto `en`. */
export function loadMessages(locale: SiteLocale): Messages {
  const catalog = CATALOGS[locale];
  if (catalog == null) {
    throw new MissingMessagesError(locale);
  }
  assertComplete(catalog, locale, en, []);
  return catalog as Messages;
}

export function t(messages: Messages, key: MessageKey, vars?: MessageVars): string {
  const value = lookup(messages, key.split("."));
  if (typeof value !== "string" || value.length === 0) {
    throw new MissingMessagesError("en", key);
  }
  if (!vars) return value;
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    if (!(name in vars)) {
      throw new MissingMessagesError("en", `${key} missing interpolation "{${name}}"`);
    }
    return String(vars[name]);
  });
}

export type Translator = (key: MessageKey, vars?: MessageVars) => string;

export function createTranslator(messages: Messages): Translator {
  return (key, vars) => t(messages, key, vars);
}

export function getPublicT(locale: SiteLocale = PUBLIC_SITE_LOCALE): Translator {
  return createTranslator(loadMessages(locale));
}
