import { describe, expect, it } from "vitest";

import { MIN_HEALTHY_SLUG_LENGTH, isHealthySlug, textToSlug } from "@/lib/slug/text-to-slug";

describe("textToSlug — en (Latin word segmentation)", () => {
  it("lowercases and hyphenates words", () => {
    expect(textToSlug("Hell's Kitchen Apocalypse Edition", "en")).toBe("hells-kitchen-apocalypse-edition");
  });

  it("preserves diacritics on Latin letters", () => {
    expect(textToSlug("La Ascensión", "en")).toBe("la-ascensión");
  });

  it("treats punctuation and whitespace runs as a single separator", () => {
    expect(textToSlug("The  Great---Adventure!!!", "en")).toBe("the-great-adventure");
  });

  it("elides apostrophes rather than splitting on them", () => {
    expect(textToSlug("Don't Look Back", "en")).toBe("dont-look-back");
  });

  it("keeps digits inside a Latin word", () => {
    expect(textToSlug("Chapter 12 Begins", "en")).toBe("chapter-12-begins");
  });

  it("preserves a non-Latin run as its own lowercased Unicode segment instead of dropping or transliterating it", () => {
    // No pinyin dependency — see module header. Chinese text passed through
    // the "en" rule (which is all that exists today) survives as Unicode,
    // it is not romanized.
    expect(textToSlug("霸道总裁 Free Watch", "en")).toBe("霸道总裁-free-watch");
  });

  it("returns the fallback for input that normalizes to nothing", () => {
    expect(textToSlug("!!! --- ...", "en")).toBe("untitled");
  });

  it("returns the fallback for an empty string", () => {
    expect(textToSlug("", "en")).toBe("untitled");
  });

  it("returns the fallback for whitespace-only input", () => {
    expect(textToSlug("   ", "en")).toBe("untitled");
  });

  it("is deterministic for the same input", () => {
    const a = textToSlug("Same Title Twice", "en");
    const b = textToSlug("Same Title Twice", "en");
    expect(a).toBe(b);
  });
});

describe("isHealthySlug", () => {
  it("accepts a slug at or above the minimum length", () => {
    expect(isHealthySlug("abcde")).toBe(true);
    expect(MIN_HEALTHY_SLUG_LENGTH).toBe(5);
  });

  it("rejects a slug shorter than the minimum length", () => {
    expect(isHealthySlug("hi")).toBe(false);
  });

  it("strips a numeric conflict suffix before judging length", () => {
    // "ab-2" is 4 chars total but its *base* is "ab" (2 chars) — still unhealthy.
    expect(isHealthySlug("ab-2")).toBe(false);
    // "abcde-2" bases to "abcde" (5 chars) — healthy.
    expect(isHealthySlug("abcde-2")).toBe(true);
  });

  it("only strips a hyphen-prefixed trailing run of digits, not digits fused onto the base word", () => {
    // "ab12" has no hyphen before its trailing digits, so nothing is
    // stripped — it stays 4 chars and is judged unhealthy at the default
    // minimum. If the stripping were naively "any trailing digits" this
    // would incorrectly become "ab" either way; requiring the hyphen is
    // what makes the distinction observable.
    expect(isHealthySlug("ab12")).toBe(false);
  });

  it("respects a custom minimum length", () => {
    expect(isHealthySlug("abcdefghij", 12)).toBe(false);
    expect(isHealthySlug("abcdefghijkl", 12)).toBe(true);
  });

  it("treats the fallback slug as healthy", () => {
    expect(isHealthySlug(textToSlug("", "en"))).toBe(true);
  });
});
