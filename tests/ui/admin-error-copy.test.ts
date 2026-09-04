import { describe, expect, it } from "vitest";

import type { AdminErrorCode } from "@/contracts";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { ArticleConflictError } from "@/server/articles";

/**
 * PR6 lane D — closes the leftover flagged in `ArticleConflictError`'s doc
 * comment (`src/server/articles/service.ts`) and `src/app/(admin)/articles/
 * _actions.ts`'s `writeErrorCode`: `article_conflict` was thrown and returned
 * to the browser (N-7, lane B) but was never registered in `AdminErrorCode`
 * (`src/contracts/errors.ts`) or given an entry in the Chinese copy table
 * (`src/features/admin-ui/error-copy.ts`).
 *
 * `error-copy.ts`'s `COPY` object is typed `Readonly<Record<AdminErrorCode,
 * string>>`, so a code missing from `AdminErrorCode` (or present there but
 * missing from `COPY`) is already a compile error — this file is the runtime
 * lock on top of that compile-time one, matching the style of
 * `tests/ui/admin-error-envelope.test.ts`'s "new codes are never the generic
 * fallback sentence" block (outside this lane's file boundary, not to be
 * edited).
 */
describe("article_conflict — registered in the shared error taxonomy (N-7 / lane D)", () => {
  const FALLBACK = "操作失败，请稍后重试";

  it("ArticleConflictError's own code is the literal 'article_conflict' at 409", () => {
    const error = new ArticleConflictError();
    expect(error.code).toBe("article_conflict");
    expect(error.status).toBe(409);
  });

  it("has copy distinct from the generic fallback and from the unrelated site_setting_conflict", () => {
    const code: AdminErrorCode = "article_conflict";
    const copy = errorEnvelopeCopy({ ok: false, status: 409, code });
    expect(copy).not.toBe(FALLBACK);
    expect(copy).toBe("文章已被其他操作人修改，请刷新后重试");
    expect(copy).not.toBe(
      errorEnvelopeCopy({ ok: false, status: 409, code: "site_setting_conflict" }),
    );
  });

  it("names the required next action — reload, not retry — same as the article editor's own inline copy", () => {
    const copy = errorEnvelopeCopy({ ok: false, status: 409, code: "article_conflict" });
    expect(copy).toContain("刷新");
  });
});
