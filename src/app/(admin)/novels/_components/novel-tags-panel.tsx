import {
  projectAdminCanonicalTagList,
  projectAdminNovelTags,
  projectErrorEnvelope,
  type AdminCanonicalTagView,
  type AdminCapabilityState,
  type AdminNovelTagsView,
  type AdminResolvedTagView,
  type ErrorEnvelope,
} from "@/contracts";
import { ADMIN_TAG_MAX_PAGE_SIZE, TaggingAdminError } from "@/domain/tagging-admin";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { getAdminNovelTags, listAdminCanonicalTags } from "@/server/tagging/admin-service";

import { prisma } from "../../../api/admin/_lib/deps";
import { TagAuditEntryRow } from "../../tags/_components/tag-audit-log";
import { TaggingDisabledPanel, TaggingWriteDisabledNotice } from "../../tags/_components/tagging-disabled-panel";
import { readTaggingFlagState } from "../../tags/_lib/tagging-flag-checklist";
import { ContentErrorPanel } from "./content-states";
import { NovelTagsEditor } from "./novel-tags-editor";

/**
 * `Panel` in `novel-detail-panels.tsx` is module-private. Following the
 * precedent at `tags/_components/tag-badges.tsx:15`, the class string is
 * copied here rather than imported across that file's ownership boundary.
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

const PROVENANCE_LABEL: Readonly<Record<AdminResolvedTagView["provenance"][number], string>> =
  Object.freeze({
    manual: "人工",
    mapped: "映射",
    auto: "自动",
  });

/**
 * One resolved tag. `provenance` is an array — a tag hit by both the channel
 * mapping and the classifier comes back `["mapped","auto"]` and both labels
 * render, joined by `·`. Taking `provenance[0]` would silently drop the
 * second reason the tag is here.
 */
function TagChip({ tag }: { tag: AdminResolvedTagView }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
      data-testid={`novel-tag-chip-${tag.canonicalTagId}`}
    >
      <span className="break-all">{tag.displayName}</span>
      <span className="shrink-0 text-gray-400">
        （{tag.provenance.map((entry) => PROVENANCE_LABEL[entry]).join("·")}）
      </span>
    </span>
  );
}

function TagChipList({
  tags,
  emptyLabel,
}: {
  tags: readonly AdminResolvedTagView[];
  emptyLabel: string;
}) {
  if (tags.length === 0) return <p className="text-xs text-gray-400">{emptyLabel}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <TagChip key={tag.canonicalTagId} tag={tag} />
      ))}
    </div>
  );
}

/**
 * Read-only tag summary. Exported and pure (no I/O) so it can be unit tested
 * directly against a projected `AdminNovelTagsView` without a database —
 * `NovelTagsPanel` below is the only piece that talks to Prisma.
 *
 * The two modes are deliberately asymmetric in wording, not just in data:
 *
 * - `automatic` + zero tags renders "自动模式 · 0 个标签".
 * - `manual` + zero tags renders "人工接管 · 0 标签" (no "个").
 *
 * "没进入人工模式" and "人工明确设为 0 个标签" must never look the same, and an
 * empty chip area alone would not say which one this is — the header text
 * always does, so the two states differ even with the panel collapsed to one
 * line.
 *
 * `mapped` and `auto` are only ever rendered in automatic mode. In manual
 * mode the backend does not compute those layers at all — it returns empty
 * arrays that mean "not evaluated," not "the channel mapped nothing" — so
 * this component never turns them into "渠道映射 0 个 / 自动分类 0 个"; that
 * would misreport a live channel signal as absent. The manual explanation
 * line takes their place instead.
 */
export function NovelTagsSummary({ tags }: { tags: AdminNovelTagsView }) {
  const isManual = tags.mode === "manual";
  const headerText = isManual
    ? tags.manual.length === 0
      ? "人工接管 · 0 标签"
      : `人工接管 · ${tags.manual.length} 个标签`
    : `自动模式 · ${tags.effective.length} 个标签`;
  const explanation = isManual
    ? "人工接管期间不计算自动结果"
    : "当前为自动模式，标签由渠道映射与自动分类共同得出，会随上游变化。";

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium text-gray-900" data-testid="novel-tags-mode-header">
          {headerText}
        </p>
        <p className="mt-1 text-xs text-gray-500" data-testid="novel-tags-mode-explanation">
          {explanation}
        </p>
      </div>

      <TagChipList tags={isManual ? tags.manual : tags.effective} emptyLabel="无标签" />

      {!isManual && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-gray-500">渠道映射 {tags.mapped.length} 个</h3>
            <TagChipList tags={tags.mapped} emptyLabel="无" />
          </div>
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-gray-500">自动分类 {tags.auto.length} 个</h3>
            <TagChipList tags={tags.auto} emptyLabel="无" />
          </div>
        </div>
      )}

      {/*
        CPS parity (P2-06.5 F1): the last manual-mode mutation, rendered the
        same way as the Canonical Tag / Source Label Mapping change logs.
        This field is independent of the current `mode` — a novel that is
        back in automatic mode after an earlier takeover still carries its
        manual history here, so `null` means "never manually taken over,"
        not "not currently manual."
      */}
      <div className="space-y-1 border-t border-gray-100 pt-3">
        <h3 className="text-xs font-semibold text-gray-500">最近人工变更</h3>
        {tags.lastManualMutation ? (
          <TagAuditEntryRow entry={tags.lastManualMutation} testId="novel-tags-last-manual-mutation" />
        ) : (
          <p className="px-1 text-xs text-gray-400" data-testid="novel-tags-last-manual-mutation-empty">
            从未人工接管
          </p>
        )}
      </div>
    </div>
  );
}

