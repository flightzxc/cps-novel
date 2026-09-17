import type { SiteLocale } from "@/lib/locale/locale-canonical";
import type { TemplateErrorCode } from "@/lib/seo/template";

import type { ContentCreationPreviewEnqueueResult } from "./preview-enqueue";

export type CreateContentActor =
  | { readonly type: "admin"; readonly adminId: string }
  | { readonly type: "system"; readonly source: string };

export type ContentCreationInputErrorCode =
  | "invalid_novel_source_item_id"
  | "invalid_novel_id"
  | "missing_locale"
  | "unsupported_locale"
  | "invalid_actor"
  | "invalid_request_id"
  | "legacy_template_on_materialize"
  | "retired_protocol";

export class ContentCreationInputError extends Error {
  readonly code: ContentCreationInputErrorCode;

  constructor(code: ContentCreationInputErrorCode, message: string) {
    super(message);
    this.name = "ContentCreationInputError";
    this.code = code;
  }
}

export type MaterializedNovelSummary = {
  readonly novelId: string;
  readonly novelBusinessId: string;
  readonly locale: SiteLocale;
  readonly novelSlug: string;
};

export type NovelMaterializePlan = {
  readonly locale: SiteLocale;
  readonly title: string;
  readonly novelSlug: string;
};

export type NovelMaterializeResult =
  | ({ readonly outcome: "created"; readonly previewEnqueue?: ContentCreationPreviewEnqueueResult } & MaterializedNovelSummary)
  | ({ readonly outcome: "already_exists" } & MaterializedNovelSummary)
  | { readonly outcome: "dry_run"; readonly plan: NovelMaterializePlan }
  | { readonly outcome: "source_item_not_found" }
  | { readonly outcome: "source_item_deleted" }
  | { readonly outcome: "source_item_ignored" }
  | { readonly outcome: "source_item_stale" }
  | { readonly outcome: "source_item_inconsistent_state" }
  | {
      readonly outcome: "locale_conflict";
      readonly reason: "source_item_already_linked_to_different_locale";
      readonly existingNovelId: string;
      readonly existingLocale: string;
      readonly derivedLocale: SiteLocale;
    }
  | { readonly outcome: "slug_unhealthy"; readonly field: "novel"; readonly baseSlug: string }
  | { readonly outcome: "slug_conflict_exhausted"; readonly field: "novel"; readonly baseSlug: string }
  | { readonly outcome: "concurrent_creation_conflict" };

export type MaterializeNovelFromSourceItemInput = {
  readonly novelSourceItemId: string;
  readonly mode?: "dry_run" | "apply";
  readonly actor: CreateContentActor;
  readonly requestId: string;
  readonly deferPreviewEnqueue?: boolean;
};

export type GeneratedArticleSummary = {
  readonly articleId: string;
  readonly novelId: string;
  readonly locale: SiteLocale;
  readonly articleSlug: string;
  readonly publicPageShortId: string;
  readonly promoLinkId: string | null;
  readonly templateKey: string | null;
};

export type ArticleGeneratePlan = {
  readonly locale: SiteLocale;
  readonly title: string;
  readonly articleSlug: string;
  readonly provisionalPublicPageShortId: string;
  readonly promoLinkId: string;
  readonly templateKey: string;
};

export type ArticleGenerateResult =
  | ({ readonly outcome: "created" } & GeneratedArticleSummary)
  | ({ readonly outcome: "already_exists" } & GeneratedArticleSummary)
  | { readonly outcome: "dry_run"; readonly plan: ArticleGeneratePlan }
  | { readonly outcome: "novel_not_found" }
  | { readonly outcome: "novel_deleted" }
  | { readonly outcome: "article_soft_deleted"; readonly articleId: string }
  | { readonly outcome: "promo_link_missing" }
  | { readonly outcome: "promo_link_not_ready" }
  | { readonly outcome: "promo_link_deleted" }
  | { readonly outcome: "template_locale_mismatch"; readonly locale: SiteLocale; readonly templateKey?: string }
  | { readonly outcome: "template_not_available"; readonly locale: SiteLocale }
  | { readonly outcome: "slug_unhealthy"; readonly field: "article"; readonly baseSlug: string }
  | { readonly outcome: "slug_conflict_exhausted"; readonly field: "article"; readonly baseSlug: string }
  | { readonly outcome: "concurrent_generation_conflict" }
  | { readonly outcome: "template_render_failed"; readonly code: TemplateErrorCode; readonly slot?: string; readonly constraint?: string };

export type GenerateArticleFromNovelInput = {
  readonly novelId: string;
  readonly templateKey?: string;
  readonly mode?: "dry_run" | "apply";
  readonly actor: CreateContentActor;
  readonly requestId: string;
};

/** @deprecated Coupled Novel+Article DTO. Prefer MaterializedNovelSummary. */
export type CreatedContentSummary = MaterializedNovelSummary;
/** @deprecated Coupled plan. Prefer NovelMaterializePlan. */
export type ContentCreationPlan = NovelMaterializePlan;
/** @deprecated Coupled result. Prefer NovelMaterializeResult. */
export type CreateContentResult = NovelMaterializeResult;
/** @deprecated Prefer MaterializeNovelFromSourceItemInput. */
export type CreateContentFromSourceItemInput = MaterializeNovelFromSourceItemInput;
