/**
 * P2-06.5 Lane C keyword eligibility overlay.
 *
 * CanonicalTag v1 Final is frozen.  Field/locale restrictions live in a
 * versioned overlay applied at lexicon build time.  Named scopes are the
 * already-present sourceLanguageName values; language 19/20 are never listed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const ELIGIBILITY_VERSION = "keyword-eligibility-v1";
export const EXPECTED_OVERLAY_SHA256 = "781916c970dc81735080f425fb9441c4484daf92ee534c82e1e48c04d8d259e4";

const ALLOWED_FIELDS = new Set(["title", "description", "chapter"]);
const REASONS = new Set([
  "GENERIC_KEYWORD_HOMONYM_FULL_DISABLE",
  "GENERIC_KEYWORD_DESCRIPTION_DISABLED",
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
  if (raw.version !== ELIGIBILITY_VERSION) fail(`overlay version must be ${ELIGIBILITY_VERSION}`);
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

export async function loadLexiconOverride(path, expectedSha256 = EXPECTED_OVERLAY_SHA256) {
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) {
    fail(`overlay SHA-256 mismatch: expected ${expectedSha256}, read ${digest}`);
  }
  const sidecar = `${path}.sha256`;
  const sidecarText = (await readFile(sidecar, "utf8")).trim().split(/\s/u)[0];
  if (sidecarText !== digest) fail(`overlay sidecar SHA-256 mismatch: sidecar ${sidecarText}, file ${digest}`);
  const overlay = validateLexiconOverride(JSON.parse(bytes.toString("utf8")));
  return { overlay, sha256: digest, path };
}
