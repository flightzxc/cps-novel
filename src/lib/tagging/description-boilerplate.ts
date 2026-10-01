import boilerplateV1 from "./artifacts/description-boilerplate-v1.json";

import { TaggingError } from "./contracts";
import { fingerprint } from "./stable-json";

/**
 * B-23: a versioned list of publisher/reprint boilerplate sentences. A
 * description that matches one is front matter ("This is a reproduction of a
 * book published before 1923 ..."), not a synopsis, so the text classifier
 * must not match keywords inside it. The title is always matched as before.
 *
 * This module only recognises such descriptions. It is consumed by the
 * deterministic classifier through the classifier config
 * (`TagClassifierConfig.descriptionBoilerplate`), never directly, so turning
 * the list on or off is always visible in the config version and fingerprint
 * that authorise a reclassification.
 */

export type DescriptionBoilerplatePosition = "anywhere" | "start";

export interface DescriptionBoilerplatePattern {
  id: string;
  /** Already in normalised form (see normalizeDescriptionForBoilerplate). */
  phrase: string;
  position: DescriptionBoilerplatePosition;
}

export interface DescriptionBoilerplateAuthority {
  version: string;
  /** Fingerprint of {version, id/phrase/position of every pattern}; documentation fields do not count. */
  sha256: string;
  patterns: readonly DescriptionBoilerplatePattern[];
}

export interface RawDescriptionBoilerplateArtifact {
  version?: unknown;
  schema_version?: unknown;
  patterns?: unknown;
}

export const CURRENT_DESCRIPTION_BOILERPLATE_VERSION = "description-boilerplate-v1";

// A phrase this short outside the start anchor would hit ordinary prose.
const MIN_PHRASE_LENGTH: Readonly<Record<DescriptionBoilerplatePosition, number>> = { anywhere: 24, start: 8 };

const RAW_AUTHORITIES: Readonly<Record<string, RawDescriptionBoilerplateArtifact>> = Object.freeze({
  "description-boilerplate-v1": boilerplateV1,
});

/** NFKC, lower-case, fold typographic quotes/dashes, drop zero-width characters, collapse whitespace. */
export function normalizeDescriptionForBoilerplate(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, "\"")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function descriptionBoilerplateFingerprint(version: string, patterns: readonly DescriptionBoilerplatePattern[]): string {
  return fingerprint({
    schemaVersion: 1,
    version,
    patterns: patterns.map(({ id, phrase, position }) => ({ id, phrase, position })),
  });
}

/** Validates a raw artifact and computes its fingerprint. Never reads configuration or the environment. */
export function createDescriptionBoilerplateAuthority(raw: RawDescriptionBoilerplateArtifact): DescriptionBoilerplateAuthority {
  if (
    typeof raw.version !== "string" || raw.version.length === 0
    || raw.schema_version !== 1
    || !Array.isArray(raw.patterns) || raw.patterns.length === 0
  ) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid description boilerplate authority");
  }
  const ids = new Set<string>();
  const phrases = new Set<string>();
  const patterns = (raw.patterns as Array<Record<string, unknown>>).map((entry) => {
    const { id, phrase, position, source, reason } = entry;
    if (
      typeof id !== "string" || id.length === 0
      || typeof phrase !== "string" || phrase.length === 0
      || (position !== "anywhere" && position !== "start")
      || typeof source !== "string" || source.length === 0
      || typeof reason !== "string" || reason.length === 0
    ) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid description boilerplate pattern");
    }
    if (phrase !== normalizeDescriptionForBoilerplate(phrase)) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", `Description boilerplate phrase ${id} is not normalised`);
    }
    if (phrase.length < MIN_PHRASE_LENGTH[position]) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", `Description boilerplate phrase ${id} is too short for position ${position}`);
    }
    if (ids.has(id) || phrases.has(`${position}\n${phrase}`)) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", `Duplicate description boilerplate pattern: ${id}`);
    }
    ids.add(id);
    phrases.add(`${position}\n${phrase}`);
    return Object.freeze({ id, phrase, position });
  });
  return Object.freeze({
    version: raw.version,
    sha256: descriptionBoilerplateFingerprint(raw.version, patterns),
    patterns: Object.freeze(patterns),
  });
}

const cache = new Map<string, DescriptionBoilerplateAuthority>();

export function loadDescriptionBoilerplateAuthority(
  version: string = CURRENT_DESCRIPTION_BOILERPLATE_VERSION,
): DescriptionBoilerplateAuthority {
  const cached = cache.get(version);
  if (cached) return cached;
  const raw = RAW_AUTHORITIES[version];
  if (!raw || raw.version !== version) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `Unknown description boilerplate authority: ${version}`);
  }
  const authority = createDescriptionBoilerplateAuthority(raw);
  cache.set(version, authority);
  return authority;
}

export interface DescriptionBoilerplateMatch {
  patternId: string;
}

/** The first pattern (list order) the description matches, or null. */
export function detectDescriptionBoilerplate(
  description: string | null | undefined,
  authority: DescriptionBoilerplateAuthority,
): DescriptionBoilerplateMatch | null {
  if (!description) return null;
  const text = normalizeDescriptionForBoilerplate(description);
  if (text.length === 0) return null;
  for (const pattern of authority.patterns) {
    if (pattern.position === "start" ? text.startsWith(pattern.phrase) : text.includes(pattern.phrase)) {
      return { patternId: pattern.id };
    }
  }
  return null;
}
