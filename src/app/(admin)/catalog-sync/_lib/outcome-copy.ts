import type { ContentCreationActionResult } from "../_actions";

/**
 * Derived structurally from the action's own return type rather than
 * importing the server DTO from `@/server/content-creation` directly.
 */
export type CreateContentResult = Extract<ContentCreationActionResult, { ok: true }>["data"];
export type ContentCreationPlan = Extract<CreateContentResult, { outcome: "dry_run" }>["plan"];
export type CreatedContentSummary = Extract<
  CreateContentResult,
  { outcome: "created" | "already_exists" }
>;

export type OutcomeTone = "success" | "info" | "warning" | "danger";
export type OutcomeCopy = { readonly tone: OutcomeTone; readonly title: string; readonly body: string };

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled novel-materialize outcome: ${JSON.stringify(value)}`);
}

export function describeCreateContentOutcome(result: CreateContentResult): OutcomeCopy {
  switch (result.outcome) {
    case "created":
      return {
        tone: "success",
        title: "已纳入书目",
        body: `已创建书目「${result.novelBusinessId}」，来源条目已关联并转入 linked。尚未创建文章。`,
      };
    case "already_exists":
      return {
        tone: "info",
        title: "该来源条目已纳入书目",
        body: "本次未重复写入——以下是此前已关联的书目。没有 Article 是正常阶段。",
      };
    case "dry_run":
      return {
        tone: "info",
        title: "纳入计划已生成",
        body: "尚未写入任何数据，请核对下方字段后再确认纳入书目。此步骤不会创建文章。",
      };
    case "source_item_not_found":
      return {
        tone: "danger",
        title: "来源条目不存在",
        body: "可能已被删除，请刷新列表后重试。",
      };
    case "source_item_deleted":
      return {
        tone: "danger",
        title: "来源条目已被删除",
        body: "该来源条目已被软删除，无法纳入书目。",
      };
    case "source_item_ignored":
      return {
        tone: "warning",
        title: "该来源条目已被标记为忽略",
        body: "运营已将其排除在纳入范围之外；如确需纳入，请先在来源侧取消忽略后重试。",
      };
    case "source_item_stale":
      return {
        tone: "warning",
        title: "该来源条目已过期",
        body: "上游最近一次可信响应未再返回该条目，暂不建议纳入书目；待其重新出现后再试。",
      };
    case "source_item_inconsistent_state":
      return {
        tone: "danger",
        title: "来源条目状态异常",
        body: "该条目的关联状态与预期不符（例如已标记关联却找不到对应书目），需要人工核查数据，请联系工程排查。",
      };
    case "locale_conflict":
      return {
        tone: "danger",
        title: "语种冲突",
        body: `该来源条目已关联到语种为「${result.existingLocale}」的书目（novelId: ${result.existingNovelId}），与本次识别出的语种「${result.derivedLocale}」不一致，已拒绝纳入。`,
      };
    case "slug_unhealthy":
      return {
        tone: "danger",
        title: "标题无法生成合规 slug",
        body: `书目 slug 生成失败（基础 slug：${result.baseSlug}），需要人工修正来源标题后重试。`,
      };
    case "slug_conflict_exhausted":
      return {
        tone: "danger",
        title: "slug 冲突次数超过上限",
        body: `书目 slug（基础：${result.baseSlug}）尝试 200 个候选后仍冲突，需要人工处理。`,
      };
    case "concurrent_creation_conflict":
      return {
        tone: "warning",
        title: "纳入时发生并发冲突",
        body: "另一次请求同时在处理该来源条目，本次已让步；重新点击可重试，重试会命中已纳入的结果。",
      };
    default:
      return assertUnreachable(result);
  }
}
