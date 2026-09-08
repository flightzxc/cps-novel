"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyRow, TBody, TD, TH, THead, Table } from "@/components/ui/table";
import type { ArticleContentMode, ArticleSeoVisibility, ArticleStatus, ArticleType } from "@/domain/database-statuses";
import { formatDateTime } from "@/features/admin-ui/content-view";
import { buildArticlePath } from "@/lib/slug/article-path";

import { MAX_BATCH_PUBLISH_SELECTION } from "../../novels/_lib/batch-publish-constants";
import { describePublishGateReason } from "../../novels/_lib/publish-gate-copy";
import { describePublishLifecycleError, isPublishLifecycleErrorCode } from "../../novels/_lib/publish-outcome-copy";
import { validateReason } from "../../novels/_lib/reason-guard";
import {
  publishArticleAction,
  publishArticlesBatchAction,
  regenerateArticleAction,
  regenerateArticlesBatchAction,
  withdrawArticleAction,
} from "../_actions";
import { ArticleContentModeBadge } from "./article-content-mode-badge";
import { ArticleSeoVisibilityBadge } from "./article-seo-visibility-badge";
import { ArticleStatusBadge } from "./article-status-badge";
import { ArticleTypeBadge } from "./article-type-badge";

/**
 * Fix 1 (Opus review of C-21/22/23): `../_actions.ts`'s write actions return
 * a flat `{ ok: false, code: string }` — `code` may be a
 * `PublishLifecycleErrorCode` (`novel_not_found`, `batch_too_large`, …,
 * forwarded verbatim by that file's `writeErrorCode`) or an opaque code this
 * component has no Chinese copy for (`article_conflict`, the `*_failed`
 * fallbacks — see that file's own doc comment on `writeErrorCode`). Only the
 * former has a translation (`describePublishLifecycleError`); anything else
 * still renders as the raw code, exactly as before this fix, because that is
 * genuinely all there is to show for it.
 */
function describeArticleActionErrorCode(code: string): string {
  return isPublishLifecycleErrorCode(code) ? describePublishLifecycleError(code) : code;
}

export type ArticleListRow = {
  id: string;
  title: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
  status: string;
  summary: string | null;
  templateKey: string | null;
  updatedAt: string;
  // C-20 additions — see `@/server/articles`'s `ArticleListItem` for why
  // these are optional (additive contract discipline) despite `novel` and
  // `createdAt` always being present in practice.
  createdAt?: string;
  templateName?: string | null;
  novel?: { id: string; title: string };
  canonicalTags?: readonly string[];
  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * `Article.seoVisibility`, for the "SEO 可见性" badge column. Optional per
   * this round's additive-contract discipline, same as the C-20 fields
   * above — falls back to `"public"` at render time (`./article-seo-visibility-badge.tsx`'s
   * caller below) for any row a caller built without it.
   */
  seoVisibility?: string;
  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * `Article.articleType`/`Article.contentMode`, for the "类型"/"内容模式"
   * badge columns. Optional per this round's additive-contract discipline,
   * same as `seoVisibility` above — each falls back at render time
   * (`./article-type-badge.tsx`/`./article-content-mode-badge.tsx`'s callers
   * below) to the same value `Article.articleType`/`Article.contentMode`'s
   * own DB column defaults to (`"novel_article"`/`"template"`, C-24) for any
   * row a caller built without it.
   */
  articleType?: string;
  contentMode?: string;
};

/**
 * RC-9 admin-host isolation (2026-09-03, Owner): the admin console is served
 * from `ADMIN_CANONICAL_ORIGIN` (e.g. `https://zbcwf.novel.test`), and both
 * `src/proxy.ts` and that host's nginx server block return 404 for every
 * public content path — see `evaluateAdminHostAccess`'s rule table in
 * `@/lib/site/admin-origin`. A site-relative `buildArticlePath` href therefore
 * resolves against the admin origin and 404s, so the public origin has to be
 * spelled out. It is resolved server-side from `SITE_URL` in `../page.tsx`
 * (`process.env.SITE_URL` is not in the client bundle) and threaded down as a
 * prop.
 *
 * `publicOrigin` is `null` only when `SITE_URL` is unset or malformed. The
 * relative fallback then reproduces the pre-RC-9 href, which still works in
 * the dev same-origin branch of the rule table and is no worse than today's
 * link anywhere else — a misconfigured `SITE_URL` must not blank out the
 * whole list.
 */
