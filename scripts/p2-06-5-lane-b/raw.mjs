const OBJECT_TOKEN_FIELDS = Object.freeze(["value", "name", "label", "id"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Extract one token without trimming, normalising, case-folding, translating,
 * repairing, or de-duplicating it.  An object is accepted only when exactly
 * one own value/name/label/id property contains a string.
 */
export function extractExactRawToken(rawItem) {
  if (typeof rawItem === "string") {
    return {
      ok: true,
      token: rawItem,
      exactRawToken: rawItem,
      sourceKind: "STRING",
      extractionPath: "$",
      candidateFields: [],
    };
  }

  if (!isRecord(rawItem)) {
    return {
      ok: false,
      reason: "UNSUPPORTED_RAW_TOKEN",
      candidateFields: [],
    };
  }

  const candidateFields = OBJECT_TOKEN_FIELDS.filter(
    (field) => Object.hasOwn(rawItem, field) && typeof rawItem[field] === "string",
  );
  if (candidateFields.length !== 1) {
    return {
      ok: false,
      reason: candidateFields.length === 0
        ? "NO_STRING_CANDIDATE"
        : "AMBIGUOUS_STRING_CANDIDATES",
      candidateFields,
    };
  }

  const field = candidateFields[0];
  const token = rawItem[field];
  return {
    ok: true,
    token,
    exactRawToken: token,
    sourceKind: "OBJECT",
    extractionPath: `$.${field}`,
    candidateFields,
  };
}

function anomalyStatus(reason) {
  if (reason === "AMBIGUOUS_STRING_CANDIDATES") return "AMBIGUOUS_OBJECT";
  if (reason === "NO_STRING_CANDIDATE") return "OBJECT_WITHOUT_STRING_CANDIDATE";
  return "UNSUPPORTED_TYPE";
}

/**
 * Preserve the original list and each raw item alongside extracted tokens.
 * Invalid structures are reported, never guessed or silently discarded.
 */
export function extractSeriesTypeTokens(rawSeriesTypeList) {
  if (!Array.isArray(rawSeriesTypeList)) {
    return {
      rawSeriesTypeList,
      tokens: [],
      anomalies: [{
        listIndex: null,
        rawItemJson: rawSeriesTypeList,
        reason: "SERIES_TYPE_LIST_NOT_ARRAY",
        structureStatus: "INVALID_LIST_STRUCTURE",
        candidateFields: [],
      }],
      complete: false,
    };
  }

  const tokens = [];
  const anomalies = [];
  rawSeriesTypeList.forEach((rawItem, listIndex) => {
    const result = extractExactRawToken(rawItem);
    if (!result.ok) {
      anomalies.push({
        listIndex,
        rawItemJson: rawItem,
        reason: result.reason,
        structureStatus: anomalyStatus(result.reason),
        candidateFields: [...result.candidateFields],
      });
      return;
    }
    tokens.push({
      listIndex,
      rawItemJson: rawItem,
      rawToken: result.token,
      exactRawToken: result.token,
      sourceKind: result.sourceKind,
      extractionPath: result.extractionPath,
      candidateFields: [...result.candidateFields],
    });
  });

  return {
    rawSeriesTypeList,
    tokens,
    anomalies,
    complete: anomalies.length === 0,
  };
}

function typedJsonValue(value, ancestors) {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("raw JSON value contains a non-finite number");
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("raw JSON numeric identity must be a safe integer");
    }
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (typeof value !== "object") {
    throw new TypeError("raw JSON identity accepts JSON values only");
  }
  if (ancestors.has(value)) throw new TypeError("raw JSON value must not be cyclic");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const encoded = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("raw JSON arrays must not be sparse");
        encoded.push(typedJsonValue(value[index], ancestors));
      }
      return ["array", encoded];
    }

    const encoded = Object.keys(value).sort().map((key) => [key, typedJsonValue(value[key], ancestors)]);
    return ["object", encoded];
  } finally {
    ancestors.delete(value);
  }
}

/** A collision-resistant, deterministic JSON type + value identity string. */
export function rawJsonIdentity(value) {
  return JSON.stringify(typedJsonValue(value, new Set()));
}

const RAW_LANGUAGE_NAME_MISSING = Symbol("RAW_LANGUAGE_NAME_MISSING");

/**
 * Exact upstream language scope. The code retains JSON type + value; the raw
 * name also retains missing versus explicit null versus a string (including
 * an empty or whitespace-only string). It is never converted to a site locale.
 * @param {unknown} rawLanguage
 * @param {string|null|symbol} [rawLanguageName]
 */
export function rawLanguageIdentity(rawLanguage, rawLanguageName = RAW_LANGUAGE_NAME_MISSING) {
  let nameIdentity;
  if (rawLanguageName === RAW_LANGUAGE_NAME_MISSING) {
    nameIdentity = ["missing"];
  } else if (rawLanguageName === null) {
    nameIdentity = ["null"];
  } else if (typeof rawLanguageName === "string") {
    nameIdentity = ["string", rawLanguageName];
  } else {
    throw new TypeError("raw languageName must be a string, null, or missing");
  }
  return JSON.stringify([
    "RAW_LANGUAGE_SCOPE_V1",
    rawJsonIdentity(rawLanguage),
    nameIdentity,
  ]);
}

/**
 * Build an exact source-book identity without delimiter or JSON-type collisions.
 * @param {unknown} sourceScope
 * @param {unknown} externalBookIdentity
 * @param {unknown} rawLanguage
 * @param {string|null|symbol} [rawLanguageName]
 */
export function exactBookIdentity(
  sourceScope,
  externalBookIdentity,
  rawLanguage,
  rawLanguageName = RAW_LANGUAGE_NAME_MISSING,
) {
  return JSON.stringify([
    "LANE_B_BOOK_ID_V1",
    rawJsonIdentity(sourceScope),
    rawJsonIdentity(externalBookIdentity),
    rawLanguageIdentity(rawLanguage, rawLanguageName),
  ]);
}

export const RAW_TOKEN_OBJECT_FIELDS = OBJECT_TOKEN_FIELDS;