type NovelTagsReadResult =
  | Readonly<{ ok: true; tags: AdminNovelTagsView; canonicalTags: readonly AdminCanonicalTagView[] }>
  | Readonly<{ ok: false; envelope: ErrorEnvelope }>;

/**
 * The V1 taxonomy is bootstrap-frozen at 123 canonical tags
 * (`CANONICAL_TAG_V1_COUNT`) — already past `listAdminCanonicalTags`'s own
 * `ADMIN_TAG_MAX_PAGE_SIZE` (100) cap on a single page. A one-shot
 * `pageSize: 100` fetch would silently hide ~23 tags from the takeover
 * selector, which would quietly break the FULL_SNAPSHOT premise: the
 * operator is choosing from the *complete* active set, not from whichever
 * page happened to load first. So this walks pages instead of trusting one
 * call. It is still just the existing read, invoked more than once — no
 * route, service, or schema change. The page count is capped at 10
 * (1000 tags) purely as a runaway guard; the real ceiling is `totalPages`.
 */
async function listAllActiveCanonicalTags(): Promise<readonly AdminCanonicalTagView[]> {
  const first = projectAdminCanonicalTagList(
    await listAdminCanonicalTags(prisma, { active: "active", pageSize: ADMIN_TAG_MAX_PAGE_SIZE }),
  );
  const items = [...first.items];
  const safeTotalPages = Math.min(first.totalPages, 10);
  for (let page = 2; page <= safeTotalPages; page += 1) {
    const next = projectAdminCanonicalTagList(
      await listAdminCanonicalTags(prisma, {
        active: "active",
        pageSize: ADMIN_TAG_MAX_PAGE_SIZE,
        page,
      }),
    );
    items.push(...next.items);
  }
  return items;
}

/**
 * A well-formed read can still fail: `data_invariant_violation` (409) fires
 * when a novel's upstream sources do not satisfy the resolver's invariants
 * (e.g. more than one live source item). That is a data-health signal, not
 * an operator mistake, so it is rendered through the same error-copy table as
 * every other admin failure rather than swallowed or blamed on the reader.
 */
async function readNovelTags(novelId: string, locale: string): Promise<NovelTagsReadResult> {
  try {
    const [rawTags, canonicalTags] = await Promise.all([
      getAdminNovelTags(prisma, { novelId, locale }),
      listAllActiveCanonicalTags(),
    ]);
    return { ok: true, tags: projectAdminNovelTags(rawTags), canonicalTags };
  } catch (error) {
    if (error instanceof TaggingAdminError) {
      return {
        ok: false,
        envelope: projectErrorEnvelope({ code: error.code, status: error.status }),
      };
    }
    throw error;
  }
}

/**
 * Source labels (`NovelLabelsPanel`) answer "what did the channel say"; this
 * answers "what did we finally decide" — the resolved, deduplicated Canonical
 * Tag set plus the manual-takeover controls. It sits directly below
 * `NovelLabelsPanel` in `[novelId]/page.tsx` for the same reading-order reason.
 *
 * Tags are not part of `AdminNovelDetailView` (see the subtraction table in
 * `admin-content.ts`), so this panel fetches them independently rather than
 * receiving them from the page's `detail` read.
 */
export async function NovelTagsPanel({
  novelId,
  locale,
  capability,
}: {
  novelId: string;
  locale: string;
  capability: AdminCapabilityState;
}) {
  // PR6 fix (lane F): `getAdminNovelTags` throws
  // `TaggingAdminError("tagging_disabled", 403)` the instant
  // `FEATURE_P2_06_5_TAGGING` is off (`requireTaggingRead`). `readNovelTags`
  // below already catches that generically (pre-dates this fix), but this
  // pre-check means the fetch — and `listAllActiveCanonicalTags`'s up-to-10
  // extra page reads alongside it — never happens at all when the flag is
  // off, and renders the same disabled-state panel every other tagging
  // surface now uses instead of the generic error-copy sentence.
  const taggingFlags = readTaggingFlagState();
  if (!taggingFlags.readEnabled) {
    return (
      <Panel title="标签">
        <TaggingDisabledPanel state={taggingFlags} />
      </Panel>
    );
  }
  const result = await readNovelTags(novelId, locale);
  return (
    <Panel title="标签">
      {!result.ok ? (
        <ContentErrorPanel message={errorEnvelopeCopy(result.envelope)} />
      ) : (
        <div className="space-y-4">
          {!taggingFlags.writeEnabled && <TaggingWriteDisabledNotice />}
          <NovelTagsSummary tags={result.tags} />
          <NovelTagsEditor
            novelId={novelId}
            tagsView={result.tags}
            canonicalTags={result.canonicalTags}
            capability={capability}
            writeFlagEnabled={taggingFlags.writeEnabled}
          />
        </div>
      )}
    </Panel>
  );
}
