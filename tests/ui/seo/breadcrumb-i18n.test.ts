import { describe, expect, it } from "vitest";

import { getHomeName } from "@/lib/seo/breadcrumb-i18n";

describe("getHomeName", () => {
  it("returns the English Home label by default", () => {
    expect(getHomeName("en")).toBe("Home");
    expect(getHomeName(null)).toBe("Home");
    expect(getHomeName(undefined)).toBe("Home");
  });

  it("keeps extra locale entries even though V1 only calls en", () => {
    expect(getHomeName("ja")).toBe("ホーム");
    expect(getHomeName("pt-BR")).toBe("Início");
  });

  it("falls back to Home for unknown locales", () => {
    expect(getHomeName("xx")).toBe("Home");
  });
});
