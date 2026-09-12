import type { ContentCreationActionResult } from "../_actions";

/**
 * Derived structurally from the action's own return type rather than
 * importing `CreateContentResult` from `@/server/content-creation` directly.
 * Both are type-only, so either would erase at build time either way — this
 * form just means the client-facing files in this route never name a
 * `src/server/**` module at all, not even in a type position, which keeps the
 * boundary obviously clean rather than merely safe-in-practice.
 */
export type CreateContentResult = Extract<ContentCreationActionResult, { ok: true }>["data"];
export type ContentCreationPlan = Extract<CreateContentResult, { outcome: "dry_run" }>["plan"];
export type CreatedContentSummary = Extract<
  CreateContentResult,
  { outcome: "created" | "already_exists" }
>;

export type OutcomeTone = "success" | "info" | "warning" | "danger";
export type OutcomeCopy = { readonly tone: OutcomeTone; readonly title: string; readonly body: string };

const FIELD_LABEL: Readonly<Record<"novel" | "article", string>> = {
  novel: "书目",
  article: "文章",
};

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled content-creation outcome: ${JSON.stringify(value)}`);
}

/**
 * One entry per {@link CreateContentResult} outcome — the requirement (P0-S13
 * task brief) is that no classification the service can return is silently
 * swallowed. The `default` branch's `assertUnreachable` turns "a new outcome
 * was added to the service and this file was not updated" into a build
 * failure instead of a blank dialog.
 */
export function describeCreateContentOutcome(result: CreateContentResult): OutcomeCopy {
  switch (result.outcome) {
    case "created":
      return {
        tone: "success",
        title: "创建成功",
        body: `已创建书目「${result.novelBusinessId}」与同语种文章，来源条目已关联并转入 linked。`,
      };
    case "already_exists":
      return {
        tone: "info",
        title: "该来源条目已创建过内容",
        body: "本次未重复写入——以下是此前已创建的书目与文章。",
      };
    case "dry_run":
      return {
        tone: "info",
        title: "创建计划已生成",
        body: "尚未写入任何数据，请核对下方字段后再确认创建。",
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
        body: "该来源条目已被软删除，无法创建内容。",
      };
    case "source_item_ignored":
      return {
        tone: "warning",
        title: "该来源条目已被标记为忽略",
        body: "运营已将其排除在创建范围之外；如确需创建，请先在来源侧取消忽略后重试。",
      };
    case "source_item_stale":
      return {
        tone: "warning",
        title: "该来源条目已过期",
        body: "上游最近一次可信响应未再返回该条目，暂不建议创建内容；待其重新出现后再试。",
      };
    case "template_locale_mismatch":
      return {
        tone: "danger",
        title: "没有匹配语种的可用模板",
        body: result.templateKey
          ? `模板「${result.templateKey}」不存在、未启用，或语种与本次创建的语种「${result.locale}」不一致，本次未创建内容。`
          : `语种「${result.locale}」没有可用模板，本次未创建内容。`,
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
        body: `该来源条目已关联到语种为「${result.existingLocale}」的书目（novelId: ${result.existingNovelId}），与本次识别出的语种「${result.derivedLocale}」不一致，已拒绝创建。`,
      };
    case "slug_unhealthy":
      return {
        tone: "danger",
        title: "标题无法生成合规 slug",
        body: `${FIELD_LABEL[result.field]} slug 生成失败（基础 slug：${result.baseSlug}），需要人工修正来源标题后重试。`,
      };
    case "slug_conflict_exhausted":
      return {
        tone: "danger",
        title: "slug 冲突次数超过上限",
        body: `${FIELD_LABEL[result.field]} slug（基础：${result.baseSlug}）尝试 200 个候选后仍冲突，需要人工处理。`,
      };
    case "concurrent_creation_conflict":
      return {
        tone: "warning",
        title: "创建时发生并发冲突",
        body: "另一次请求同时在处理该来源条目，本次已让步；重新点击可重试，重试会命中已创建的结果。",
      };
    case "template_render_failed": {
      const parts = [`code: ${result.code}`];
      if (result.slot) parts.push(`slot: ${result.slot}`);
      if (result.constraint) parts.push(`constraint: ${result.constraint}`);
      return {
        tone: "danger",
        title: "内容模板渲染失败",
        body: `${parts.join("，")}；本次写入已回滚，请联系工程排查。`,
      };
    }
    default:
      return assertUnreachable(result);
  }
}
