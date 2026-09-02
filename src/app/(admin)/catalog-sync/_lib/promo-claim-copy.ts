import { PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG, PROMO_LINK_CLAIM_FEATURE_FLAG } from "@/lib/flags";
import { PROMO_LINK_CLAIM_TASK_TYPE } from "@/lib/tasks/promo-link-claim-limits";

import type { PromoLinkClaimActionResult } from "../_actions";

/**
 * Human copy for the "领取推广链接" trigger on `/catalog-sync` (RC-1).
 *
 * Derived structurally from the action's own return type, the same
 * `../_lib/scan-task-copy.ts` pattern the catalog-scan trigger already uses:
 * nothing in this client-facing file names `@/lib/tasks/promo-link-claim`
 * (Codex territory) in a value position, keeping the boundary obviously
 * clean.
 */
export type PromoLinkClaimOutcome = Extract<PromoLinkClaimActionResult, { ok: true }>["data"];

export type OutcomeTone = "success" | "info" | "warning" | "danger";
export type OutcomeCopy = { readonly tone: OutcomeTone; readonly title: string; readonly body: string };

const MODE_LABEL: Readonly<Record<"dry_run" | "apply", string>> = Object.freeze({
  dry_run: "dry_run（试运行，不会调用 claimPromo）",
  apply: "apply（正式领取，可能触发一次不可逆的 claimPromo）",
});

/**
 * `skipReasonCounts` keys are the factory's own vocabulary
 * (`createPromoLinkClaimTask`'s doc comment lists all three). Kept as a
 * lookup with a safe fallback — a future fourth reason still renders,
 * just without a friendly label, instead of crashing the outcome panel.
 */
const SKIP_REASON_LABEL: Readonly<Record<string, string>> = Object.freeze({
  source_unlinked_or_deleted: "来源条目不存在、已被删除，或不属于所选渠道应用",
  source_not_linked: "来源条目尚未关联书目（未处于 linked 状态）",
  item_already_active_elsewhere: "该来源条目已经在另一个进行中的领取任务里",
});

export function skipReasonLabel(reason: string): string {
  return SKIP_REASON_LABEL[reason] ?? reason;
}

