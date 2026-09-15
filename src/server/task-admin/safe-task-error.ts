export type SafeTaskFailureContext = Readonly<{
  httpStatus?: number;
  pageNumber?: number;
  sqlState?: string;
  prismaCode?: string;
  constraint?: string;
}>;

export type SafeTaskFailureDto = Readonly<{
  code: string;
  label: string;
  context?: SafeTaskFailureContext;
}>;

const SAFE_ERROR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  promo_link_missing: "缺少推广链接",
  promo_link_not_ready: "推广链接未就绪",
  promo_link_deleted: "推广链接已删除/无有效推广链接",
  novel_not_found: "书目不存在",
  novel_deleted: "书目已删除",
  already_exists: "目标记录已存在",
  article_soft_deleted: "已有已删除的 Article",
  missing_locale: "来源语言缺失",
  unsupported_locale: "来源语言暂不受产品支持",
  locale_conflict: "来源语言与现有书目不一致",
  source_item_not_found: "来源条目不存在",
  source_item_deleted: "来源条目已删除",
  source_item_ignored: "来源条目已忽略",
  source_item_stale: "来源条目已过期",
  source_item_inconsistent_state: "来源条目状态不一致",
  slug_unhealthy: "Slug 不符合要求",
  slug_conflict_exhausted: "Slug 冲突重试次数已用尽",
  concurrent_creation_conflict: "书目创建发生并发冲突",
  concurrent_generation_conflict: "文章生成发生并发冲突",
  template_not_available: "没有可用的 ArticleTemplate",
  template_locale_mismatch: "ArticleTemplate 语言不匹配",
  template_render_failed: "ArticleTemplate 渲染失败",
  credential_validation_failed: "凭据校验失败",
  credential_missing: "缺少渠道凭据",
  credential_expired: "渠道凭据已过期",
  credential_ambiguous: "渠道凭据不唯一",
  credential_fingerprint_conflict: "渠道凭据指纹冲突",
  credential_capability_denied: "渠道凭据不具备所需能力",
  account_inactive: "渠道账户未启用",
  feature_disabled: "功能未启用",
  write_disabled: "写入开关未启用",
  task_expired: "任务已过期",
  stale_processing: "任务租约过期且重试次数已用尽",
  upstream_error: "上游服务请求失败",
  upstream_rate_limited: "上游服务限流",
  upstream_page_limit_exceeded: "上游分页结果超过限制",
  upstream_material_read_failed: "上游素材读取失败",
  upstream_preview_read_failed: "上游预览读取失败",
  transport_error: "上游传输失败",
  request_timeout: "上游请求超时",
  upstream_http_error: "上游 HTTP 请求失败",
  malformed_payload: "上游返回数据格式异常",
  claim_readback_title_unavailable: "推广链接回读标题不可用",
  claim_source_fields_missing: "推广链接领取缺少来源字段",
  claim_readback_unavailable: "推广链接回读能力不可用",
  claim_readback_target_missing: "推广链接回读目标不存在",
  claim_readback_ambiguous: "推广链接回读目标不唯一",
  claim_readback_locator_stale: "推广链接回读定位信息已过期",
  claim_readback_target_not_located: "推广链接回读未定位到目标",
  lease_lost_before_claim: "领取推广链接前任务租约已丢失",
  finalize_failed: "任务结果落库失败",
  legacy_template_on_materialize: "书目落库任务不支持 ArticleTemplate",
  legacy_content_create_retired: "旧版内容创建协议已停用",
  dry_run_protected_write_blocked: "演练任务禁止执行受保护写入",
  home_carousel_payload_invalid: "首页轮播任务参数无效",
  sitemap_refresh_failed: "站点地图刷新失败",
  tagging_disabled: "标签功能未启用",
  data_invariant_violation: "数据约束不一致",
  revision_conflict: "标签修订版本冲突",
  idempotency_conflict: "幂等请求冲突",
  tag_not_active: "标签未启用",
  config_not_ready: "标签配置未就绪",
  auto_write_not_authorized: "自动标签写入未授权",
});

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function projectContext(code: string, detailValue: unknown): SafeTaskFailureContext | undefined {
  const detail = plainObject(detailValue);
  if (!detail) return undefined;
  if (code === "upstream_error" || code === "upstream_rate_limited" || code === "upstream_http_error") {
    const httpStatus = safePositiveInteger(detail.httpStatus);
    const pageNumber = safePositiveInteger(detail.pageIndex);
    const context = {
      ...(httpStatus !== undefined && httpStatus <= 599 ? { httpStatus } : {}),
      ...(pageNumber !== undefined ? { pageNumber } : {}),
    };
    return Object.keys(context).length > 0 ? Object.freeze(context) : undefined;
  }
  if (code === "finalize_failed") {
    const sqlState = safeIdentifier(detail.sqlState);
    const prismaCode = safeIdentifier(detail.prismaCode);
    const constraint = safeIdentifier(detail.constraint);
    const context = {
      ...(sqlState ? { sqlState } : {}),
      ...(prismaCode ? { prismaCode } : {}),
      ...(constraint ? { constraint } : {}),
    };
    return Object.keys(context).length > 0 ? Object.freeze(context) : undefined;
  }
  return undefined;
}

/**
 * Projects a persisted task error into the only browser-safe failure shape.
 * Unknown codes and every free-text message are deliberately withheld.
 */
export function projectSafeTaskFailure(error: unknown): SafeTaskFailureDto | undefined {
  const object = plainObject(error);
  const code = object?.code;
  if (typeof code !== "string") return undefined;
  const label = SAFE_ERROR_LABELS[code];
  if (!label) return undefined;
  const context = projectContext(code, object?.detail);
  return Object.freeze({ code, label, ...(context ? { context } : {}) });
}

export function safeTaskFailureText(failure: SafeTaskFailureDto | undefined): string {
  if (!failure) return "系统异常，详情见审计/日志";
  const context = failure.context;
  const parts = context ? [
    context.httpStatus !== undefined ? `HTTP ${context.httpStatus}` : undefined,
    context.pageNumber !== undefined ? `第 ${context.pageNumber} 页` : undefined,
    context.sqlState ? `SQLSTATE ${context.sqlState}` : undefined,
    context.prismaCode ? `Prisma ${context.prismaCode}` : undefined,
    context.constraint ? `约束 ${context.constraint}` : undefined,
  ].filter((value): value is string => value !== undefined) : [];
  return `${failure.label}（${failure.code}）${parts.length > 0 ? ` · ${parts.join(" · ")}` : ""}`;
}
