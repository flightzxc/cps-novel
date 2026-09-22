import { describe, expect, it } from "vitest";

import { resolveCanonicalTagLabel } from "@/lib/site/canonical-tag-label";

describe("resolveCanonicalTagLabel", () => {
  it("uses the requested locale when present", () => {
    expect(resolveCanonicalTagLabel({
      requested: "늑대인간",
      en: "Werewolf",
      zh: "狼人",
      slug: "werewolf",
    })).toBe("늑대인간");
  });

  it("falls back to en when the requested locale is missing", () => {
    expect(resolveCanonicalTagLabel({
      requested: null,
      en: "Werewolf",
      zh: "狼人",
      slug: "werewolf",
    })).toBe("Werewolf");
  });

  it("falls back to zh when requested and en are missing", () => {
    expect(resolveCanonicalTagLabel({
      requested: "  ",
      en: "",
      zh: "狼人",
      slug: "werewolf",
    })).toBe("狼人");
  });

  it("falls back to slug when every translation is missing", () => {
    expect(resolveCanonicalTagLabel({
      requested: null,
      en: null,
      zh: undefined,
      slug: "werewolf",
    })).toBe("werewolf");
  });

  it("does not throw on unexpected nullish input", () => {
    expect(() => resolveCanonicalTagLabel({ slug: "werewolf" })).not.toThrow();
  });
});
