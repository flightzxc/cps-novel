/**
 * 一次性运维脚本（2026-10-07）：把「上游零章节」的已发布书目批量撤回（withdraw）。
 *
 * 背景见 `方案_上游零章节236本切换前下线_2026-10-07.md`：10-06 全量发布后，236 本书在上游目录里的
 * 章节数为 0，试读全部抓取失败，页面只剩跳转链接；切换前下线。Owner 定的做法是**不发版**，写一次性
 * 脚本，逐本复刻后台「撤回」按钮的数据库事务。后台没有批量撤回，而按钮路径绑着后台登录鉴权，命令行
 * 没法直接调用，所以这里按代码事实把事务逐步复刻出来，不去 import 业务代码。
 *
 * ## 复刻的对象（以代码为准）
 *
 * 后台按钮：`withdrawNovelAction`（`src/app/(admin)/novels/_actions.ts`）→ `withdrawNovel` →
 * `applyNovelRightsTransition`（kind = "withdraw"，`src/server/publish-gate/service.ts`）。
 * 它在**同一个事务**里依次做：
 *
 *   0. 幂等守卫：已存在 operation_audit（actorType=admin、action=novel.withdraw、entityType=Novel、
 *      entityId=novelId、requestId 相同）就只回放（读书目、读文章），不再写；
 *   1. 书目必须存在且未软删，且当前状态必须是 published，否则抛业务错误；
 *   2. 找出该书 deleted_at 为空、status=published 的文章；
 *   3. novel.status → unpublished；这些文章用 updateMany → unpublished（updated_at 由 Prisma 的
 *      @updatedAt 自动维护，所以这里必须走 Prisma 而不是手写 SQL，才能逐字段一致）；
 *   4. 写一条审计：actorType=admin、actorId、action=novel.withdraw、entityType=Novel、entityId、
 *      requestId、reason（trim 后）、beforeSnapshot {novelStatus:<原状态>}、afterSnapshot
 *      {novelStatus:"unpublished"}。
 *
 * 章节正文的删除与 withdrawn 标记**只在 takedown 时执行**，withdraw 不碰章节；本脚本同样**不碰**
 * 章节、推广链接、领取记录、标签、试读任务、站点地图任务——脚本里只出现对 novel / article /
 * operation_audit 的读写，以及只读的条件查询（novel_source_item、admin_identity、current_user）。
 *
 * ## 与按钮路径的有意差异（都不影响落库字段）
 *
 *   - 不做鉴权（`requireFreshAdminServiceMutation`）：actorId 由 `--actor-id` 指定为 Owner 的管理员
 *     身份，且 `--apply` 前会核对它在 admin_identity 里存在并处于 active；
 *   - 不做 `withDbRetry`：按钮对瞬时库错误会自动重试；这里单本失败只记录，用同一个
 *     `--request-id-prefix` 重跑即可（已提交的走幂等守卫回放，不重复写）；
 *   - 不做提交后的公开页缓存失效。原因：① 公开页路由全部是 `force-dynamic`，没有可失效的整页缓存；
 *     ② 唯一的数据缓存是 `getActiveLocales()` 的 `unstable_cache`（revalidate=300 秒，
 *     `src/lib/locale/active-locales.ts`），它只关心「哪些语种有公开内容」，en 仍有大量已发布内容，
 *     集合不变，且 300 秒内自行过期；③ `revalidatePath` / `revalidateTag` 绑定 Next 的请求上下文，
 *     在独立 CLI 进程里调用只会抛错（按钮路径里也是 try/catch 吞掉的），根本到不了 web 进程的缓存；
 *   - 按钮的 `novel.findFirst` / `article.findMany` 多读了 slug、publicPageShortId 等字段只为拼缓存
 *     路径；这里不读，不影响写入。
 *
 * ## 自包含
 *
 * 只依赖 `@prisma/client`（运行时经 `createRequire` 解析）和 node 内置模块，不 import `@/…` 或
 * `src` 下任何东西——它要被拷进生产 web 容器的 `/tmp`，在 cwd=/app 下用 `tsx` 直接运行。
 * `@prisma/client` 的解析基准：存在 `/app/package.json`（容器）就用它，否则用当前项目的
 * `package.json`（仓库/测试）。`createPrismaClient` 工厂可注入，测试传入自己的库连接。
 *
 * ## 用法
 *
 * 统计（默认，只读，不写任何东西）：
 *   tsx withdraw-zero-chapter-novels-20261007.ts \
 *     --list /tmp/withdraw-zero-chapter-list.tsv \
 *     --list-sha256-prefix cc63e467 --expect-count 236
 *
 * 执行（必须同时给出全部参数）：
 *   tsx withdraw-zero-chapter-novels-20261007.ts \
 *     --list /tmp/withdraw-zero-chapter-list.tsv \
 *     --list-sha256-prefix cc63e467 --expect-count 236 \
 *     --reason "上游零章节，切换前下线" \
 *     --request-id-prefix withdraw-zero-chapter-20261007 \
 *     --actor-id 71f0e655-0640-4f07-bcbb-041f027fa7cb \
 *     --apply --confirm WITHDRAW-ZERO-CHAPTER-NOVELS
 *
 * 退出码：0 正常；2 参数错误；1 前置条件不满足 / 库角色不对（未写任何东西）；3 已执行但有单本失败。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { PrismaClient } from "@prisma/client";

export const SCRIPT_BASENAME = "withdraw-zero-chapter-novels-20261007";
export const CONFIRM_PHRASE = "WITHDRAW-ZERO-CHAPTER-NOVELS";
/** 与 `RIGHTS_TRANSITION_AUDIT_ACTION.withdraw` 逐字一致。 */
export const WITHDRAW_AUDIT_ACTION = "novel.withdraw";
/** 生产里这条脚本以 web_app 角色跑，和按钮路径（Web 层连接）同一个角色。 */
export const REQUIRED_DATABASE_ROLE = "web_app";
/** `operation_audit.request_id` 是 VarChar(160)。 */
export const REQUEST_ID_MAX_LENGTH = 160;
/** 与 `trimmedReason` 的上限逐字一致。 */
export const REASON_MAX_LENGTH = 1000;
export const LIST_HEADER = [
  "novel_id",
  "article_id",
  "novel_source_item_id",
  "external_book_id",
  "locale",
  "title",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_LENGTH = 36;
const SHA256_PREFIX_RE = /^[0-9a-f]{8,64}$/i;
const REQUEST_ID_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TRANSIENT_MESSAGE_RE =
  /Socket timeout|Connection reset|ECONNRESET|ETIMEDOUT|timed out|Server has closed the connection|Can't reach database server/i;

export const USAGE = [
  "用法：",
  "  统计（只读）：--list <tsv> [--list-sha256-prefix <hex>=8+位] [--expect-count <n>] [--request-id-prefix <p>]",
  "  执行：--list <tsv> --list-sha256-prefix <hex> --expect-count <n> --reason <原因>",
  "        --request-id-prefix <p> --actor-id <管理员 UUID> --apply --confirm " + CONFIRM_PHRASE,
  "退出码：0 正常；2 参数错误；1 前置条件不满足（未写任何东西）；3 已执行但有单本失败",
].join("\n");

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class OpsError extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown> | null;
  constructor(code: string, detail: Record<string, unknown> | null = null) {
    super(code);
    this.name = "OpsError";
    this.code = code;
    this.detail = detail;
  }
}

