import { describe, expect, it } from "vitest";

import {
  PROMO_LINK_CLAIM_ALLOWLIST_NOTE,
  PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING,
  PROMO_LINK_CLAIM_NEXT_STEPS_NOTE,
  describePromoLinkClaimOutcome,
  hasSkipReasons,
  promoLinkClaimFlagChecklist,
  promoLinkClaimStatusQuery,
  skipReasonLabel,
  type PromoLinkClaimOutcome,
} from "@/app/(admin)/catalog-sync/_lib/promo-claim-copy";
import { PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG, PROMO_LINK_CLAIM_FEATURE_FLAG } from "@/lib/flags";
import { PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";

/**
 * `describePromoLinkClaimOutcome` (RC-1) is the sibling of
 * `describeCatalogScanOutcome` (PR-C2, see `catalog-scan-outcome-copy.test.ts`)
 * for `PromoLinkClaimOutcome` — the type derived structurally from
 * `PromoLinkClaimActionResult` (`../_actions.ts`), never from
 * `@/lib/tasks/promo-link-claim` (Codex territory) directly. One fixture per
 * outcome, same exhaustiveness discipline: a new/renamed outcome on the
 * action's return type is a type error here before it can be a silently
 * blank panel in the dialog.
 */

const ENQUEUED: PromoLinkClaimOutcome = {
  outcome: "enqueued",
  taskId: "task-1",
  mode: "dry_run",
  eligibleCount: 3,
  skipReasonCounts: {},
};
const ENQUEUED_APPLY: PromoLinkClaimOutcome = {
  outcome: "enqueued",
  taskId: "task-2",
  mode: "apply",
  eligibleCount: 2,
  skipReasonCounts: { source_not_linked: 1 },
};
const ENQUEUED_DISABLED: PromoLinkClaimOutcome = {
  outcome: "enqueued_disabled",
  taskId: "task-3",
  mode: "dry_run",
  eligibleCount: 1,
  skipReasonCounts: {},
  flags: { featureEnabled: false, writeAllowed: false },
};
const DUPLICATE: PromoLinkClaimOutcome = { outcome: "duplicate", taskId: "task-4" };
const ACTIVE_CONFLICT: PromoLinkClaimOutcome = { outcome: "active_conflict", taskId: "task-5" };
const NO_ELIGIBLE_SOURCES: PromoLinkClaimOutcome = {
  outcome: "no_eligible_sources",
  skipReasonCounts: { source_not_linked: 2, item_already_active_elsewhere: 1 },
};
const CAPABILITY_DISABLED: PromoLinkClaimOutcome = {
  outcome: "capability_disabled",
  channelAppId: "channel-app-1",
};

const FIXTURES: readonly PromoLinkClaimOutcome[] = [
  ENQUEUED,
  ENQUEUED_APPLY,
  ENQUEUED_DISABLED,
  DUPLICATE,
  ACTIVE_CONFLICT,
  NO_ELIGIBLE_SOURCES,
  CAPABILITY_DISABLED,
];

describe("describePromoLinkClaimOutcome · 穷举覆盖（六种 outcome，七个代表性 fixture）", () => {
  it("每种 outcome 都有非空标题与正文，且 tone 落在冻结集合内", () => {
    for (const fixture of FIXTURES) {
      const copy = describePromoLinkClaimOutcome(fixture);
      expect(copy.title.trim().length, `${fixture.outcome} 标题为空`).toBeGreaterThan(0);
      expect(copy.body.trim().length, `${fixture.outcome} 正文为空`).toBeGreaterThan(0);
      expect(["success", "info", "warning", "danger"]).toContain(copy.tone);
    }
  });

  it("六种 outcome 的标题互不相同", () => {
    const distinctOutcomes = [
      ENQUEUED,
      ENQUEUED_DISABLED,
      DUPLICATE,
      ACTIVE_CONFLICT,
      NO_ELIGIBLE_SOURCES,
      CAPABILITY_DISABLED,
    ];
    const titles = distinctOutcomes.map((fixture) => describePromoLinkClaimOutcome(fixture).title);
    expect(new Set(titles).size).toBe(distinctOutcomes.length);
  });

  it("enqueued 是 success 语气，携带的 mode 与 eligibleCount 都体现在正文里", () => {
    const dryRun = describePromoLinkClaimOutcome(ENQUEUED);
    expect(dryRun.tone).toBe("success");
    expect(dryRun.body).toContain("dry_run");
    expect(dryRun.body).toContain("3");

    const apply = describePromoLinkClaimOutcome(ENQUEUED_APPLY);
    expect(apply.tone).toBe("success");
    expect(apply.body).toContain("apply");
  });

  it("enqueued_disabled 是 warning——任务写进库了，但不会被 worker 处理，且措辞点出需要人工重建", () => {
    const copy = describePromoLinkClaimOutcome(ENQUEUED_DISABLED);
    expect(copy.tone).toBe("warning");
    expect(copy.body).toContain("重新创建");
  });

  it("duplicate 是 info——幂等命中不算失败", () => {
    expect(describePromoLinkClaimOutcome(DUPLICATE).tone).toBe("info");
  });

  it("active_conflict 是 warning，正文说明是同一渠道账户/渠道应用已有 pending/processing 领取任务", () => {
    const copy = describePromoLinkClaimOutcome(ACTIVE_CONFLICT);
    expect(copy.tone).toBe("warning");
    expect(copy.body).toContain("pending");
    expect(copy.body).toContain("processing");
  });

  it("no_eligible_sources 是 danger——所选条目全部被跳过，没有创建任何任务", () => {
    expect(describePromoLinkClaimOutcome(NO_ELIGIBLE_SOURCES).tone).toBe("danger");
  });

  it("capability_disabled 是 warning，措辞说明是渠道应用的 claimPromo 能力位未开启，不是账户或数据问题", () => {
    const copy = describePromoLinkClaimOutcome(CAPABILITY_DISABLED);
    expect(copy.tone).toBe("warning");
    expect(copy.body).toContain("claimPromo");
    expect(copy.body).toContain("enabled");
  });
});

describe("skipReasonLabel / hasSkipReasons · 跳过原因逐条可读", () => {
  it("三个已知原因都有独立、非代码原文的中文标签", () => {
    expect(skipReasonLabel("source_unlinked_or_deleted")).not.toBe("source_unlinked_or_deleted");
    expect(skipReasonLabel("source_not_linked")).not.toBe("source_not_linked");
    expect(skipReasonLabel("item_already_active_elsewhere")).not.toBe("item_already_active_elsewhere");
  });

  it("未登记的原因原样返回，而不是抛错或展示空白", () => {
    expect(skipReasonLabel("some_future_reason")).toBe("some_future_reason");
  });

  it("hasSkipReasons 区分空对象与非空对象", () => {
    expect(hasSkipReasons({})).toBe(false);
    expect(hasSkipReasons({ source_not_linked: 1 })).toBe(true);
  });
});

describe("promoLinkClaimFlagChecklist · 两个闸各自独立上报，从不静默省略一个", () => {
  it("同时关闭：两行都在，都标记未开启", () => {
    const rows = promoLinkClaimFlagChecklist({ featureEnabled: false, writeAllowed: false });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.envName)).toEqual([
      PROMO_LINK_CLAIM_FEATURE_FLAG,
      PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG,
    ]);
    expect(rows.every((row) => row.on === false)).toBe(true);
  });

  it("总闸开、写闸关：两行的 on 各自独立，不是绑在一起判断", () => {
    const rows = promoLinkClaimFlagChecklist({ featureEnabled: true, writeAllowed: false });
    const byName = Object.fromEntries(rows.map((row) => [row.envName, row.on]));
    expect(byName[PROMO_LINK_CLAIM_FEATURE_FLAG]).toBe(true);
    expect(byName[PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG]).toBe(false);
  });

  it("每一行都带真实 env 变量名，运营能直接照着改配置，而不是猜哪个开关", () => {
    const rows = promoLinkClaimFlagChecklist({ featureEnabled: false, writeAllowed: true });
    expect(rows[0].envName).toBe("FEATURE_PROMO_LINK_CLAIM");
    expect(rows[1].envName).toBe("PROMO_LINK_CLAIM_ALLOW_WRITE");
    for (const row of rows) {
      expect(row.note.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("PROMO_LINK_CLAIM_ALLOWLIST_NOTE · Worker allowlist 提醒", () => {
  it("点名真实任务类型，且不伪称本页能直接查询 Worker 配置", () => {
    expect(PROMO_LINK_CLAIM_ALLOWLIST_NOTE).toContain(PROMO_LINK_CLAIM_TASK_TYPE);
    expect(PROMO_LINK_CLAIM_ALLOWLIST_NOTE).toContain("WORKER_TASK_ALLOWLIST");
  });
});

describe("promoLinkClaimStatusQuery / PROMO_LINK_CLAIM_NEXT_STEPS_NOTE · 任务去向提示", () => {
  it("生成的只读查询把 taskId 嵌进 WHERE 子句，指向 generic_task 表，且不含写操作", () => {
    const sql = promoLinkClaimStatusQuery("task-abc-123");
    expect(sql).toContain("generic_task");
    expect(sql).toContain("task-abc-123");
    expect(sql).toMatch(/^select /);
    expect(sql).not.toMatch(/\b(update|delete|insert|drop)\b/i);
  });

  it("提示文案指向 /tasks 与 /promo-links，而不是指向一个不存在的详情页", () => {
    expect(PROMO_LINK_CLAIM_NEXT_STEPS_NOTE).toContain("/tasks");
    expect(PROMO_LINK_CLAIM_NEXT_STEPS_NOTE).toContain("/promo-links");
  });
});

describe("PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING · 不可逆性提示分方向说明后果", () => {
  it("既说清「新领取不可撤销」，也说清「已领取过/结果未知时不会盲目重复调用」——两个方向都不缺", () => {
    expect(PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING).toContain("不可逆");
    expect(PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING).toContain("claimPromo");
    expect(PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING).toContain("复用已有结果");
    expect(PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING).toContain("人工审查");
  });
});
