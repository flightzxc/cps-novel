import { describe, expect, it } from "vitest";

import { PUBLISH_GATE_REASONS } from "@/contracts/publish-gate";
import { describeMissingMetadataFields, describePublishGateReason } from "@/app/(admin)/novels/_lib/publish-gate-copy";
import {
  describePublishLifecycleError,
  describeRightsTransition,
  isPublishLifecycleErrorCode,
} from "@/app/(admin)/novels/_lib/publish-outcome-copy";

/**
 * PR-C3 task item 2: the Hard Gate's rejection reasons must be exhaustively
 * translated, per-reason, with a "go fix it here" pointer. `PUBLISH_GATE_REASONS`
 * (`@/contracts/publish-gate`, frozen) is the single source of truth for how
 * many reasons exist — this file iterates it directly rather than hardcoding
 * a parallel list, so a tenth reason added to the contract fails this suite
 * immediately instead of silently missing coverage.
 */
describe("describePublishGateReason · 穷尽契约登记的每一个 reason", () => {
  it(`契约当前登记 ${PUBLISH_GATE_REASONS.length} 个 reason，每一个都有非空 label 与 guidance`, () => {
    expect(PUBLISH_GATE_REASONS.length).toBeGreaterThan(0);
    for (const reason of PUBLISH_GATE_REASONS) {
      const copy = describePublishGateReason(reason);
      expect(copy.label.length, `${reason} 的 label 为空`).toBeGreaterThan(0);
      expect(copy.guidance.length, `${reason} 的 guidance 为空`).toBeGreaterThan(0);
    }
  });

  it("每个 reason 的 label 互不相同——运营要能一眼区分是哪一类拒绝", () => {
    const labels = PUBLISH_GATE_REASONS.map((reason) => describePublishGateReason(reason).label);
    expect(new Set(labels).size).toBe(PUBLISH_GATE_REASONS.length);
  });

  it("未登记的 reason 会在运行时抛出，而不是静默吞掉——防止契约新增值时本文件被遗忘", () => {
    expect(() => describePublishGateReason("not_a_real_reason" as never)).toThrow(
      /Unhandled publish gate reason/,
    );
  });

  it("promo_link_missing 的指引明确指向目录同步页面去绑定推广资源", () => {
    expect(describePublishGateReason("promo_link_missing").guidance).toContain("目录同步");
  });

  it("preview_chapter_missing 的指引同样指向目录同步（试读章节的落地来源）", () => {
    expect(describePublishGateReason("preview_chapter_missing").guidance).toContain("目录同步");
  });

  it("rights_blocked 的指引明确要求先「恢复」再重新发布", () => {
    expect(describePublishGateReason("rights_blocked").guidance).toContain("恢复");
  });

  it("blocking_sync_exception（DTO 层 fail-closed 收敛信号）指引指向工程排查，不建议重复尝试", () => {
    const copy = describePublishGateReason("blocking_sync_exception");
    expect(copy.guidance).toContain("工程");
    expect(copy.guidance).toContain("不要重复尝试");
  });
});

describe("describeMissingMetadataFields", () => {
  it("detail 为 null 时返回 null，不渲染任何附加说明", () => {
    expect(describeMissingMetadataFields(null)).toBeNull();
  });

  it("按契约 PUBLISH_REQUIRED_METADATA_FIELDS 的登记顺序渲染缺失字段的中文名，不按输入顺序", () => {
    const text = describeMissingMetadataFields({
      reason: "required_metadata_missing",
      missingFields: ["body", "title"],
    });
    expect(text).toBe("缺失字段：标题、正文");
  });

  it("slug 缺失时展示原样的英文标识，而不是翻译成别的词", () => {
    const text = describeMissingMetadataFields({ reason: "required_metadata_missing", missingFields: ["slug"] });
    expect(text).toBe("缺失字段：slug");
  });
});

