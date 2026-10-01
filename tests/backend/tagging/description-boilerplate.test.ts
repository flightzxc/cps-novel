import { describe, expect, it } from "vitest";

import b23Config from "@/lib/tagging/artifacts/classifier-config-b23-v1.json";
import boilerplateJson from "@/lib/tagging/artifacts/description-boilerplate-v1.json";
import {
  createDescriptionBoilerplateAuthority,
  detectDescriptionBoilerplate,
  loadDescriptionBoilerplateAuthority,
  normalizeDescriptionForBoilerplate,
} from "@/lib/tagging/description-boilerplate";

// B-23: the versioned list of publisher/reprint boilerplate sentences.
// The fixtures below are the template sentences themselves (public publisher
// front matter), never synopses of real books.

const PINNED_LIST_SHA256 = "bd686eabb7fa9345c26a32693665d3ada7e82b9ce52e13870b5fd2bb5a8cbde7";

// The eight phrases the B-23 brief named, as written there.
const BRIEF_PHRASES: Array<[string, string]> = [
  ["bp-001", "This work has been selected by scholars as being culturally important"],
  ["bp-003", "This is a reproduction of a book published before 1923"],
  ["bp-004", "This book was originally published prior to 1923"],
  ["bp-005", "Reprint of the original, first published in"],
  ["bp-006", "This scarce antiquarian book is a facsimile reprint"],
  ["bp-007", "We have recreated this book from the original"],
  ["bp-008", "Excerpt from"],
  ["bp-009", "Unlike some other reproductions of classic texts"],
];

