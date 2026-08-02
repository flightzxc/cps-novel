export const DATABASE_INVARIANTS = {
  localeVersionIdentity: "One source-language version maps to one Novel in V1.",
  canonicalFillOnly: "Ordinary upstream sync may fill an empty canonical field only; it never overwrites a non-empty canonical value.",
  canonicalRefillGate: "After an operator explicitly clears a canonical field, any refill requires an explicit operation; ordinary sync must not infer permission.",
  canonicalLocale: "Novel.locale is a site canonical locale and never unknown; an unmapped source locale cannot create or publish a Novel.",
  splitRatioMetadata: "split_ratio is channel business metadata, never a global admission gate.",
  paidFromChapterMetadata: "paid_from_chapter is metadata and never deletes chapters.",
  previewTruth: "chapterList[] is the authoritative source for preview materialization.",
  permanentPublicCode: "public_redirect_code is globally unique, immutable, and never reused.",
  privateUpstreamCode: "upstream_code never appears in public URLs or tracking records.",
  articlePromoNovelMatch: "Article.promo_link_id and Article.novel_id must reference the same PromoLink novel identity through a composite foreign key.",
  carouselServingSnapshot: "home_carousel_serving contains current rows only; locale and position are absolutely unique, and history belongs in home_carousel_change_log.",
  workerDelivery: "Workers execute at least once; all protected result writes are fenced.",
  leaseFence: "execution_token and lease_epoch must both match before a worker result commits.",
  staleLeaseRejectsWrites: "A stale lease holder cannot commit task results or any protected local business write.",
  intentBoundary: "side_effect_intent commits before an external call in an independent transaction.",
  auditBoundary: "operation_audit commits in the same transaction as the local business write.",
  credentialBoundary: "Web cannot read or decrypt credential ciphertext; Scheduler has no decryption permission.",
  unprovenCapability: "Unproven external contracts remain registered_disabled.",
} as const;

export interface LeaseFence {
  executionToken: string;
  leaseEpoch: bigint;
}

export interface DatabaseReviewState {
  phase: "draft" | "claude_review" | "approved_for_migration";
  reviewer: "Claude";
  reviewedAt: string | null;
}
