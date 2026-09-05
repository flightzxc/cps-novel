import {
  TAGGING_ADMIN_WRITE_FEATURE_FLAG,
  TAGGING_MASTER_FEATURE_FLAG,
  isTagAdminWriteEnabled,
  isTaggingEnabled,
} from "@/lib/flags";

/**
 * PR6 fix (lane F): `/categories`, `/tags/canonical`, `/tags/mappings` and
 * the novel-detail tag panel all read through
 * `src/server/tagging/admin-service.ts`, whose `requireTaggingRead` throws
 * `TaggingAdminError("tagging_disabled", 403)` the moment
 * `FEATURE_P2_06_5_TAGGING` is off -- until this fix, that reached the page
 * with no pre-check, so nothing before this handled the case where lane F's
 * own docker-compose/X8-levels wiring had the flag off (or hadn't shipped
 * yet): the Server Component render threw, and the nearest error boundary
 * showed a generic failure. This module lets each page pre-check the flag
 * state itself and render `TaggingDisabledPanel` (see the sibling
 * `_components/tagging-disabled-panel.tsx`) instead of ever calling into the
 * tagging service in the first place.
 *
 * Read state and write state are independent: `readEnabled` gates whether a
 * page can even be shown; `writeEnabled` (checked in addition, never in
 * isolation -- write always implies read is also required, per
 * `requireTaggingMutation`'s own `requireTaggingRead(env); ...` order) gates
 * whether the write UI already rendered on that page may submit at all.
 */
export type TaggingFlagState = {
  readonly readEnabled: boolean;
  readonly writeEnabled: boolean;
};

export function readTaggingFlagState(env: NodeJS.ProcessEnv = process.env): TaggingFlagState {
  return {
    readEnabled: isTaggingEnabled(env),
    writeEnabled: isTagAdminWriteEnabled(env),
  };
}

export type TaggingFlagRow = {
  readonly envName: string;
  readonly on: boolean;
  readonly note: string;
};

/**
 * One row per flag, always both -- same "one row per gating flag, always
 * both" discipline as `catalogScanFlagChecklist`
 * (`catalog-sync/_lib/scan-task-copy.ts`), and for the same reason: an
 * operator staring at a disabled page needs to see every lever, not just the
 * one that happens to be off right now.
 */
export function taggingFlagChecklist(state: TaggingFlagState): readonly TaggingFlagRow[] {
  return [
    {
      envName: TAGGING_MASTER_FEATURE_FLAG,
      on: state.readEnabled,
      note: "总闸：未开启则 Canonical Tag / 来源映射 / 小说标签读取全部禁用（来源标签字典 /tags 不受影响，它走另一条只读服务）。",
    },
    {
      envName: TAGGING_ADMIN_WRITE_FEATURE_FLAG,
      on: state.writeEnabled,
      note: "写闸：仅控制后台人工编辑（状态、译名、别名、映射、人工接管）；未开启时即便总闸打开也只能只读查看。",
    },
  ];
}
