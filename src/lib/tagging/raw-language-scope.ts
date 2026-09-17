const RAW_LANGUAGE_NAME_MISSING = Symbol("RAW_LANGUAGE_NAME_MISSING");

type RawLanguageName = string | null | typeof RAW_LANGUAGE_NAME_MISSING;

function typedJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("raw JSON value contains a non-finite number");
    if (!Number.isSafeInteger(value)) throw new TypeError("raw JSON numeric identity must be a safe integer");
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (typeof value !== "object") throw new TypeError("raw JSON identity accepts JSON values only");
  if (ancestors.has(value)) throw new TypeError("raw JSON value must not be cyclic");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const encoded: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("raw JSON arrays must not be sparse");
        encoded.push(typedJsonValue(value[index], ancestors));
      }
      return ["array", encoded];
    }
    return [
      "object",
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, typedJsonValue((value as Record<string, unknown>)[key], ancestors)]),
    ];
  } finally {
    ancestors.delete(value);
  }
}

/** Collision-resistant identity preserving the original JSON type and value. */
export function rawJsonIdentity(value: unknown): string {
  return JSON.stringify(typedJsonValue(value, new Set()));
}

/** Lane B RAW_LANGUAGE_SCOPE_V1. No normalization is permitted. */
export function rawLanguageIdentity(
  rawLanguage: unknown,
  rawLanguageName: RawLanguageName = RAW_LANGUAGE_NAME_MISSING,
): string {
  const nameIdentity = rawLanguageName === RAW_LANGUAGE_NAME_MISSING
    ? ["missing"]
    : rawLanguageName === null
      ? ["null"]
      : typeof rawLanguageName === "string"
        ? ["string", rawLanguageName]
        : (() => { throw new TypeError("raw languageName must be a string, null, or missing"); })();
  return JSON.stringify(["RAW_LANGUAGE_SCOPE_V1", rawJsonIdentity(rawLanguage), nameIdentity]);
}

/** Return null instead of guessing when the raw scope cannot be derived. */
export function rawLanguageScopeFromPayload(rawPayload: unknown): string | null {
  if (rawPayload === null || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const row = rawPayload as Record<string, unknown>;
  if (!Object.hasOwn(row, "language")) return null;
  if (!Object.hasOwn(row, "languageName")) return rawLanguageIdentity(row.language);
  if (row.languageName !== null && typeof row.languageName !== "string") return null;
  return rawLanguageIdentity(row.language, row.languageName);
}

