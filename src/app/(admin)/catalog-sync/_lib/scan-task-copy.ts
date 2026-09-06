import { NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG, NOVEL_CATALOG_SYNC_FEATURE_FLAG } from "@/lib/flags";

import type { CatalogScanActionResult } from "../_actions";

/**
 * Derived structurally from the action's own return type, the same
 * `./outcome-copy.ts` pattern P0-S13 already established: nothing in this
 * client-facing file names `@/lib/tasks/moboreader` (Codex territory), not
 * even in a type position, so the boundary is obviously clean rather than
 * merely safe-in-practice.
 */
export type CatalogScanOutcome = Extract<CatalogScanActionResult, { ok: true }>["data"];

export type OutcomeTone = "success" | "info" | "warning" | "danger";
export type OutcomeCopy = { readonly tone: OutcomeTone; readonly title: string; readonly body: string };

const MODE_LABEL: Readonly<Record<"dry_run" | "apply", string>> = Object.freeze({
  dry_run: "dry_run（试运行）",
  apply: "apply（正式写入）",
});

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled catalog-scan outcome: ${JSON.stringify(value)}`);
}

/**
 * One entry per {@link CatalogScanOutcome} outcome, same exhaustiveness
 * discipline as `describeCreateContentOutcome` — a new outcome added to the
 * action's return type and not handled here is a build failure, not a blank
 * panel.
 */
export function describeCatalogScanOutcome(result: CatalogScanOutcome): OutcomeCopy {
  switch (result.outcome) {
    case "created":
      return {
        tone: "success",
        title: "扫描任务已入队",
        body: `任务已创建（模式：${MODE_LABEL[result.mode]}），等待 worker 消费。`,
      };
    case "created_disabled":
      return {
        tone: "warning",
        title: "任务已创建，但当前为 disabled——worker 不会处理",
        body: `任务已写入数据库（模式：${MODE_LABEL[result.mode]}），但相关 Feature Flag 未满足条件。请对照下方两个环境变量的当前状态，打开所需的那个（或两个）后，任务仍需人工重新创建——已入队的这个 disabled 任务不会自动恢复。`,
      };
    case "duplicate":
      return {
        tone: "info",
        title: "命中幂等——未重复创建",
        body: "本次提交命中了一条已存在的任务记录，系统按幂等规则直接返回该任务，没有重复入队。",
      };
    case "active_conflict":
      return {
        tone: "warning",
        title: "该渠道账户 / 渠道应用已有进行中的扫描任务",
        body: "已存在一个状态为 pending 或 processing 的任务，覆盖同一渠道账户、渠道应用与项目类型。请等待其完成或失败后再新建，避免并发抓取同一上游范围。",
      };
    default:
      return assertUnreachable(result);
  }
}

/** One row per gating flag, always both — see `CatalogScanOutcome`'s own doc for why. */
export type CatalogScanFlagRow = {
  readonly envName: string;
  readonly on: boolean;
  readonly note: string;
};

export function catalogScanFlagChecklist(
  flags: Extract<CatalogScanOutcome, { outcome: "created_disabled" }>["flags"],
): readonly CatalogScanFlagRow[] {
  return [
    {
      envName: NOVEL_CATALOG_SYNC_FEATURE_FLAG,
      on: flags.featureEnabled,
      note: "总闸：未开启则所有目录扫描任务创建后即为 disabled，无论 dry_run 还是 apply，worker 都不会处理。",
    },
    {
      envName: NOVEL_CATALOG_SYNC_ALLOW_WRITE_FLAG,
      on: flags.writeAllowed,
      note: "写闸：仅 apply 模式需要；dry_run 任务不受此闸影响。",
    },
  ];
}