describe("B-23 description boilerplate list", () => {
  it("loads, is pinned by the B-23 config, and documents every pattern", () => {
    const authority = loadDescriptionBoilerplateAuthority();
    expect(authority.version).toBe("description-boilerplate-v1");
    expect(authority.sha256).toBe(PINNED_LIST_SHA256);
    expect(authority.sha256).toBe(b23Config.description_boilerplate.sha256);
    expect(authority.patterns).toHaveLength(boilerplateJson.patterns.length);
    // every pattern carries a source and a reason (checked when the list is built)
    for (const pattern of boilerplateJson.patterns) {
      expect(pattern.source.length).toBeGreaterThan(10);
      expect(pattern.reason.length).toBeGreaterThan(10);
    }
    expect(new Set(authority.patterns.map((pattern) => pattern.id)).size).toBe(authority.patterns.length);
  });

  it("records the two shapes the decision left alone as explicit non-rules", () => {
    const text = JSON.stringify(boilerplateJson.excluded_by_decision).toLowerCase();
    expect(text).toContain("alpha");
    expect(text).toContain("chef");
    // and no pattern tries to handle them
    for (const pattern of loadDescriptionBoilerplateAuthority().patterns) {
      expect(pattern.phrase).not.toMatch(/\balpha\b|\bchef\b/);
    }
  });

  it.each(BRIEF_PHRASES)("recognises the brief's template %s however the text is dressed up", (expectedId, phrase) => {
    const authority = loadDescriptionBoilerplateAuthority();
    const start = detectDescriptionBoilerplate(`${phrase} the rest of the publisher text.`, authority);
    expect(start?.patternId).toBe(expectedId);
    if (expectedId !== "bp-008") {
      // anywhere-patterns also match mid-text, upper-cased, with typographic dashes and odd whitespace
      const dressed = `A quiet intro.\u00a0\u00a0 ${phrase.toUpperCase().replace(/-/g, "\u2013")}\n\n and more.`;
      expect(detectDescriptionBoilerplate(dressed, authority)?.patternId).toBe(expectedId);
    }
  });

  it("only counts the short 'excerpt from' phrase at the very start of the description", () => {
    const authority = loadDescriptionBoilerplateAuthority();
    expect(detectDescriptionBoilerplate("Excerpt from Some Old Title\n\nChapter one ...", authority)?.patternId).toBe("bp-008");
    expect(detectDescriptionBoilerplate("  \u00a0EXCERPT FROM a title", authority)?.patternId).toBe("bp-008");
    expect(detectDescriptionBoilerplate("She read an excerpt from her late mother's diary.", authority)).toBeNull();
  });

  it("leaves ordinary synopses and near-misses alone", () => {
    const authority = loadDescriptionBoilerplateAuthority();
    for (const text of [
      "",
      null,
      undefined,
      "A prince returns to reclaim his throne while a soldier hides a secret.",
      "The reproduction of ancient pottery is her only talent, until the museum burns.",
      "Scholars say the manuscript is culturally important, but nobody believes her.",
      "He was published in 1923, a poet before his time.",
      "reprint of the original",
    ]) {
      expect(detectDescriptionBoilerplate(text, authority)).toBeNull();
    }
  });

  it("normalises NFKC, case, typographic quotes/dashes, zero-width characters and whitespace", () => {
    expect(normalizeDescriptionForBoilerplate("  \uff21\uff22  It\u2019s \u201cX\u201d \u2014 y\u200b z\t\n w ")).toBe("ab it's \"x\" - y z w");
  });

  it("every pattern is already stored in normalised form and long enough to be safe", () => {
    for (const pattern of loadDescriptionBoilerplateAuthority().patterns) {
      expect(pattern.phrase).toBe(normalizeDescriptionForBoilerplate(pattern.phrase));
      expect(pattern.phrase.length).toBeGreaterThanOrEqual(pattern.position === "anywhere" ? 24 : 8);
    }
  });

  it("rejects malformed lists", () => {
    const entry = { id: "x-1", phrase: "this is a long enough boilerplate phrase", position: "anywhere", source: "s", reason: "r" };
    const make = (patterns: unknown[], extra: Record<string, unknown> = {}) => createDescriptionBoilerplateAuthority({ version: "t", schema_version: 1, patterns, ...extra });
    expect(make([entry]).patterns).toHaveLength(1);
    expect(() => make([])).toThrow(/Invalid description boilerplate authority/);
    expect(() => make([entry], { schema_version: 2 })).toThrow(/Invalid description boilerplate authority/);
    expect(() => make([{ ...entry, reason: "" }])).toThrow(/Invalid description boilerplate pattern/);
    expect(() => make([{ ...entry, source: undefined }])).toThrow(/Invalid description boilerplate pattern/);
    expect(() => make([{ ...entry, position: "end" }])).toThrow(/Invalid description boilerplate pattern/);
    expect(() => make([{ ...entry, phrase: "Not Normalised  Phrase Here Today" }])).toThrow(/not normalised/);
    expect(() => make([{ ...entry, phrase: "too short" }])).toThrow(/too short/);
    expect(() => make([entry, { ...entry, phrase: "another long enough boilerplate phrase" }])).toThrow(/Duplicate/);
    expect(() => make([entry, { ...entry, id: "x-2" }])).toThrow(/Duplicate/);
  });

  it("the fingerprint follows the matching content, not the documentation", () => {
    const entry = { id: "x-1", phrase: "this is a long enough boilerplate phrase", position: "anywhere", source: "s", reason: "r" };
    const make = (patterns: unknown[]) => createDescriptionBoilerplateAuthority({ version: "t", schema_version: 1, patterns }).sha256;
    const base = make([entry]);
    expect(make([{ ...entry, source: "a different source", reason: "a different reason" }])).toBe(base);
    expect(make([{ ...entry, phrase: "this is a long enough boilerplate phrase!" }])).not.toBe(base);
    expect(make([{ ...entry, position: "start" }])).not.toBe(base);
    expect(make([{ ...entry, id: "x-9" }])).not.toBe(base);
    expect(createDescriptionBoilerplateAuthority({ version: "t2", schema_version: 1, patterns: [entry] }).sha256).not.toBe(base);
  });
});
