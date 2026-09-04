import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("public wiring source boundaries", () => {
  it("reuses the adminPrisma global key and does not import admin deps or cookies", async () => {
    const source = stripComments(
      await readFile(path.resolve(process.cwd(), "src/app/_lib/public-deps.ts"), "utf8"),
    );
    expect(source).toContain("adminPrisma");
    expect(source).not.toMatch(/from ["']@\/app\/api\/admin\/_lib\/deps["']/);
    expect(source).not.toContain("next/headers");
    expect(source).not.toMatch(/\bcookies\s*\(/);
  });

  it("home carousel service reads serving and preserves the public field boundary", async () => {
    const source = stripComments(
      await readFile(path.resolve(process.cwd(), "src/lib/site/home-carousel-service.ts"), "utf8"),
    );
    expect(source).toContain("homeCarouselServing.findMany");
    expect(source).toContain("buildPublicArticleWhere");
    expect(source).not.toMatch(/upstreamCode|rawPayload|raw_payload/);
  });
});
