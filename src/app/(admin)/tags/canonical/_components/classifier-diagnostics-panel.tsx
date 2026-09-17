import { CopyButton } from "@/components/ui/copy-button";
import { StatusBadge, type BadgeTone } from "@/components/ui/status-badge";
import type { AdminTagAuthorityView } from "@/contracts";

/**
 * `Panel` / `Field` are copied verbatim from
 * `novels/_components/novel-detail-panels.tsx` rather than imported: that
 * module belongs to the `/novels` slice's file ownership and its helpers are
 * module-private (not exported) by that file's own design. Copying the class
 * strings is the same reuse `tags/_components/tag-badges.tsx` already does for
 * `content-badges.tsx`'s `PILL` — see that file's doc comment for the
 * precedent this follows.
 */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-900">
        {title}
      </h2>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-3 py-1.5 text-sm">
      <dt className="w-40 shrink-0 text-gray-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-gray-900">{children}</dd>
    </div>
  );
}

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = Object.freeze({
  READY: "success",
  FROZEN: "success",
  INCOMPLETE: "warning",
  OWNER_REVIEW_PENDING: "warning",
});

function toneFor(status: string): BadgeTone {
  return STATUS_TONE[status] ?? "neutral";
}

function numberOrDash(value: number | null): React.ReactNode {
  return value === null ? <span className="text-gray-400">—</span> : value;
}

function shaField(value: string): React.ReactNode {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      <CopyButton value={value} />
    </span>
  );
}

/**
 * Read-only authority notice, not a settings panel — zero input controls
 * anywhere in this component, on purpose. Every value here is frozen
 * elsewhere (classifier weights by Lane C Final, the keyword eligibility
 * overlay and the Canonical Tag V1 taxonomy by their own owning artifacts);
 * this panel exists so an operator editing a tag above can see, without
 * leaving the page, whether the authority backing that edit is actually
 * complete.
 */
export function ClassifierDiagnosticsPanel({ authority }: { authority: AdminTagAuthorityView }) {
  const { classifier, keywords, taxonomy } = authority;
  const countMismatch = taxonomy.canonicalV1Count !== taxonomy.databaseActiveCount;

  return (
    <div className="space-y-3" data-testid="classifier-diagnostics">
      <h2 className="text-sm font-semibold text-gray-900">Classifier 授权诊断（只读）</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <Panel title="Classifier">
          <dl>
            <Field label="状态">
              <StatusBadge tone={toneFor(classifier.status)}>{classifier.status}</StatusBadge>
            </Field>
            <Field label="版本">{classifier.version}</Field>
            <Field label="titleWeight">{numberOrDash(classifier.titleWeight)}</Field>
            <Field label="descriptionWeight">{numberOrDash(classifier.descriptionWeight)}</Field>
            <Field label="threshold">{numberOrDash(classifier.threshold)}</Field>
            <Field label="maxTextTags">{numberOrDash(classifier.maxTextTags)}</Field>
          </dl>
        </Panel>

        <Panel title="Keyword 授权">
          <dl>
            <Field label="状态">
              <StatusBadge tone={toneFor(keywords.status)}>{keywords.status}</StatusBadge>
            </Field>
            <Field label="eligibility 版本">{keywords.keywordEligibilityVersion}</Field>
            <Field label="eligibility SHA256">{shaField(keywords.keywordEligibilitySha256)}</Field>
            <Field label="启用 keyword 数">{keywords.activeKeywordCount}</Field>
            <Field label="lexicon 版本">
              {keywords.versions.length > 0 ? keywords.versions.join(", ") : <span className="text-gray-400">—</span>}
            </Field>
          </dl>
        </Panel>

        <Panel title="分类体系">
          <dl>
            <Field label="状态">
              <StatusBadge tone={toneFor(taxonomy.status)}>{taxonomy.status}</StatusBadge>
            </Field>
            <Field label="V1 登记数">{taxonomy.canonicalV1Count}</Field>
            <Field label="数据库启用数">
              <span className="flex flex-wrap items-center gap-2">
                {taxonomy.databaseActiveCount}
                {countMismatch && (
                  <span
                    data-testid="taxonomy-count-mismatch"
                    className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800"
                  >
                    与登记数量不符
                  </span>
                )}
              </span>
            </Field>
            <Field label="V1 SHA256">{shaField(taxonomy.canonicalV1Sha256)}</Field>
            <Field label="版本">
              {taxonomy.versions.length > 0 ? taxonomy.versions.join(", ") : <span className="text-gray-400">—</span>}
            </Field>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
