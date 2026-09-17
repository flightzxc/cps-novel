/**
 * Retired coupled protocol (`content.create.v1` / parent `content_create`).
 *
 * Kept as recognition constants only: old tasks must remain readable and
 * consumable so they can terminate as `failed` instead of sitting pending
 * forever. Handlers must not convert these into Novel-only materialize or
 * retry them.
 */
export const LEGACY_CONTENT_CREATE_TASK_TYPE = "content.create.v1";
export const LEGACY_CONTENT_CREATE_OPERATION = "content_create";
export const LEGACY_CONTENT_CREATE_RETIRED_CODE = "legacy_content_create_retired";
export const LEGACY_CONTENT_CREATE_RETIRED_MESSAGE =
  "content.create.v1 / content_create 已退役。请按新流程重新提交：先纳入书目（novel.materialize.v1 / novel_materialize），再在有就绪推广链接后显式创建文章（article.generate.v1）。";
