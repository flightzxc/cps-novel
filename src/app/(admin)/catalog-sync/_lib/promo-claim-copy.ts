/** Operator-facing reason labels only. Detailed task diagnostics stay in `/tasks`. */
export function skipReasonLabel(reason: string): string {
  return ({
    source_not_linked: "来源条目尚未关联书目",
    item_already_active_elsewhere: "该来源条目已有进行中的领取任务",
    source_unlinked_or_deleted: "来源条目已删除或失去关联",
  } as Readonly<Record<string, string>>)[reason] ?? "不符合领取条件";
}
