/**
 * P2-06.5 Lane C keyword eligibility overlay.
 *
 * CanonicalTag v1 Final is frozen.  Field/locale restrictions live in a
 * versioned overlay applied at lexicon build time.  Named scopes are the
 * already-present sourceLanguageName values; language 19/20 are never listed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Every overlay version this build can load, pinned to its exact bytes.
 * Superseded entries stay listed so runs already materialized against them
 * remain reproducible; `ELIGIBILITY_VERSION` names the current one.
 */
export const OVERLAY_SHA256_BY_VERSION = Object.freeze({
  "keyword-eligibility-v1": "781916c970dc81735080f425fb9441c4484daf92ee534c82e1e48c04d8d259e4",
  "keyword-eligibility-v2": "e796ba1ed79b344f790a70853d2e9773d6265e307615b2a60da28b90a6164854",
});

export const ELIGIBILITY_VERSION = "keyword-eligibility-v2";
export const EXPECTED_OVERLAY_SHA256 = OVERLAY_SHA256_BY_VERSION[ELIGIBILITY_VERSION];

const ALLOWED_FIELDS = new Set(["title", "description", "chapter"]);
const REASONS = new Set([
  "GENERIC_KEYWORD_HOMONYM_FULL_DISABLE",
  "GENERIC_KEYWORD_DESCRIPTION_DISABLED",
  "BARE_WORD_DESCRIPTION_DISABLED",
  // Retired by Owner Final 2026-08-17 after the suppression safety review
  // measured 40% false removal.  Kept registered only so the superseded v1
  // overlay still loads for reproduction; do not author new rules with it.
  "LOW_EVIDENCE_LOCALE_RULE",
]);

function fail(message) {
  throw new Error(`P2-06.5 lexicon eligibility: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeSeed(value) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

export function overlayRuleKey(canonicalTagId, normalizedSeed) {
  return `${canonicalTagId}\n${normalizedSeed}`;
}

export function validateLexiconOverride(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("overlay must be an object");
  if (!Object.hasOwn(OVERLAY_SHA256_BY_VERSION, raw.version)) {
    fail(`overlay version ${raw.version} is not a registered version`);
  }
  if (!raw.named_scope_labels || typeof raw.named_scope_labels !== "object") fail("named_scope_labels missing");
  const namedScopeValues = new Set(Object.values(raw.named_scope_labels));
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) fail("rules must be a non-empty array");
  const seen = new Set();
  const rules = raw.rules.map((rule, index) => {
    if (!rule || typeof rule !== "object") fail(`rules[${index}] must be an object`);
    const canonicalTagId = rule.canonical_tag_id;
    const normalizedSeed = rule.normalized_seed;
    if (typeof canonicalTagId !== "string" || canonicalTagId.length === 0) fail(`rules[${index}].canonical_tag_id required`);
    if (typeof normalizedSeed !== "string" || normalizedSeed.length === 0) fail(`rules[${index}].normalized_seed required`);
    const key = overlayRuleKey(canonicalTagId, normalizedSeed);
    if (seen.has(key)) fail(`duplicate overlay rule ${key}`);
    seen.add(key);
    if (typeof rule.enabled !== "boolean") fail(`rules[${index}].enabled must be boolean`);
    if (!REASONS.has(rule.reason)) fail(`rules[${index}].reason is not registered`);
    const allowedFields = rule.allowed_fields === undefined
      ? null
      : rule.allowed_fields;
    if (allowedFields !== null) {
      if (!Array.isArray(allowedFields) || allowedFields.length === 0) fail(`rules[${index}].allowed_fields must be a non-empty array`);
      if (new Set(allowedFields).size !== allowedFields.length) fail(`rules[${index}].allowed_fields must not contain duplicates`);
      for (const field of allowedFields) {
        if (!ALLOWED_FIELDS.has(field)) fail(`rules[${index}].allowed_fields contains unsupported field ${field}`);
      }
    }
    const blocked = rule.blocked_description_named_scopes === undefined
      ? []
      : rule.blocked_description_named_scopes;
    if (!Array.isArray(blocked)) fail(`rules[${index}].blocked_description_named_scopes must be an array`);
    if (new Set(blocked).size !== blocked.length) fail(`rules[${index}].blocked_description_named_scopes must not contain duplicates`);
    for (const name of blocked) {
      if (typeof name !== "string" || name.length === 0) fail(`rules[${index}] blocked scope must be a non-empty string`);
      if (name === "[null]" || name === "19" || name === "20") fail(`rules[${index}] must not target language 19/20`);
      if (!namedScopeValues.has(name)) fail(`rules[${index}] blocked scope ${name} is not a named sourceLanguageName`);
    }
    if (rule.enabled === false && (allowedFields !== null || blocked.length > 0)) {
      fail(`rules[${index}] full disable cannot also set field or locale restrictions`);
    }
    return {
      grade: rule.grade ?? null,
      canonicalTagId,
      normalizedSeed,
      enabled: rule.enabled,
      allowedFields,
      blockedDescriptionNamedScopes: blocked,
      reason: rule.reason,
      changeReason: rule.change_reason ?? rule.reason,
    };
  });
  return {
    version: raw.version,
    namedScopeLabels: raw.named_scope_labels,
    rules,
    byKey: new Map(rules.map((rule) => [overlayRuleKey(rule.canonicalTagId, rule.normalizedSeed), rule])),
  };
}

export async function loadLexiconOverride(path, expectedSha256 = null) {
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) {
    fail(`overlay SHA-256 mismatch: expected ${expectedSha256}, read ${digest}`);
  }
  const sidecar = `${path}.sha256`;
  const sidecarText = (await readFile(sidecar, "utf8")).trim().split(/\s/u)[0];
  if (sidecarText !== digest) fail(`overlay sidecar SHA-256 mismatch: sidecar ${sidecarText}, file ${digest}`);
  const overlay = validateLexiconOverride(JSON.parse(bytes.toString("utf8")));
  // The registry is the real gate: the bytes must match what this build pins
  // for the version the overlay declares.
  const pinned = OVERLAY_SHA256_BY_VERSION[overlay.version];
  if (digest !== pinned) fail(`overlay ${overlay.version} SHA-256 mismatch: pinned ${pinned}, read ${digest}`);
  return { overlay, sha256: digest, path };
}