function publicArticlePath(row: ArticleListRow): string {
  return buildArticlePath({ locale: row.locale as "en", slug: row.slug, shortId: row.publicPageShortId });
}

function publicPageHref(publicOrigin: string | null, row: ArticleListRow): string {
  const path = publicArticlePath(row);
  return publicOrigin ? `${publicOrigin}${path}` : path;
}

/**
 * C-20 (`分析_文章管理Parity缺口_2026-09-08.md` §六, item #20): 前台 URL
 * column. CPS renders this column regardless of status (drafts can be
 * previewed too), so the old `row.status === "published"` gate on the "公开页"
 * link is gone — every row now shows the relative path, an "打开" link, and a
 * copy button.
 *
 * The copy button copies the same value the "打开" link points at
 * (`publicPageHref`) — the *absolute* URL against `publicOrigin` when
 * `SITE_URL` resolved, degrading to the site-relative path otherwise. That
 * degradation is C-18/RC-9's own established fallback (see the header above),
 * carried over here rather than re-decided: a misconfigured `SITE_URL` must
 * not blank out the copy button any more than it blanks out the open link.
 */
function ArticleUrlCell({ row, publicOrigin }: { row: ArticleListRow; publicOrigin: string | null }) {
  const href = publicPageHref(publicOrigin, row);
  return (
    <div className="space-y-1.5">
      <p className="break-all text-xs text-gray-600" data-testid={`article-url-path-${row.id}`}>
        {publicArticlePath(row)}
      </p>
      <div className="flex gap-1.5">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={buttonClassName("secondary", "px-2 py-1 text-xs")}
        >
          打开
        </a>
        <CopyButton value={href} />
      </div>
    </div>
  );
}

