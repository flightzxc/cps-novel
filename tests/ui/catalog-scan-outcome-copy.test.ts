import { describe, expect, it } from "vitest";

import {
  catalogScanFlagChecklist,
  catalogScanStatusQuery,
  describeCatalogScanOutcome,
  CATALOG_SCAN_NEXT_STEPS_NOTE,
  type CatalogScanOutcome,
} from "@/app/(admin)/catalog-sync/_lib/scan-task-copy";
import {
  NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG,
  NOVEL_CATALOG_SYNC_FEATURE_FLAG,
} from "@/lib/flags";

/**
 * `describeCatalogScanOutcome` (PR-C2) is the sibling of
 * `describeCreateContentOutcome` (P0-S13, see `catalog-sync-outcome-copy.test.ts`)
 * for `CatalogScanOutcome` — the type derived structurally from
 * `CatalogScanActionResult` (`../_actions.ts`), never from
 * `@/lib/tasks/moboreader` (Codex territory) directly. One fixture per
 * outcome, same exhaustiveness discipline: a new/renamed outcome on the
 * action's return type is a type error here before it can be a silently
 * blank panel in the form.
 */

const CREATED: CatalogScanOutcome = { outcome: "created", taskId: "task-1", mode: "dry_run" };
const CREATED_APPLY: CatalogScanOutcome = { outcome: "created", taskId: "task-2", mode: "apply" };
const CREATED_DISABLED: CatalogScanOutcome = {
  outcome: "created_disabled",
  taskId: "task-3",
  mode: "dry_run",
  flags: { featureEnabled: false, writeAllowed: false },
};
const DUPLICATE: CatalogScanOutcome = { outcome: "duplicate", taskId: "task-4" };
const ACTIVE_CONFLICT: CatalogScanOutcome = { outcome: "active_conflict", taskId: "task-5" };

const FIXTURES: readonly CatalogScanOutcome[] = [
  CREATED,
  CREATED_APPLY,
  CREATED_DISABLED,
  DUPLICATE,
  ACTIVE_CONFLICT,
];

describe("describeCatalogScanOutcome · 穷举覆盖（四种 outcome，五个代表性 fixture）", () => {
  it("每种 outcome 都有非空标题与正文，且 tone 落在冻结集合内", () => {
    for (const fixture of FIXTURES) {
      const copy = describeCatalogScanOutcome(fixture);
      expect(copy.title.trim().length, `${fixture.outcome} 标题为空`).toBeGreaterThan(0);
      expect(copy.body.trim().length, `${fixture.outcome} 正文为空`).toBeGreaterThan(0);
      expect(["success", "info", "warning", "danger"]).toContain(copy.tone);
    }
  });

  it("四种 outcome 的标题互不相同", () => {
    const distinctOutcomes = [CREATED, CREATED_DISABLED, DUPLICATE, ACTIVE_CONFLICT];
    const titles = distinctOutcomes.map((fixture) => describeCatalogScanOutcome(fixture).title);
    expect(new Set(titles).size).toBe(distinctOutcomes.length);
  });

  it("created 是 success 语气，携带的 mode 会体现在正文里", () => {
    const dryRun = describeCatalogScanOutcome(CREATED);
    expect(dryRun.tone).toBe("success");
    expect(dryRun.body).toContain("dry_run");

    const apply = describeCatalogScanOutcome(CREATED_APPLY);
    expect(apply.tone).toBe("success");
    expect(apply.body).toContain("apply");
  });

  it("created_disabled 是 warning——任务写进库了，但不会被 worker 处理，且措辞点出需要人工重建", () => {
    const copy = describeCatalogScanOutcome(CREATED_DISABLED);
    expect(copy.tone).toBe("warning");
    expect(copy.body).toContain("重新创建");
  });

  it("duplicate 是 info——幂等命中不算失败", () => {
    expect(describeCatalogScanOutcome(DUPLICATE).tone).toBe("info");
  });

  it("active_conflict 是 warning，正文说明是同一渠道账户/渠道应用已有 pending/processing 任务", () => {
    const copy = describeCatalogScanOutcome(ACTIVE_CONFLICT);
    expect(copy.tone).toBe("warning");
    expect(copy.body).toContain("pending");
    expect(copy.body).toContain("processing");
  });
});

describe("catalogScanFlagChecklist · 两个闸各自独立上报，从不静默省略一个", () => {
  it("同时关闭：两行都在，都标记未开启", () => {
    const rows = catalogScanFlagChecklist({ featureEnabled: false, writeAllowed: false });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.envName)).toEqual([
      NOVEL_CATALOG_SYNC_FEATURE_FLAG,
      NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG,
    ]);
    expect(rows.every((row) => row.on === false)).toBe(true);
  });

  it("总闸开、写闸关：两行的 on 各自独立，不是绑在一起判断", () => {
    const rows = catalogScanFlagChecklist({ featureEnabled: true, writeAllowed: false });
    const byName = Object.fromEntries(rows.map((row) => [row.envName, row.on]));
    expect(byName[NOVEL_CATALOG_SYNC_FEATURE_FLAG]).toBe(true);
    expect(byName[NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG]).toBe(false);
  });

  it("每一行都带真实 env 变量名，运营能直接照着改配置，而不是猜哪个开关", () => {
    const rows = catalogScanFlagChecklist({ featureEnabled: false, writeAllowed: true });
    expect(rows[0].envName).toBe("FEATURE_NOVEL_CATALOG_SYNC");
    expect(rows[1].envName).toBe("NOVEL_CATALOG_SYNC_ALLOW_WRITE");
    for (const row of rows) {
      expect(row.note.trim().length).toBeGreaterThan(0);
    }
  });

  it("写闸的说明点明只对 apply 生效，dry_run 不受影响——避免运营误以为两个闸对称", () => {
    const rows = catalogScanFlagChecklist({ featureEnabled: true, writeAllowed: false });
    const writeRow = rows.find((row) => row.envName === NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG);
    expect(writeRow?.note).toContain("apply");
  });
});

describe("catalogScanStatusQuery / CATALOG_SCAN_NEXT_STEPS_NOTE · 任务去向提示", () => {
  it("生成的只读查询把 taskId 嵌进 WHERE 子句，指向 catalog_scan_task 表", () => {
    const sql = catalogScanStatusQuery("task-abc-123");
    expect(sql).toContain("catalog_scan_task");
    expect(sql).toContain("task-abc-123");
    expect(sql).toMatch(/^select /);
    expect(sql).not.toMatch(/\b(update|delete|insert|drop)\b/i);
  });

  it("提示文案说明当前没有任务列表页，并给出 /tasks 的名字，而不是指向一个不存在的详情页", () => {
    expect(CATALOG_SCAN_NEXT_STEPS_NOTE).toContain("/tasks");
    expect(CATALOG_SCAN_NEXT_STEPS_NOTE.trim().length).toBeGreaterThan(0);
  });
});