/** 参数写法错误（退出码 2）。 */
export class UsageError extends OpsError {
  constructor(code: string, detail: Record<string, unknown> | null = null) {
    super(code, detail);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export type CliArgs = {
  readonly help: boolean;
  readonly apply: boolean;
  readonly list: string;
  readonly listSha256Prefix: string | undefined;
  readonly expectCount: number | undefined;
  readonly reason: string | undefined;
  readonly requestIdPrefix: string | undefined;
  readonly actorId: string | undefined;
  readonly confirm: string | undefined;
};

const VALUE_FLAGS = [
  "list",
  "list-sha256-prefix",
  "expect-count",
  "reason",
  "request-id-prefix",
  "actor-id",
  "confirm",
] as const;
const BOOLEAN_FLAGS = ["apply", "help"] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

/** 与 `trimmedReason`（service.ts）同一套规则：trim，必填，上限 1000。 */
export function normalizeReason(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new UsageError("reason_required");
  if (normalized.length > REASON_MAX_LENGTH) throw new UsageError("reason_too_long");
  return normalized;
}

export function buildRequestId(prefix: string, novelId: string): string {
  return `${prefix}:${novelId}`;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<ValueFlag, string>();
  const booleans = new Set<(typeof BOOLEAN_FLAGS)[number]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new UsageError("unexpected_positional_argument", { token });
    const equalsAt = token.indexOf("=");
    const name = equalsAt > 0 ? token.slice(2, equalsAt) : token.slice(2);
    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      if (equalsAt > 0) throw new UsageError("flag_takes_no_value", { flag: name });
      booleans.add(name as (typeof BOOLEAN_FLAGS)[number]);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) throw new UsageError("unknown_flag", { flag: name });
    const flag = name as ValueFlag;
    if (values.has(flag)) throw new UsageError("duplicate_flag", { flag });
    let value: string | undefined;
    if (equalsAt > 0) {
      value = token.slice(equalsAt + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError("missing_value", { flag });
      value = next;
      index += 1;
    }
    values.set(flag, value);
  }

  const help = booleans.has("help");
  const apply = booleans.has("apply");
  const list = values.get("list");
  if (!help && (list === undefined || list === "")) throw new UsageError("missing_argument", { flags: ["list"] });

  const shaRaw = values.get("list-sha256-prefix");
  if (shaRaw !== undefined && !SHA256_PREFIX_RE.test(shaRaw)) {
    throw new UsageError("invalid_list_sha256_prefix", { value: shaRaw });
  }
  const expectRaw = values.get("expect-count");
  if (expectRaw !== undefined && !/^[1-9][0-9]{0,8}$/.test(expectRaw)) {
    throw new UsageError("invalid_expect_count", { value: expectRaw });
  }
  const reasonRaw = values.get("reason");
  const reason = reasonRaw === undefined ? undefined : normalizeReason(reasonRaw);
  const prefix = values.get("request-id-prefix");
  if (prefix !== undefined) {
    if (!REQUEST_ID_PREFIX_RE.test(prefix)) throw new UsageError("invalid_request_id_prefix", { value: prefix });
    // 每本的编号 = `${prefix}:${novelId}`，必须在写任何东西之前就确认不会超过 160。
    if (buildRequestId(prefix, "0".repeat(UUID_LENGTH)).length > REQUEST_ID_MAX_LENGTH) {
      throw new UsageError("request_id_prefix_too_long", { max: REQUEST_ID_MAX_LENGTH - UUID_LENGTH - 1 });
    }
  }
  const actorRaw = values.get("actor-id");
  if (actorRaw !== undefined && !UUID_RE.test(actorRaw)) throw new UsageError("invalid_actor_id", { value: actorRaw });

  const args: CliArgs = {
    help,
    apply,
    list: list ?? "",
    listSha256Prefix: shaRaw?.toLowerCase(),
    expectCount: expectRaw === undefined ? undefined : Number(expectRaw),
    reason,
    requestIdPrefix: prefix,
    actorId: actorRaw?.toLowerCase(),
    confirm: values.get("confirm"),
  };

  if (apply && !help) {
    const missing: string[] = [];
    if (args.listSha256Prefix === undefined) missing.push("list-sha256-prefix");
    if (args.expectCount === undefined) missing.push("expect-count");
    if (args.reason === undefined) missing.push("reason");
    if (args.requestIdPrefix === undefined) missing.push("request-id-prefix");
    if (args.actorId === undefined) missing.push("actor-id");
    if (args.confirm === undefined) missing.push("confirm");
    if (missing.length > 0) throw new UsageError("missing_argument", { flags: missing });
  }
  return args;
}

// ---------------------------------------------------------------------------
// 名单文件
// ---------------------------------------------------------------------------

export type ListRow = {
  readonly novelId: string;
  readonly articleId: string;
  readonly novelSourceItemId: string;
  readonly externalBookId: string;
  readonly locale: string;
  readonly title: string;
};

export type LoadedList = {
  readonly path: string;
  readonly sha256: string;
  readonly rows: readonly ListRow[];
};

export function parseListTsv(text: string): ListRow[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const clean = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (clean.length === 0) throw new OpsError("list_empty");
  if (clean[0] !== LIST_HEADER.join("\t")) throw new OpsError("list_header_mismatch", { found: clean[0] });

  const rows: ListRow[] = [];
  const seenNovels = new Set<string>();
  const seenArticles = new Set<string>();
  for (let index = 1; index < clean.length; index += 1) {
    const lineNumber = index + 1;
    const columns = clean[index]!.split("\t");
    if (columns.length !== LIST_HEADER.length) {
      throw new OpsError("list_row_malformed", { line: lineNumber, columns: columns.length });
    }
    const [novelId, articleId, novelSourceItemId, externalBookId, locale, title] = columns as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    for (const [column, value] of [
      ["novel_id", novelId],
      ["article_id", articleId],
      ["novel_source_item_id", novelSourceItemId],
    ] as const) {
      if (!UUID_RE.test(value)) throw new OpsError("list_row_invalid_uuid", { line: lineNumber, column });
    }
    if (!externalBookId || !locale) throw new OpsError("list_row_missing_field", { line: lineNumber });
    const novelKey = novelId.toLowerCase();
    const articleKey = articleId.toLowerCase();
    if (seenNovels.has(novelKey)) throw new OpsError("list_duplicate_novel", { line: lineNumber, novelId: novelKey });
    if (seenArticles.has(articleKey)) throw new OpsError("list_duplicate_article", { line: lineNumber, articleId: articleKey });
    seenNovels.add(novelKey);
    seenArticles.add(articleKey);
    rows.push({
      novelId: novelKey,
      articleId: articleKey,
      novelSourceItemId: novelSourceItemId.toLowerCase(),
      externalBookId,
      locale,
      title,
    });
  }
  if (rows.length === 0) throw new OpsError("list_empty");
  return rows;
}

export function loadList(listPath: string, read: (filePath: string) => Buffer = readFileSync): LoadedList {
  let buffer: Buffer;
  try {
    buffer = read(listPath);
  } catch (error) {
    throw new OpsError("list_unreadable", { path: listPath, message: error instanceof Error ? error.message : String(error) });
  }
  return {
    path: listPath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    rows: parseListTsv(buffer.toString("utf8")),
  };
}

// ---------------------------------------------------------------------------
// 只读核对：把名单和库里按方案第二节同一条件重新查出来的集合逐个比对
// ---------------------------------------------------------------------------

export type CandidateRow = {
  readonly novelId: string;
  readonly articleId: string;
  readonly novelSourceItemId: string;
  readonly externalBookId: string;
  readonly locale: string;
  readonly title: string;
};

/** 方案文档第二节「只读 SQL」的同一条件（ORDER BY 只影响显示，不参与比对）。 */
export async function queryCandidates(db: PrismaClient): Promise<CandidateRow[]> {
  const rows = await db.$queryRaw<
    Array<{
      novel_id: string;
      article_id: string;
      novel_source_item_id: string;
      external_book_id: string;
      locale: string;
      title: string;
    }>
  >`
    SELECT n.id AS novel_id, a.id AS article_id, si.id AS novel_source_item_id,
           si.external_book_id AS external_book_id, a.locale AS locale, a.title AS title
    FROM article a
    JOIN novel n ON n.id = a.novel_id
    JOIN novel_source_item si ON si.novel_id = n.id
    WHERE a.status = 'published' AND a.deleted_at IS NULL
      AND n.deleted_at IS NULL AND si.deleted_at IS NULL
      AND si.total_chapter_count = 0
    ORDER BY si.external_book_id, n.id`;
  return rows.map((row) => ({
    novelId: row.novel_id.toLowerCase(),
    articleId: row.article_id.toLowerCase(),
    novelSourceItemId: row.novel_source_item_id.toLowerCase(),
    externalBookId: row.external_book_id,
    locale: row.locale,
    title: row.title,
  }));
}

export async function readDatabaseRole(db: PrismaClient): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ current_user: string }>>`SELECT current_user`;
  return rows[0]?.current_user ?? null;
}