/**
 * `PublishLifecycleError`'s six declared codes (`src/server/publish-gate/service.ts`).
 * `article_not_found` is currently unreachable (nothing in that module throws
 * it yet) but still type-declared, so it stays in this exhaustive list —
 * the whole point of the `never`-sentinel switch is to not require every
 * branch to already be reachable in order to require it be handled.
 */
const LIFECYCLE_ERROR_CODES = [
  "article_not_found",
  "novel_not_found",
  "novel_not_currently_published",
  "novel_already_takedown",
  "novel_not_currently_takedown",
  "batch_too_large",
] as const;

describe("describePublishLifecycleError · 穷尽 PublishLifecycleError 的六个 code", () => {
  it("每个 code 都有非空、互不相同的文案", () => {
    const messages = LIFECYCLE_ERROR_CODES.map((code) => describePublishLifecycleError(code));
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
    expect(new Set(messages).size).toBe(LIFECYCLE_ERROR_CODES.length);
  });

  it("未登记的 code 在运行时抛出，而不是静默兜底成一句空话", () => {
    expect(() => describePublishLifecycleError("not_a_real_code" as never)).toThrow(
      /Unhandled publish lifecycle error code/,
    );
  });

  it("batch_too_large 的文案点名批量发布上限（200 部）", () => {
    expect(describePublishLifecycleError("batch_too_large")).toContain("200");
  });
});

/**
 * Fix 1 (Opus review of C-21/22/23): `isPublishLifecycleErrorCode` is the
 * runtime guard `../../articles/_components/article-list.tsx` needs before
 * it can safely hand a bare `string` code (from `../../articles/_actions.ts`'s
 * flat `{ ok: false, code: string }` result) to `describePublishLifecycleError`
 * above, which throws on anything outside the six-member union.
 */
describe("isPublishLifecycleErrorCode", () => {
  it("对全部六个已登记 code 返回 true", () => {
    for (const code of LIFECYCLE_ERROR_CODES) {
      expect(isPublishLifecycleErrorCode(code)).toBe(true);
    }
  });

  it("对不属于该 union 的 code（如 article_conflict、*_failed fallback）返回 false，而不是抛出", () => {
    for (const code of ["article_conflict", "article_publish_failed", "article_withdraw_failed", ""]) {
      expect(isPublishLifecycleErrorCode(code)).toBe(false);
    }
  });
});

describe("describeRightsTransition · withdraw / takedown / restore 三种 kind", () => {
  const KINDS = ["withdraw", "takedown", "restore"] as const;

  it("每个 kind 都给出 actionLabel/confirmTitle/confirmLabel/warning/successMessage", () => {
    for (const kind of KINDS) {
      const copy = describeRightsTransition(kind);
      expect(copy.actionLabel.length).toBeGreaterThan(0);
      expect(copy.confirmTitle.length).toBeGreaterThan(0);
      expect(copy.confirmLabel.length).toBeGreaterThan(0);
      expect(copy.warning.length).toBeGreaterThan(0);
      expect(copy.successMessage.length).toBeGreaterThan(0);
    }
  });

  it("takedown 的警示明确提到版权/安全、410、章节正文会被永久删除且不可恢复", () => {
    const warning = describeRightsTransition("takedown").warning;
    expect(warning).toContain("版权");
    expect(warning).toContain("410");
    expect(warning).toContain("删除");
    expect(warning).toContain("不可恢复");
  });

  it("restore 的警示明确说明恒落 draft、绝不直接回到已发布、需重新过门禁", () => {
    const warning = describeRightsTransition("restore").warning;
    expect(warning).toContain("草稿");
    expect(warning).toContain("已发布");
    expect(warning).toContain("门禁");
  });

  it("withdraw 的警示说明这是稳定的 noindex 移除页，内容保留、不需要重新过门禁即可再发布", () => {
    const warning = describeRightsTransition("withdraw").warning;
    expect(warning).toContain("noindex");
    expect(warning).toContain("保留");
  });

  it("未登记的 kind 在运行时抛出", () => {
    expect(() => describeRightsTransition("bogus" as never)).toThrow(
      /Unhandled rights transition kind/,
    );
  });
});
