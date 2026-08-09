import type { LabelKind } from "@/domain/database-statuses";
import { LABEL_KIND_BADGES } from "@/features/admin-ui/content-view";

/**
 * Same pill geometry as `novels/_components/content-badges.tsx`'s `NovelStatusBadge`
 * — `rounded-full px-2 py-0.5 text-xs font-medium` — so a badge reads the same on
 * this screen as on `/novels`.
 *
 * The class string is duplicated rather than imported: `content-badges.tsx`
 * belongs to the `/novels` slice's file ownership, and its `PILL` constant is
 * module-private (not exported) by that file's own design. Copying the literal
 * value is the reuse this screen can actually do without reaching across an
 * ownership boundary that is not this screen's to cross.
 */
const PILL = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium";

export function LabelKindBadge({ kind }: { kind: LabelKind }) {
  const badge = LABEL_KIND_BADGES[kind];
  return (
    <span className={`${PILL} ${badge.color}`} data-testid={`label-kind-${kind}`}>
      {badge.label}
    </span>
  );
}