export function hasSkipReasons(counts: Readonly<Record<string, number>>): boolean {
  return Object.keys(counts).length > 0;
}

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled promo-link-claim outcome: ${JSON.stringify(value)}`);
}

/**
 * One entry per {@link PromoLinkClaimOutcome} outcome, same exhaustiveness
 * discipline as `describeCatalogScanOutcome` / `describeCreateContentOutcome`
 * — a new outcome added to the action's return type and not handled here is
 * a build failure, not a blank panel.
 */
export function describePromoLinkClaimOutcome(result: PromoLinkClaimOutcome): OutcomeCopy {
  switch (result.outcome) {
    case "enqueued":
      return {
        tone: "success",
        title: "领取任务已入队",
        body: `任务已创建（模式：${MODE_LABEL[result.mode]}），涉及 ${result.eligibleCount} 条来源条目，等待 worker 消费。`,
      };
    case "enqueued_disabled":
      return {
        tone: "warning",
        title: "任务已创建，但当前为 disabled——worker 不会处理",
        body: `任务已写入数据库（模式：${MODE_LABEL[result.mode]}，涉及 ${result.eligibleCount} 条来源条目），但相关 Feature Flag 未满足条件。请对照下方检查单打开所需项后，任务仍需人工重新创建——已入队的这个 disabled 任务不会自动恢复。`,
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
        title: "该渠道账户 / 渠道应用已有进行中的领取任务",
        body: "已存在一个状态为 pending 或 processing 的领取任务，覆盖完全相同的来源条目集合。请等待其完成或失败后再重新提交，避免并发领取同一批来源。",
      };
    case "no_eligible_sources":
      return {
        tone: "danger",
        title: "所选来源条目均不符合领取条件",
        body: "本次选择的来源条目全部被跳过，没有创建任何任务——请看下方逐条原因。",
      };
    case "capability_disabled":
      return {
        tone: "warning",
        title: "领取能力已冻结",
        body: "所选渠道应用的 claimPromo 能力位当前不是 enabled，未经 Owner 解冻，系统不会创建任务（避免创建一个注定不会被 worker 处理的任务）。",
      };
    default:
      return assertUnreachable(result);
  }
}

/** One row per gating flag, always both — mirrors `catalogScanFlagChecklist`. */
export type PromoLinkClaimFlagRow = {
  readonly envName: string;
  readonly on: boolean;
  readonly note: string;
};

export function promoLinkClaimFlagChecklist(
  flags: Extract<PromoLinkClaimOutcome, { outcome: "enqueued_disabled" }>["flags"],
): readonly PromoLinkClaimFlagRow[] {
  return [
    {
      envName: PROMO_LINK_CLAIM_FEATURE_FLAG,
      on: flags.featureEnabled,
      note: "总闸：未开启则整条领取链路（包括零上游调用的既有推广码读取）都不会被 worker 处理。",
    },
    {
      envName: PROMO_LINK_CLAIM_ALLOW_WRITE_FLAG,
      on: flags.writeAllowed,
      note: "写闸：任何受保护写入（含 claimPromo 本身）都需要它，与 mode 是 dry_run 还是 apply 无关。",
    },
  ];
}

/**
 * The web process cannot read the Worker's own `WORKER_TASK_ALLOWLIST` — that
 * env var only exists in the Worker's runtime. This is deliberately *not*
 * rendered as a live on/off row (which would falsely imply this page checked
 * it): it is a static reminder, because `docs/p2/V020_RELEASE_CHECKLIST.md`
 * §3 requires the task-type flag and the allowlist entry to ship in the same
 * deploy — a task can sit `pending` forever if the flags are on but
 * `promo_link.claim.v1` was never added to the Worker's allowlist.
 */
export const PROMO_LINK_CLAIM_ALLOWLIST_NOTE = `此外，Worker 端 WORKER_TASK_ALLOWLIST 还需要包含「${PROMO_LINK_CLAIM_TASK_TYPE}」——这一项本页无法直接查询，需要请运维/工程确认部署配置。`;

export const PROMO_LINK_CLAIM_NEXT_STEPS_NOTE =
  "任务由后台 worker 异步轮询消费，创建后不会立即看到结果。前往「任务中心」（/tasks）用 taskId 查询进度；本次领取涉及的推广链接结果会体现在「推广链接」（/promo-links）页。";

export function promoLinkClaimStatusQuery(taskId: string): string {
  return [
    "select status, total_count, success_count, failed_count, requested_at, started_at, completed_at, error",
    "from generic_task",
    `where id = '${taskId}';`,
  ].join("\n");
}

/**
 * apply 模式下的不可逆性提示（任务信 C：分方向写清误判后果，参照
 * `promo-link-copy.ts` 的 `claim_manual_review_required` 文案纪律）。
 *
 * dry_run 永远不会触发 claimPromo（工厂只把它当计划预览的一种模式，真正的
 * 领取只在 apply 且双闸与能力位都打开时才可能发生），所以这条提示只在
 * apply 模式下渲染。
 */
export const PROMO_LINK_CLAIM_APPLY_IRREVERSIBLE_WARNING =
  "apply 模式下，如果所选来源条目在上游还没有可复用的推广码，系统会为其发起一次 claimPromo 领取——" +
  "这是不可逆操作，一旦调用无法撤销，请确认这些来源条目确实需要领取新的推广码。" +
  "如果之前已经成功领取过，本次会直接复用已有结果，不会重复调用；" +
  "如果上一次领取结果未知（例如超时），系统会阻止本次自动重试并转入人工审查，不会盲目再次调用。";
