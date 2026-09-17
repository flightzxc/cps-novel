import { describe, expect, it } from "vitest";

import { REASON_MAX_LENGTH, validateReason } from "@/app/(admin)/novels/_lib/reason-guard";

/**
 * Fix 3 (Opus review of C-21/22/23): `validateReason` is the shared
 * "trim, reject blank, cap at 1000 chars" guard both
 * `../../src/app/(admin)/novels/_actions.ts`'s `requireNonBlankReason`
 * (withdraw/takedown/restore) and
 * `../../src/app/(admin)/articles/_components/article-list.tsx`'s row-level
 * "下线" dialog now call, instead of each hand-rolling the same two `if`
 * statements. `novel-publish-actions.test.ts` already covers the
 * throwing wrapper end-to-end via the Server Actions; this file pins the
 * shared function directly.
 */
describe("validateReason", () => {
  it("空白（含纯空格）→ reason_required", () => {
    expect(validateReason("")).toEqual({ ok: false, code: "reason_required" });
    expect(validateReason("   ")).toEqual({ ok: false, code: "reason_required" });
  });

  it("超过 1000 字（trim 后）→ reason_too_long", () => {
    expect(REASON_MAX_LENGTH).toBe(1000);
    const tooLong = "字".repeat(REASON_MAX_LENGTH + 1);
    expect(validateReason(tooLong)).toEqual({ ok: false, code: "reason_too_long" });
    // Padding that trims away must not count toward the limit.
    const paddedToLimit = `  ${"字".repeat(REASON_MAX_LENGTH)}  `;
    expect(validateReason(paddedToLimit)).toEqual({ ok: true, reason: "字".repeat(REASON_MAX_LENGTH) });
  });

  it("有效原因 → ok:true，返回 trim 后的值", () => {
    expect(validateReason("  运营决定临时下线  ")).toEqual({ ok: true, reason: "运营决定临时下线" });
  });
});