/** 名单里已经被「同一个前缀」撤回过的书目（存在对应编号的 novel.withdraw 审计）。 */
export async function findAlreadyWithdrawn(
  db: PrismaClient,
  novelIds: readonly string[],
  requestIdPrefix: string,
): Promise<Set<string>> {
  const rows = await db.operationAudit.findMany({
    where: {
      actorType: "admin",
      action: WITHDRAW_AUDIT_ACTION,
      entityType: "Novel",
      requestId: { in: novelIds.map((novelId) => buildRequestId(requestIdPrefix, novelId)) },
    },
    select: { entityId: true, requestId: true },
  });
  const done = new Set<string>();
  for (const row of rows) {
    if (row.requestId === buildRequestId(requestIdPrefix, row.entityId)) done.add(row.entityId.toLowerCase());
  }
  return done;
}

export type NovelStatusRow = {
  readonly novelId: string;
  readonly externalBookId: string;
  readonly locale: string;
  readonly title: string;
  readonly novelStatus: string | null;
  readonly novelDeleted: boolean;
  readonly articles: ReadonlyArray<{
    readonly articleId: string;
    readonly locale: string;
    readonly status: string;
    readonly deleted: boolean;
  }>;
};

export type ScopeInspection = {
  readonly queryRows: readonly CandidateRow[];
  readonly queryNovelIds: readonly string[];
  /** 名单有而库（按同一条件）没有。 */
  readonly inListNotInQuery: readonly string[];
  /** 库有而名单没有。 */
  readonly inQueryNotInList: readonly string[];
  /** 名单与查询里同一本书对应的文章编号不一致。 */
  readonly articleMismatches: ReadonlyArray<{ novelId: string; listArticleId: string; queryArticleId: string }>;
  readonly replayableChecked: boolean;
  /** 名单内、已被同一个前缀撤回过的书目：这是重跑时「名单有而查询里没有」的唯一合法原因。 */
  readonly replayableNovelIds: readonly string[];
  /** 已被撤回过、却又重新满足下线条件（被重新发布）的书目：幂等守卫会回放而不写，必须停下来人工看。 */
  readonly republishedAfterWithdraw: readonly string[];
  /** 名单有而库没有，又不能用「本前缀已撤回」解释的书目。 */
  readonly unexplainedMissing: readonly string[];
  readonly queryHasOneRowPerNovel: boolean;
  readonly setsEqual: boolean;
  readonly novels: readonly NovelStatusRow[];
  readonly statusCounts: { readonly novel: Record<string, number>; readonly article: Record<string, number> };
  readonly localeDistribution: { readonly list: Record<string, number>; readonly query: Record<string, number> };
};

