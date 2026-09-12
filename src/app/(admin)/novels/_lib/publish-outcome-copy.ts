import type { PublishLifecycleErrorCode } from "../_actions";
import type { RightsTransitionKind } from "../_types/publish-gate";

/**
 * Operator-facing copy for `src/server/publish-gate/service.ts`'s outcomes
 * that are not the Hard Gate rejection reasons (`./publish-gate-copy.ts`
 * covers those). Two families:
 *
 *  - `PublishLifecycleError.code` — the six-member, frozen union that class
 *    declares (`service.ts`'s `PublishLifecycleError`). `article_not_found`
 *    is declared there but never actually thrown by anything in this round
 *    (only the rights transitions' `requireSourceStatus` and the batch
 *    publish size guard throw today) — kept here anyway, exhaustively,
 *    because the type still promises it can happen and a silent fallback
 *    string would be the wrong thing to ship for a code that type-checks.
 *  - `RightsTransitionKind` — withdraw/takedown/restore's own labels and
 *    confirmation copy, used by the detail-page lifecycle panel.
 *
 * Neither type is imported from `@/server/publish-gate` directly, even
 * though this file itself is not a `"use client"` module — `PublishLifecycleErrorCode`
 * comes from `../_actions` (a fresh alias declared there) and
 * `RightsTransitionKind` from `../_types/publish-gate` (a directive-less
 * re-export module — see its header comment for why the type can no
 * longer be re-exported from `../_actions.ts` itself).
 */

function assertUnreachableCode(value: never): never {
  throw new Error(`Unhandled publish lifecycle error code: ${JSON.stringify(value)}`);
}

export function describePublishLifecycleError(code: PublishLifecycleErrorCode): string {
  switch (code) {
    case "article_not_found":
      return "对应的文章不存在，请刷新页面后重试。";
    case "novel_not_found":
      return "该书目不存在或已被删除，请刷新列表后重试。";
    case "novel_not_currently_published":
      return "该书目当前不是「已发布」状态，无法执行下架。";
    case "novel_already_takedown":
      return "该书目已处于「版权/安全移除」状态，无需重复操作。";
    case "novel_not_currently_takedown":
      return "该书目当前不是「已移除」状态，无法执行恢复。";
    case "batch_too_large":
      return "本次选择的书目数超过批量发布上限（200 部），请分批提交。";
    default:
      return assertUnreachableCode(code);
  }
}

/**
 * Fix 1 (Opus review of C-21/22/23): `../../articles/_actions.ts` returns a
 * flat `{ ok: false, code: string }` — not this route's own
 * `PublishActionResult`'s `{ kind: "lifecycle_error", code: ... }`
 * discriminated shape — so `../../articles/_components/article-list.tsx`
 * cannot tell "this code is a `PublishLifecycleErrorCode`" from the type
 * checker alone; it has to ask at runtime before it can safely hand `code`
 * to `describePublishLifecycleError` above (which throws on anything else).
 *
 * Built from a `Record<PublishLifecycleErrorCode, true>` rather than a
 * hand-written array specifically so it stays exhaustive the same way the
 * `switch` above does: adding a seventh member to the union without adding
 * it to `KNOWN_CODES` is a compile error ("Property ... is missing"), not a
 * silently-incomplete runtime guard.
 */
const KNOWN_CODES: Readonly<Record<PublishLifecycleErrorCode, true>> = Object.freeze({
  article_not_found: true,
  novel_not_found: true,
  novel_not_currently_published: true,
  novel_already_takedown: true,
  novel_not_currently_takedown: true,
  batch_too_large: true,
});

export function isPublishLifecycleErrorCode(code: string): code is PublishLifecycleErrorCode {
  return Object.prototype.hasOwnProperty.call(KNOWN_CODES, code);
}

export type RightsTransitionCopy = {
  /** Button / menu-item label. */
  readonly actionLabel: string;
  /** `ConfirmDialog` title. */
  readonly confirmTitle: string;
  /** `ConfirmDialog` confirm button label. */
  readonly confirmLabel: string;
  /** Body copy explaining the consequence — takedown's is a real warning, not boilerplate. */
  readonly warning: string;
  /** Shown after a successful transition. */
  readonly successMessage: string;
};

function assertUnreachableKind(value: never): never {
  throw new Error(`Unhandled rights transition kind: ${JSON.stringify(value)}`);
}

export function describeRightsTransition(kind: RightsTransitionKind): RightsTransitionCopy {
  switch (kind) {
    case "withdraw":
      return {
        actionLabel: "下架",
        confirmTitle: "确认下架该书目？",
        confirmLabel: "下架",
        warning:
          "下架后该书目对外呈现为稳定的 noindex 移除页（HTTP 200，非 404/410），正文与试读内容仍保留在库中不会被删除。此操作不需要重新过发布门禁即可再次发布——原状态被认为是可信的历史记录。",
        successMessage: "已下架，公开页面已转为移除页。",
      };
    case "takedown":
      return {
        actionLabel: "版权/安全移除",
        confirmTitle: "确认对该书目执行版权/安全移除？",
        confirmLabel: "确认移除",
        warning:
          "这是版权或安全层面的强制移除，公开页面将返回 HTTP 410 Gone 并退出索引。更严重的是：该书目下所有非撤回状态的章节会被立即转为「已撤回」，其章节正文数据将被永久删除，不可恢复。请确认已核实版权/安全依据后再继续。",
        successMessage: "已执行版权/安全移除，受影响章节的正文已按流程删除。",
      };
    case "restore":
      return {
        actionLabel: "恢复",
        confirmTitle: "确认恢复该书目？",
        confirmLabel: "恢复",
        warning:
          "恢复只会把书目状态重置为「草稿」，绝不会直接回到「已发布」——P2 V1 冻结了这一点，没有任何豁免机制。恢复后需要重新走一次发布门禁（标题/正文/试读章节/推广链接等检查全部重新生效）才能再次对外发布。",
        successMessage: "已恢复为草稿，需重新发布才能再次公开。",
      };
    default:
      return assertUnreachableKind(kind);
  }
}