export function ArticleList({
  rows,
  canWrite,
  publicOrigin,
}: {
  rows: readonly ArticleListRow[];
  canWrite: boolean;
  publicOrigin: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<{ articleId: string; novelId: string; title: string } | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawReasonError, setWithdrawReasonError] = useState<string | null>(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  function toggleAll() {
    setSelected((current) => {
      const next = new Set(current);
      const allVisible = rows.length > 0 && rows.every((r) => next.has(r.id));
      if (allVisible) {
        rows.forEach((r) => next.delete(r.id));
      } else {
        rows.forEach((r) => next.add(r.id));
      }
      return next;
    });
  }
  async function batch() {
    const result = await regenerateArticlesBatchAction({ requestId: crypto.randomUUID(), articleIds: [...selected] });
    setMessage(
      result.ok
        ? `再生成完成：成功 ${result.data.counts.regenerated}，跳过 ${result.data.counts.skipped}，失败 ${result.data.counts.failed}，未处理 ${result.data.counts.not_processed}`
        : result.code,
    );
    if (result.ok) {
      setSelected(new Set());
      router.refresh();
    }
  }

  /**
   * C-21 row-level "发布" (analysis doc item #24). `publishArticleAsAdmin`
   * never throws for a gate rejection/conflict/not-found — those come back as
   * `data.outcome`, exactly like the existing "再生成" button's `conflict`
   * branch above already handles — so only a genuinely unexpected failure
   * (auth, network) hits the `!result.ok` branch.
   */
  async function handlePublish(row: ArticleListRow) {
    const result = await publishArticleAction({ requestId: crypto.randomUUID(), articleId: row.id });
    if (!result.ok) {
      setMessage(`发布失败：${describeArticleActionErrorCode(result.code)}`);
      return;
    }
    const { data } = result;
    if (data.outcome === "published") {
      setMessage(data.firstPublish ? "已发布（首次公开）" : "已发布");
      router.refresh();
      return;
    }
    if (data.outcome === "conflict") {
      setMessage("检测到并发修改，发布已安全放弃、未写入，可重试。");
      return;
    }
    if (data.outcome === "not_found") {
      setMessage("对应文章不存在，请刷新页面后重试。");
      return;
    }
    // rejected — reuse the novel-detail lifecycle panel's own gate-reason copy
    // (`../../novels/_lib/publish-gate-copy.ts`) rather than showing the raw
    // `PublishGateReason` identifiers.
    const labels = data.gate.reasons.map((reason) => describePublishGateReason(reason).label);
    setMessage(`未通过发布门禁：${labels.join("、")}`);
  }

  /**
   * C-21 row-level "下线" (analysis doc item #25 — "隐藏"=下线, not SEO
   * visibility; §零 correction). Only offered when the row still carries its
   * `novel` relation (C-20; always true in practice, `novelId` is `NOT
   * NULL`) — `withdrawArticleAction` is Novel-keyed (see that action's own
   * doc comment for why).
   */
  function openWithdraw(row: ArticleListRow) {
    if (!row.novel) return;
    setWithdrawReasonError(null);
    setWithdrawReason("");
    setWithdrawTarget({ articleId: row.id, novelId: row.novel.id, title: row.title });
  }

  /**
   * Same "reject blank reason before ever calling the Server Action" shape
   * as `../../novels/_components/publish-lifecycle-panel.tsx`'s
   * `runRightsTransition` — the doc's own UI test ("下线在未填理由时不提交")
   * is this branch: the dialog stays open and shows `withdrawReasonError`
   * instead of firing `withdrawArticleAction`.
   *
   * Fix 3 (Opus review of C-21/22/23): the blank-reason guard used to be the
   * only check here — an over-1000-char reason sailed through to
   * `withdrawArticleAction`, where `withdrawNovel`'s own `trimmedReason`
   * throws a bare `Error("Reason is too long")` that `writeErrorCode`
   * (`../_actions.ts`) can only fold into the generic `article_withdraw_failed`
   * fallback, same as `tests/ui/articles-actions.test.ts`'s "空理由…折叠为
   * article_withdraw_failed" test already pins for the blank case. Now both
   * conditions are checked client-side via `../../novels/_lib/reason-guard.ts`'s
   * `validateReason` — the same function `../../novels/_actions.ts`'s
   * `requireNonBlankReason` wraps for the novel-detail rights-transition
   * dialogs — before this component ever calls the Server Action.
   */
  async function confirmWithdraw() {
    if (!withdrawTarget) return;
    const validation = validateReason(withdrawReason);
    if (!validation.ok) {
      setWithdrawReasonError(
        validation.code === "reason_too_long"
          ? "下线原因过长，请控制在 1000 字以内。"
          : "请填写下线原因后再提交（会写入审计记录）。",
      );
      return;
    }
    setWithdrawReasonError(null);
    setWithdrawBusy(true);
    const result = await withdrawArticleAction({
      requestId: crypto.randomUUID(),
      novelId: withdrawTarget.novelId,
      reason: validation.reason,
    });
    setWithdrawBusy(false);
    setWithdrawTarget(null);
    setWithdrawReason("");
    if (!result.ok) {
      setMessage(`下线失败：${describeArticleActionErrorCode(result.code)}`);
      return;
    }
    setMessage(`已下线，受影响文章数：${result.data.affectedArticleIds.length}`);
    router.refresh();
  }

  /**
   * C-21 list-level "批量发布" (analysis doc item #28). Article-keyed
   * directly from `selected` — no novelId resolution needed, unlike
   * `../../novels/_components/novels-batch-publish.tsx`'s
   * `publishNovelsBatchAction`, since this list's checkboxes already are
   * article ids.
   */
  async function batchPublish() {
    const result = await publishArticlesBatchAction({ requestId: crypto.randomUUID(), articleIds: [...selected] });
    if (!result.ok) {
      setMessage(`批量发布失败：${describeArticleActionErrorCode(result.code)}`);
      return;
    }
    let published = 0;
    let rejected = 0;
    let conflict = 0;
    let notFound = 0;
    for (const { result: outcome } of result.data.results) {
      if (outcome.outcome === "published") published += 1;
      else if (outcome.outcome === "rejected") rejected += 1;
      else if (outcome.outcome === "conflict") conflict += 1;
      else if (outcome.outcome === "not_found") notFound += 1;
    }
    setMessage(`批量发布完成：成功 ${published}，拒绝 ${rejected}，冲突 ${conflict}，不存在 ${notFound}`);
    setSelected(new Set());
    router.refresh();
  }

  const overPublishCap = selected.size > MAX_BATCH_PUBLISH_SELECTION;

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * "批量再生成按钮旁增加一行提示：当选中项里含有'手动编辑'的文章时，明确
   * 提示'其中 N 篇为手动编辑，再生成会覆盖运营正文'". `contentMode` falls
   * back to `"template"` (the column's own DB default, C-24) for the same
   * reason the badge cell below does — a row built without the field must
   * read as "not manual", not silently count toward this warning.
   */
  const manualSelectedCount = rows.filter(
    (row) => selected.has(row.id) && (row.contentMode ?? "template") === "manual",
  ).length;

  /**
   * C-28: the same warning shape as `manualSelectedCount` above, for the
   * other reason a selected row can never actually regenerate — no Novel to
   * render template values from (`article_not_regenerable`,
   * `src/server/articles/service.ts`). Informational only, not blocking: a
   * mixed selection is still allowed (the per-row disabled state above is
   * the hard stop), same posture the manual-edit warning already takes.
   */
  const blogSelectedCount = rows.filter(
    (row) => selected.has(row.id) && (row.articleType ?? "novel_article") !== "novel_article",
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
          Fix 5 (Opus review of C-21/22/23): this single count used to render
          as "已选择 N / 50" — a denominator that only ever named the
          re-generate cap, sitting above two buttons with two *different*
          caps (50 for 批量再生成, 200 for 批量发布 — `MAX_BATCH_PUBLISH_SELECTION`
          below). An operator selecting, say, 120 rows would read "/ 50" here
          and have no way to tell whether that number describes the button
          they are about to click. Each cap now sits next to its own button
          instead.
        */}
        <p className="text-sm text-gray-600">已选择 {selected.size}</p>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <button
              disabled={!canWrite || selected.size === 0 || overPublishCap}
              className={buttonClassName("primary")}
              onClick={() => void batchPublish()}
              data-testid="articles-batch-publish"
            >
              批量发布
            </button>
            <span className="text-xs text-gray-500">/ {MAX_BATCH_PUBLISH_SELECTION}</span>
            {overPublishCap && (
              <span className="text-xs text-red-600">
                超过批量发布上限（{MAX_BATCH_PUBLISH_SELECTION} 篇），请减少选择后再提交
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              disabled={!canWrite || selected.size === 0 || selected.size > 50}
              className={buttonClassName("primary")}
              onClick={() => void batch()}
            >
              批量再生成
            </button>
            <span className="text-xs text-gray-500">/ 50</span>
            {/* C-22 (`分析_文章管理Parity缺口_2026-09-08.md` §六): the "50 条/25
                秒预算" note used to live in the page header's description —
                moved here, next to the button it actually describes. */}
            <span className="text-xs text-gray-500">50 条/25 秒预算</span>
            {manualSelectedCount > 0 && (
              <span className="text-xs text-amber-700" data-testid="articles-batch-regenerate-manual-warning">
                其中 {manualSelectedCount} 篇为手动编辑，再生成会覆盖运营正文
              </span>
            )}
            {blogSelectedCount > 0 && (
              <span className="text-xs text-amber-700" data-testid="articles-batch-regenerate-blog-warning">
                其中 {blogSelectedCount} 篇为博客文章，没有绑定模板，再生成会失败
              </span>
            )}
          </div>
        </div>
      </div>
      {message && (
        <p role="status" className="rounded border bg-gray-50 p-3 text-sm">
          {message}
        </p>
      )}
      <Table>
        <THead>
          <tr>
            <TH>
              <input
                type="checkbox"
                aria-label="选择当前页"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && !allSelected;
                }}
                onChange={toggleAll}
              />
            </TH>
            <TH>标题</TH>
            <TH>书目</TH>
            <TH>模板</TH>
            <TH>分类</TH>
            {/*
              C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md`
              §三/C-26): "类型"/"内容模式" badge columns — CPS itself never
              renders either as a list column (only its filter dropdowns), so
              this pair is a display increment specific to this repo (per the
              plan's "这一处是超出 CPS 的展示增量" note), placed next to the
              existing 状态/SEO 可见性 badge columns.
            */}
            <TH>类型</TH>
            <TH>内容模式</TH>
            <TH>状态</TH>
            <TH>SEO 可见性</TH>
            <TH>前台 URL</TH>
            <TH>创建时间</TH>
            <TH>操作</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => (
            <tr key={row.id}>
              <TD>
                <input
                  type="checkbox"
                  aria-label={`选择 ${row.title}`}
                  checked={selected.has(row.id)}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(row.id)) next.delete(row.id);
                      else next.add(row.id);
                      return next;
                    })
                  }
                />
              </TD>
              <TD>
                <p className="font-medium">{row.title}</p>
                <p className="line-clamp-2 text-xs text-gray-500">{row.summary ?? "无摘要"}</p>
                <p className="text-xs text-gray-400">/{row.slug}</p>
                <p className="text-xs text-gray-400" data-testid={`article-short-id-${row.id}`}>
                  {row.publicPageShortId}
                </p>
              </TD>
              <TD>
                {row.novel ? (
                  <Link
                    href={`/novels/${row.novel.id}`}
                    className="text-blue-700 hover:underline"
                    data-testid={`article-novel-link-${row.id}`}
                  >
                    {row.novel.title}
                  </Link>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </TD>
              <TD>{row.templateName ?? row.templateKey ?? "未绑定"}</TD>
              <TD>
                {row.canonicalTags && row.canonicalTags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {row.canonicalTags.map((name) => (
                      <span key={name} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                        {name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-gray-400">无分类</span>
                )}
              </TD>
              <TD>
                <ArticleTypeBadge articleType={(row.articleType ?? "novel_article") as ArticleType} />
              </TD>
              <TD>
                <ArticleContentModeBadge contentMode={(row.contentMode ?? "template") as ArticleContentMode} />
              </TD>
              <TD>
                <ArticleStatusBadge status={row.status as ArticleStatus} />
              </TD>
              <TD>
                <ArticleSeoVisibilityBadge seoVisibility={(row.seoVisibility ?? "public") as ArticleSeoVisibility} />
              </TD>
              <TD>
                <ArticleUrlCell row={row} publicOrigin={publicOrigin} />
              </TD>
              <TD className="text-gray-500">{formatDateTime(row.createdAt)}</TD>
              <TD>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/articles/${row.id}`} className={buttonClassName("secondary", "px-2 py-1 text-xs")}>
                    编辑/预览
                  </Link>
                  {/*
                    C-21 (analysis doc items #24/#25): CPS parity is "草稿显示
                    发布，已发布显示下线" — same status-gated visibility as
                    `../../novels/_components/publish-lifecycle-panel.tsx`'s
                    `showPublish`/`showWithdraw`. No row-level delete control
                    exists here or anywhere else in this file — item #27 is an
                    EXCLUDE (一对一绑定，删除即永久失去公开页), pinned by
                    `tests/ui/articles-admin.test.tsx`'s "列表中不存在删除
                    按钮" assertion.
                  */}
                  {row.status === "draft" && (
                    <button
                      disabled={!canWrite}
                      className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                      onClick={() => void handlePublish(row)}
                      data-testid={`article-publish-${row.id}`}
                    >
                      发布
                    </button>
                  )}
                  {row.status === "published" && row.novel && (
                    <button
                      disabled={!canWrite}
                      className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                      onClick={() => openWithdraw(row)}
                      data-testid={`article-withdraw-${row.id}`}
                    >
                      下线
                    </button>
                  )}
                  {/*
                    C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md`
                    §三/C-28): "the C-27 article_not_regenerable outcome
                    surfaces as a disabled 再生成" — `regenerateCore`
                    (`src/server/articles/service.ts`) already returns that
                    outcome (folded into the batch button's "失败" bucket,
                    see the warning above) for any Article with no Novel to
                    render template values from; a blog row disables the
                    button up front instead of letting an operator click it
                    into a guaranteed failure. `row.articleType` falls back
                    to `"novel_article"` for the same reason every other
                    optional C-26 field on this row does (the column's own
                    DB default) — a row built without it must read as
                    regenerable, not the other way around.
                  */}
                  <button
                    disabled={!canWrite || (row.articleType ?? "novel_article") !== "novel_article"}
                    title={
                      (row.articleType ?? "novel_article") !== "novel_article"
                        ? "博客文章没有绑定模板，不支持再生成"
                        : undefined
                    }
                    className={buttonClassName("secondary", "px-2 py-1 text-xs")}
                    data-testid={`article-regenerate-${row.id}`}
                    onClick={() =>
                      void regenerateArticleAction({
                        requestId: crypto.randomUUID(),
                        articleId: row.id,
                        expectedUpdatedAt: row.updatedAt,
                      }).then((result) => {
                        setMessage(
                          result.ok
                            ? result.data.outcome === "conflict"
                              ? "该文章已被其他操作人修改，请刷新后重试。"
                              : result.data.outcome
                            : result.code,
                        );
                        router.refresh();
                      })
                    }
                  >
                    再生成
                  </button>
                </div>
              </TD>
            </tr>
          ))}
          {/* C-26: colSpan bumped 10 → 12 for the two new 类型/内容模式 columns. */}
          {rows.length === 0 && (
            <EmptyRow colSpan={12}>
              {/*
                C-22 (`分析_文章管理Parity缺口_2026-09-08.md` §六, item #31,
                PORT): CPS's empty state is "暂无文章" + "去生成第一篇文章" →
                `/articles/generate` (`cps-admin-v851-admin-host`'s
                `articles-client.tsx:559-572`). cps-novel's ADAPTed creation
                entry is `/catalog-sync` (same route the header's "新建文章"/
                "批量新建" buttons above point at — see `../page.tsx`).
              */}
              <p>暂无文章</p>
              <Link href="/catalog-sync" className="text-sm text-blue-600 hover:underline">
                去创建第一篇文章
              </Link>
            </EmptyRow>
          )}
        </TBody>
      </Table>

      <ConfirmDialog
        open={withdrawTarget !== null}
        pending={withdrawBusy}
        title={`确认下线《${withdrawTarget?.title ?? ""}》？`}
        confirmLabel="下线"
        confirmVariant="secondary"
        body={
          <>
            <p>
              下线后该文章对外呈现为稳定的移除页，正文与前台 URL 均保留，可随时再次发布——不是删除。
            </p>
            <label className="block">
              <span className="mb-1 block text-xs text-gray-500">下线原因（必填，写入审计）</span>
              <input
                value={withdrawReason}
                onChange={(event) => {
                  setWithdrawReason(event.target.value);
                  if (withdrawReasonError) setWithdrawReasonError(null);
                }}
                aria-label="下线原因"
                aria-invalid={withdrawReasonError !== null}
                className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                placeholder="例如：运营决定临时下线"
              />
            </label>
            {withdrawReasonError && (
              <p role="alert" data-testid="article-withdraw-reason-error" className="text-xs text-red-700">
                {withdrawReasonError}
              </p>
            )}
          </>
        }
        onCancel={() => {
          if (withdrawBusy) return;
          setWithdrawTarget(null);
          setWithdrawReason("");
          setWithdrawReasonError(null);
        }}
        onConfirm={() => void confirmWithdraw()}
      />
    </div>
  );
}
