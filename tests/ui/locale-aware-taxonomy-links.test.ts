import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { loadPublicTaxonomyByNovelIds } from "@/lib/site/public-taxonomy";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.1): category
 * taxonomy hrefs are now locale-prefixed (`src/lib/site/public-taxonomy.ts`'s
 * `project` — a private function, exercised here through its one exported
 * caller). Fixture/mocking pattern mirrors the Codex-owned
 * `tests/backend/site/category-queries.test.ts` (same fake `$queryRaw`
 * shape) — this file adds a UI-side check specifically on the `href` field's
 * locale prefix, which that file's own assertions don't cover (they use
 * `expect.objectContaining` without `href`).
 *
 * No message-catalog dependency here — `public-taxonomy.ts` never calls
 * `getPublicT`/`loadMessages`, so this exercises a genuinely non-"en"
 * `SiteLocale` value without needing WO-3's not-yet-landed deep-merge
 * fallback (`es.ts` etc. are still empty placeholders in this worktree).
 */

const NOVEL_ID = "11111111-1111-4111-8111-111111111111";

const tagRow = {
  novel_id: NOVEL_ID,
  id: "22222222-2222-4222-8222-222222222222",
  slug: "fantasy",
  display_name: "Fantasy",
  canonical_definition: "Fantasy novels",
  sort_order: 7,
  updated_at: new Date("2026-09-02T00:00:00Z"),
};

function fakeDb(rows: readonly (typeof tagRow)[]) {
  return { $queryRaw: vi.fn().mockResolvedValue(rows) } as unknown as PrismaClient;
}

describe("public-taxonomy.ts · category href locale-prefixing", () => {
  it("stays bare for the default locale (en) — byte-identical to before WO-2", async () => {
    const result = await loadPublicTaxonomyByNovelIds(fakeDb([tagRow]), [NOVEL_ID], "en");
    expect(result.get(NOVEL_ID)?.[0]?.href).toBe("/category/fantasy");
  });

  it("prefixes a registered non-default locale", async () => {
    const result = await loadPublicTaxonomyByNovelIds(fakeDb([tagRow]), [NOVEL_ID], "fr");
    expect(result.get(NOVEL_ID)?.[0]?.href).toBe("/fr/category/fantasy");
  });

  it("preserves a hyphenated locale code verbatim", async () => {
    const result = await loadPublicTaxonomyByNovelIds(fakeDb([tagRow]), [NOVEL_ID], "pt-BR");
    expect(result.get(NOVEL_ID)?.[0]?.href).toBe("/pt-BR/category/fantasy");
  });

  it("falls back to the bare path (no prefix) for a locale string outside the registered set, rather than throwing", async () => {
    const result = await loadPublicTaxonomyByNovelIds(fakeDb([tagRow]), [NOVEL_ID], "not-a-real-locale");
    expect(result.get(NOVEL_ID)?.[0]?.href).toBe("/category/fantasy");
  });
});
