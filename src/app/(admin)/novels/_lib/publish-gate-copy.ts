import {
  PUBLISH_REQUIRED_METADATA_FIELDS,
  type PublishGateReason,
  type PublishRequiredMetadataField,
  type RequiredMetadataMissingDetail,
} from "@/contracts/publish-gate";

/**
 * Operator-facing copy for the P2-01 Hard Gate's rejection reasons (PR-C3).
 *
 * `src/contracts/publish-gate.ts` is frozen and read-only in this PR (see
 * `evaluator.ts`'s own header) — this module only translates its registered
 * `PublishGateReason` values, it never adds, removes or reorders one. The
 * source of truth for "how many reasons exist" is
 * `PUBLISH_GATE_REASONS` in that contract (nine today, including
 * `blocking_sync_exception` — the DTO-hygiene fail-closed convergence for an
 * unregistered/illegal candidate, which `evaluatePublishGate` itself never
 * produces but which the frozen `PublishGateResult` type still has to
 * account for). The exhaustive `switch` + `assertUnreachable` below is what
 * turns "a tenth reason gets added to the contract and this file forgets to
 * translate it" into a build failure instead of a blank line in the
 * rejection panel — same discipline
 * `../../catalog-sync/_lib/outcome-copy.ts` already uses for
 * `CreateContentResult`.
 */

export type PublishGateReasonCopy = {
  readonly label: string;
  readonly guidance: string;
};

function assertUnreachable(value: never): never {
  throw new Error(`Unhandled publish gate reason: ${JSON.stringify(value)}`);
}

const REQUIRED_METADATA_FIELD_LABEL: Readonly<Record<PublishRequiredMetadataField, string>> =
  Object.freeze({
    title: "标题",
    slug: "slug",
    body: "正文",
  });

/** Every field {@link PUBLISH_REQUIRED_METADATA_FIELDS} can ever name — kept exhaustive the same way the reason switch below is. */
export function describeMissingMetadataFields(
  detail: RequiredMetadataMissingDetail | null,
): string | null {
  if (!detail || detail.missingFields.length === 0) return null;
  const ordered = PUBLISH_REQUIRED_METADATA_FIELDS.filter((field) =>
    detail.missingFields.includes(field),
  );
  return `缺失字段：${ordered.map((field) => REQUIRED_METADATA_FIELD_LABEL[field]).join("、")}`;
}

/**
 * One entry per {@link PublishGateReason}. `guidance` always names where an
 * operator should go next — a bare "被拒绝" leaves them guessing which of
 * nine checks failed and what to do about it.
 */
export function describePublishGateReason(reason: PublishGateReason): PublishGateReasonCopy {
  switch (reason) {
    case "locale_not_publishable":
      return {
        label: "语种未开放发布",
        guidance: "该书目的语种不在当前可发布语种白名单内，需要工程确认语种归一配置后才能发布。",
      };
    case "required_metadata_missing":
      return {
        label: "必填字段缺失",
        guidance: "文章的标题、slug 或正文存在空值，需要通过内容生产流程重新生成或人工修正后再试。",
      };
    case "preview_chapter_missing":
      return {
        label: "没有可信试读章节",
        guidance: "该书目还没有物化落地的试读章节，请先到「目录同步」页面触发目录扫描，等待试读章节落地后再发布。",
      };
    case "preview_body_missing":
      return {
        label: "试读章节正文为空",
        guidance: "已有试读章节，但正文尚未落地，请检查该书目最近一次内容同步是否成功完成。",
      };
    case "promo_link_missing":
      return {
        label: "缺少推广链接",
        guidance: "该书目还没有关联推广链接，请先到「目录同步」页面触发目录扫描以绑定推广资源。",
      };
    case "promo_link_not_ready":
      return {
        label: "推广链接未就绪",
        guidance: "推广链接已存在，但尚未拿到可用地址，请等待同步任务重试，或人工核查该推广链接状态。",
      };
    case "page_identity_conflict":
      return {
        label: "页面身份冲突",
        guidance: "同语种下已有另一篇文章占用相同 slug，这是数据异常，请联系工程排查，不要重复尝试发布。",
      };
    case "rights_blocked":
      return {
        label: "处于权利限制状态",
        guidance: "该书目当前处于版权/安全移除状态，请先执行「恢复」，再重新走一次发布。",
      };
    case "blocking_sync_exception":
      return {
        label: "门禁校验异常",
        guidance: "门禁返回了一个未登记的拒绝原因，这是系统异常，请联系工程排查，不要重复尝试发布。",
      };
    default:
      return assertUnreachable(reason);
  }
}