const sortedIds = (values: Iterable<string>): string[] => [...values].sort();

function countBy<T>(items: Iterable<T>, key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export async function inspectScope(
  db: PrismaClient,
  list: readonly ListRow[],
  options: { requestIdPrefix?: string | undefined } = {},
): Promise<ScopeInspection> {
  const queryRows = await queryCandidates(db);
  const listIds = list.map((row) => row.novelId);
  const listIdSet = new Set(listIds);
  const queryIdSet = new Set(queryRows.map((row) => row.novelId));

  const inListNotInQuery = sortedIds(listIds.filter((id) => !queryIdSet.has(id)));
  const inQueryNotInList = sortedIds([...queryIdSet].filter((id) => !listIdSet.has(id)));

  const queryArticlesByNovel = new Map<string, string[]>();
  for (const row of queryRows) queryArticlesByNovel.set(row.novelId, [...(queryArticlesByNovel.get(row.novelId) ?? []), row.articleId]);
  const articleMismatches = list.flatMap((row) => {
    const queryArticleIds = queryArticlesByNovel.get(row.novelId);
    return queryArticleIds !== undefined && !queryArticleIds.includes(row.articleId)
      ? [{ novelId: row.novelId, listArticleId: row.articleId, queryArticleId: queryArticleIds[0]! }]
      : [];
  });

  const replayableChecked = options.requestIdPrefix !== undefined;
  const alreadyWithdrawn = replayableChecked
    ? await findAlreadyWithdrawn(db, listIds, options.requestIdPrefix!)
    : new Set<string>();
  const replayableNovelIds = sortedIds(inListNotInQuery.filter((id) => alreadyWithdrawn.has(id)));
  const republishedAfterWithdraw = sortedIds([...alreadyWithdrawn].filter((id) => queryIdSet.has(id)));
  const unexplainedMissing = inListNotInQuery.filter((id) => !alreadyWithdrawn.has(id));
  const queryHasOneRowPerNovel = queryRows.length === queryIdSet.size;
  const setsEqual =
    unexplainedMissing.length === 0 &&
    inQueryNotInList.length === 0 &&
    republishedAfterWithdraw.length === 0 &&
    articleMismatches.length === 0;

  // 每本当前的书目与文章状态（只读；列只取状态相关的几列）。
  const [novelRows, articleRows] = await Promise.all([
    db.novel.findMany({ where: { id: { in: listIds } }, select: { id: true, status: true, deletedAt: true } }),
    db.article.findMany({
      where: { novelId: { in: listIds } },
      select: { id: true, novelId: true, locale: true, status: true, deletedAt: true },
      orderBy: [{ locale: "asc" }, { id: "asc" }],
    }),
  ]);
  const novelById = new Map(novelRows.map((row) => [row.id.toLowerCase(), row]));
  const novels: NovelStatusRow[] = list.map((row) => {
    const novel = novelById.get(row.novelId);
    return {
      novelId: row.novelId,
      externalBookId: row.externalBookId,
      locale: row.locale,
      title: row.title,
      novelStatus: novel?.status ?? null,
      novelDeleted: novel ? novel.deletedAt !== null : false,
      articles: articleRows
        .filter((article) => article.novelId?.toLowerCase() === row.novelId)
        .map((article) => ({
          articleId: article.id.toLowerCase(),
          locale: article.locale,
          status: article.status,
          deleted: article.deletedAt !== null,
        })),
    };
  });

  return {
    queryRows,
    queryNovelIds: sortedIds(queryIdSet),
    inListNotInQuery,
    inQueryNotInList,
    articleMismatches,
    replayableChecked,
    replayableNovelIds,
    republishedAfterWithdraw,
    unexplainedMissing,
    queryHasOneRowPerNovel,
    setsEqual,
    novels,
    statusCounts: {
      novel: countBy(novels, (novel) => novel.novelStatus ?? "missing"),
      article: countBy(
        novels.flatMap((novel) => novel.articles),
        (article) => (article.deleted ? `${article.status}(deleted)` : article.status),
      ),
    },
    localeDistribution: {
      list: countBy(list, (row) => row.locale),
      query: countBy(queryRows, (row) => row.locale),
    },
  };
}

// ---------------------------------------------------------------------------
// 前置条件
// ---------------------------------------------------------------------------

export type CheckResult = {
  /** true=通过，false=不通过，null=本次没给参数、不适用。 */
  readonly checks: Record<string, boolean | null>;
  readonly failures: readonly string[];
};

export function evaluateChecks(input: {
  readonly args: Pick<CliArgs, "apply" | "confirm" | "listSha256Prefix" | "expectCount">;
  readonly listSha256: string;
  readonly listRowCount: number;
  readonly scope: ScopeInspection;
  readonly role: string | null;
}): CheckResult {
  const { args, scope } = input;
  const checks: Record<string, boolean | null> = {
    databaseRoleIsWebApp: input.role === REQUIRED_DATABASE_ROLE,
    confirmPhraseMatches: args.apply ? args.confirm === CONFIRM_PHRASE : null,
    listSha256PrefixMatches:
      args.listSha256Prefix === undefined ? null : input.listSha256.startsWith(args.listSha256Prefix),
    expectCountEqualsListCount: args.expectCount === undefined ? null : args.expectCount === input.listRowCount,
    expectCountEqualsQueryCount:
      args.expectCount === undefined
        ? null
        : args.expectCount === scope.queryRows.length + scope.replayableNovelIds.length,
    queryHasOneRowPerNovel: scope.queryHasOneRowPerNovel,
    listAndQuerySetsEqual: scope.setsEqual,
  };
  const failures = Object.entries(checks)
    .filter(([, passed]) => passed === false)
    .map(([name]) => name);
  return { checks, failures };
}

// ---------------------------------------------------------------------------
// 撤回事务（逐步复刻 applyNovelRightsTransition，kind = "withdraw"）
// ---------------------------------------------------------------------------

export type WithdrawInput = {
  readonly novelId: string;
  readonly requestId: string;
  readonly actorId: string;
  readonly reason: string;
};

export type WithdrawTxResult = {
  readonly outcome: "withdrawn" | "replayed";
  readonly novelId: string;
  readonly novelStatus: string;
  readonly affectedArticleIds: readonly string[];
};

export async function withdrawNovelInTransaction(db: PrismaClient, input: WithdrawInput): Promise<WithdrawTxResult> {
  const why = normalizeReason(input.reason);
  if (input.requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw new OpsError("request_id_too_long", { length: input.requestId.length });
  }

  return db.$transaction<WithdrawTxResult>(async (tx) => {
    // 0. 幂等守卫（where 与按钮路径逐字一致）。
    const existingAudit = await tx.operationAudit.findFirst({
      where: {
        actorType: "admin",
        action: WITHDRAW_AUDIT_ACTION,
        entityType: "Novel",
        entityId: input.novelId,
        requestId: input.requestId,
      },
    });
    if (existingAudit) {
      const novel = await tx.novel.findUniqueOrThrow({ where: { id: input.novelId } });
      const articles = await tx.article.findMany({
        where: { novelId: input.novelId, deletedAt: null },
        select: { id: true },
      });
      return {
        outcome: "replayed",
        novelId: input.novelId,
        novelStatus: novel.status,
        affectedArticleIds: articles.map((article) => article.id),
      };
    }

    // 1. 书目必须存在、未软删，且当前是 published。
    const novel = await tx.novel.findFirst({ where: { id: input.novelId, deletedAt: null } });
    if (!novel) throw new OpsError("novel_not_found", { novelId: input.novelId });
    if (novel.status !== "published") {
      throw new OpsError("novel_not_currently_published", { novelId: input.novelId, status: novel.status });
    }

    // 2. 作用范围：deleted_at 为空且 status=published 的文章（草稿等其它状态的文章不动）。
    const affected = await tx.article.findMany({
      where: { novelId: input.novelId, deletedAt: null, status: "published" },
      select: { id: true },
    });
    const affectedArticleIds = affected.map((article) => article.id);

    // 3. 书目与文章一起改成 unpublished（同一事务）。
    await tx.novel.update({ where: { id: input.novelId }, data: { status: "unpublished" } });
    if (affectedArticleIds.length > 0) {
      await tx.article.updateMany({
        where: { id: { in: affectedArticleIds } },
        data: { status: "unpublished" },
      });
    }

    // 4. 审计：字段与按钮路径逐项一致。
    await tx.operationAudit.create({
      data: {
        actorType: "admin",
        actorId: input.actorId,
        action: WITHDRAW_AUDIT_ACTION,
        entityType: "Novel",
        entityId: input.novelId,
        requestId: input.requestId,
        reason: why,
        beforeSnapshot: { novelStatus: novel.status },
        afterSnapshot: { novelStatus: "unpublished" },
      },
    });

    return { outcome: "withdrawn", novelId: input.novelId, novelStatus: "unpublished", affectedArticleIds };
  });
}

export function classifyError(error: unknown): string {
  if (error instanceof OpsError) return error.code;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    if (code === "P2002") return "unique_violation";
    if (code === "P1008" || code === "P2034") return "transient_db";
    if (/^P\d{4}$/.test(code)) return `prisma_${code}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_MESSAGE_RE.test(message) ? "transient_db" : "unexpected";
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

export type NovelResult = {
  readonly type: "novel";
  readonly novelId: string;
  readonly requestId: string;
  readonly outcome: "withdrawn" | "replayed" | "failed";
  readonly affectedArticleCount: number | null;
  readonly errorCategory: string | null;
  readonly errorMessage: string | null;
};

export type BatchSummary = {
  readonly type: "summary";
  readonly mode: "apply";
  readonly requestIdPrefix: string;
  readonly actorId: string;
  readonly total: number;
  readonly withdrawn: number;
  readonly replayed: number;
  readonly failed: number;
  readonly articlesWithdrawn: number;
  readonly failedByCategory: Record<string, number>;
  readonly failedNovelIds: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
};

/**
 * 逐本、每本一个事务。单本失败只记录、不中断；返回汇总。不做任何前置核对——
 * 前置条件由调用方（`main`）负责，测试可以直接用它验证「单本失败不中断」。
 */
export async function applyWithdrawals(
  db: PrismaClient,
  options: {
    readonly novelIds: readonly string[];
    readonly requestIdPrefix: string;
    readonly actorId: string;
    readonly reason: string;
    readonly onResult?: (result: NovelResult) => void;
  },
): Promise<{ summary: BatchSummary; results: NovelResult[] }> {
  const startedAt = new Date().toISOString();
  const results: NovelResult[] = [];
  for (const novelId of options.novelIds) {
    const requestId = buildRequestId(options.requestIdPrefix, novelId);
    let result: NovelResult;
    try {
      const done = await withdrawNovelInTransaction(db, {
        novelId,
        requestId,
        actorId: options.actorId,
        reason: options.reason,
      });
      result = {
        type: "novel",
        novelId,
        requestId,
        outcome: done.outcome,
        affectedArticleCount: done.affectedArticleIds.length,
        errorCategory: null,
        errorMessage: null,
      };
    } catch (error) {
      result = {
        type: "novel",
        novelId,
        requestId,
        outcome: "failed",
        affectedArticleCount: null,
        errorCategory: classifyError(error),
        errorMessage: shortMessage(error),
      };
    }
    results.push(result);
    options.onResult?.(result);
  }
  const failed = results.filter((result) => result.outcome === "failed");
  const summary: BatchSummary = {
    type: "summary",
    mode: "apply",
    requestIdPrefix: options.requestIdPrefix,
    actorId: options.actorId,
    total: results.length,
    withdrawn: results.filter((result) => result.outcome === "withdrawn").length,
    replayed: results.filter((result) => result.outcome === "replayed").length,
    failed: failed.length,
    articlesWithdrawn: results
      .filter((result) => result.outcome === "withdrawn")
      .reduce((sum, result) => sum + (result.affectedArticleCount ?? 0), 0),
    failedByCategory: countBy(failed, (result) => result.errorCategory ?? "unexpected"),
    failedNovelIds: failed.map((result) => result.novelId),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  return { summary, results };
}

// ---------------------------------------------------------------------------
// PrismaClient 工厂（可注入）
// ---------------------------------------------------------------------------

/** 容器里用 `/app/package.json`，仓库/测试里用当前项目的 `package.json`。 */
export function resolveProjectPackageJson(
  cwd: string = process.cwd(),
  exists: (target: string) => boolean = existsSync,
): string {
  return exists("/app/package.json") ? "/app/package.json" : path.join(cwd, "package.json");
}

export function createDefaultPrismaClient(): PrismaClient {
  const requireFromProject = createRequire(resolveProjectPackageJson());
  const { PrismaClient: PrismaClientConstructor } = requireFromProject("@prisma/client") as typeof import("@prisma/client");
  return new PrismaClientConstructor();
}

// ---------------------------------------------------------------------------
// CLI 入口：只负责解析参数、调用上面的核心函数、打印 JSON
// ---------------------------------------------------------------------------

export type CliIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

export type MainDeps = {
  readonly createPrismaClient?: () => PrismaClient;
  readonly io?: CliIo;
  readonly readListFile?: (filePath: string) => Buffer;
};

const defaultIo: CliIo = {
  out: (line) => void process.stdout.write(`${line}\n`),
  err: (line) => void process.stderr.write(`${line}\n`),
};

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(JSON.stringify({ type: "usage_error", code: error.code, detail: error.detail }));
      io.err(USAGE);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  let db: PrismaClient | undefined;
  try {
    const list = loadList(args.list, deps.readListFile);
    db = (deps.createPrismaClient ?? createDefaultPrismaClient)();
    return await run(db, args, list, io);
  } catch (error) {
    if (error instanceof OpsError) {
      io.err(JSON.stringify({ type: "error", code: error.code, detail: error.detail }));
      return error instanceof UsageError ? 2 : 1;
    }
    io.err(JSON.stringify({ type: "error", code: classifyError(error), message: shortMessage(error) }));
    return 1;
  } finally {
    await db?.$disconnect();
  }
}

async function run(db: PrismaClient, args: CliArgs, list: LoadedList, io: CliIo): Promise<number> {
  const role = await readDatabaseRole(db);
  if (role !== REQUIRED_DATABASE_ROLE) {
    io.out(
      JSON.stringify({
        type: "refused",
        mode: args.apply ? "apply" : "read_only",
        failures: ["databaseRoleIsWebApp"],
        databaseRole: role,
        expectedRole: REQUIRED_DATABASE_ROLE,
      }),
    );
    return 1;
  }

  const scope = await inspectScope(db, list.rows, { requestIdPrefix: args.requestIdPrefix });
  const evaluation = evaluateChecks({
    args,
    listSha256: list.sha256,
    listRowCount: list.rows.length,
    scope,
    role,
  });
  const listInfo = {
    path: list.path,
    sha256: list.sha256,
    sha256Prefix8: list.sha256.slice(0, 8),
    rowCount: list.rows.length,
  };

  if (!args.apply) {
    io.out(
      JSON.stringify(
        {
          type: "stats",
          mode: "read_only",
          databaseRole: role,
          list: listInfo,
          query: { rowCount: scope.queryRows.length, distinctNovels: scope.queryNovelIds.length },
          inListNotInQuery: scope.inListNotInQuery,
          inQueryNotInList: scope.inQueryNotInList,
          articleMismatches: scope.articleMismatches,
          alreadyWithdrawnUnderPrefix: { checked: scope.replayableChecked, novelIds: scope.replayableNovelIds },
          republishedAfterWithdraw: scope.republishedAfterWithdraw,
          statusCounts: scope.statusCounts,
          localeDistribution: scope.localeDistribution,
          checks: evaluation.checks,
          failures: evaluation.failures,
          novels: scope.novels,
        },
        null,
        2,
      ),
    );
    return evaluation.failures.length === 0 ? 0 : 1;
  }

  // --apply：先把所有前置条件过完，任何一条不满足就在写任何东西之前退出。
  const failures = [...evaluation.failures];
  if (failures.length === 0) {
    const actor = await db.adminIdentity.findFirst({
      where: { id: args.actorId!, status: "active" },
      select: { id: true },
    });
    if (!actor) failures.push("actorIsActiveAdminIdentity");
  }
  if (failures.length > 0) {
    io.out(
      JSON.stringify({
        type: "refused",
        mode: "apply",
        failures,
        checks: evaluation.checks,
        list: listInfo,
        query: { rowCount: scope.queryRows.length, distinctNovels: scope.queryNovelIds.length },
        inListNotInQuery: scope.inListNotInQuery,
        inQueryNotInList: scope.inQueryNotInList,
        articleMismatches: scope.articleMismatches,
        unexplainedMissing: scope.unexplainedMissing,
        republishedAfterWithdraw: scope.republishedAfterWithdraw,
      }),
    );
    return 1;
  }

  io.out(
    JSON.stringify({
      type: "preflight",
      mode: "apply",
      list: listInfo,
      expectCount: args.expectCount,
      queryRowCount: scope.queryRows.length,
      alreadyWithdrawnCount: scope.replayableNovelIds.length,
      requestIdPrefix: args.requestIdPrefix,
      actorId: args.actorId,
      reason: args.reason,
      checks: evaluation.checks,
    }),
  );
  const { summary } = await applyWithdrawals(db, {
    novelIds: list.rows.map((row) => row.novelId),
    requestIdPrefix: args.requestIdPrefix!,
    actorId: args.actorId!,
    reason: args.reason!,
    onResult: (result) => io.out(JSON.stringify(result)),
  });
  io.out(JSON.stringify(summary));
  return summary.failed === 0 ? 0 : 3;
}

// 拷进容器后以 `tsx <本文件>` 直接运行；被测试 import 时 argv[1] 不是本文件，不会自动执行。
// 不用 import.meta：package.json 没有 "type": "module"，tsx 会把容器 /tmp 里的 .ts 当 CJS 编译。
const invokedAsScript =
  process.argv[1] !== undefined && path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") === SCRIPT_BASENAME;
if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ type: "fatal", message: shortMessage(error) })}\n`);
      process.exitCode = 1;
    },
  );
}
