/**
 * Copy for the manual-review section of `/tasks` — the operator-facing side
 * of `SideEffectIntent.status = "manual_review_required"`.
 *
 * This is the one place in the admin UI where an operator asserts a fact
 * about the outside world instead of the system observing one. Every string
 * here exists to keep that distinction visible: a click here is a claim, not
 * a query, and `resolveManualReview` never re-verifies it against upstream —
 * see `automaticReconciliation: false` in the response, always `false`,
 * never anything else (`src/server/task-admin/service.ts`'s frozen
 * `GUIDANCE` constant).
 */

/** Both resolve-mutation buttons. `effect_confirmed` / `no_effect_confirmed` are `resolveManualReview`'s own `resolution` enum values. */
export type ManualReviewResolution = "effect_confirmed" | "no_effect_confirmed";

export const MANUAL_REVIEW_WARNING =
  "这是一次人工断言，不是系统核实。你正在代表系统确认「这次操作在上游到底有没有真的发生」——" +
  "系统自己不知道答案，也不会去核实，完全由你的判断决定。提交后立即生效且不可撤销；" +
  "系统不会因此自动触发任何上游对账或补偿动作（返回体 automaticReconciliation 恒为 false），" +
  "后续需要做什么，由下方“后续步骤”按人工指引另行执行。";

const RESOLUTION_COPY: Readonly<
  Record<ManualReviewResolution, { readonly label: string; readonly warning: string; readonly confirmLabel: string }>
> = Object.freeze({
  effect_confirmed: {
    label: "确认副作用已发生",
    warning:
      "选择这个选项意味着：你确认这次操作在上游确实已经生效（例如推广码已经被真实领取）。" +
      "如果实际并未发生而你误判为已发生，系统会认为这件事已经做完、不会再尝试——这个差错很难再被自动发现。",
    // See the sibling `no_effect_confirmed` entry below for why this is not
    // the same string as the trigger button's "确认副作用已发生".
    confirmLabel: "提交裁决：已发生",
  },
  no_effect_confirmed: {
    label: "确认未发生",
    warning:
      "选择这个选项意味着：你确认这次操作在上游并未生效。" +
      "如果实际已经发生而你误判为未发生，之后基于此的重试可能会在上游造成重复副作用（例如重复领取）。",
    // Deliberately not the same string as the trigger button's own "确认未发生"
    // label — two controls with identical accessible names on one screen
    // (open the dialog / submit inside it) is exactly the ambiguity a screen
    // reader user or `getByRole("button", { name })` cannot disambiguate.
    confirmLabel: "提交裁决：未发生",
  },
});

export function manualReviewResolutionCopy(resolution: ManualReviewResolution) {
  return RESOLUTION_COPY[resolution];
}

/**
 * `ManualReviewDto.guidance.nextActions` is a frozen two-element tuple,
 * always the same two values (`GUIDANCE.nextActions` in the service) — not a
 * per-row field that varies. Copy is authored here rather than left as raw
 * identifiers because the frontend, not the server, owns operator-facing
 * strings (`error-copy.ts`'s header states the same rule for error codes).
 */
export const NEXT_ACTION_COPY: Readonly<Record<string, string>> = Object.freeze({
  upstream_readback: "去上游渠道后台核实这次操作的真实结果（人工登录核对，系统不会自动核实）",
  authorized_rescan: "如确有必要，在获得授权后另行发起一次新的补偿扫描或重试——裁决本身不会触发它",
});

export function nextActionCopy(action: string): string {
  return NEXT_ACTION_COPY[action] ?? action;
}

export const MANUAL_REVIEW_EMPTY_STATE =
  "当前没有待人工裁决的副作用意图——说明近期没有结果不明的领取/写入尝试卡在这里。";

/**
 * Surfaced next to the resolve controls so an operator understands why
 * resolving matters beyond record-keeping: it is what unblocks the parent
 * task's own `task_admin_unresolved_intent` retry refusal, not a retry by
 * itself.
 */
export const MANUAL_REVIEW_UNBLOCKS_RETRY_NOTE =
  "裁决本身不会重试任何东西。它唯一的直接效果是：如果这条意图此前正卡住某个失败任务的“重试失败项”" +
  "（该任务会返回「该任务有未裁决的人工审查项」），裁决后那个任务才有可能被重试——但重试仍需要你回到任务列表手动点击。";
