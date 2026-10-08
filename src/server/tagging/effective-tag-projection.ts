/**
 * 小说「生效分类归属」投影（`novel_effective_tag`）。
 *
 * B-38（方案_B38根治_公开列表改数据库分页_v0.5.13_2026-10-09.md §4.3）：CPS
 * `src/lib/tag-effective/project.ts` 把"生效标签"物化成 `drama_effective_tag`，前台只读这张表；
 * 海阅平移成 `novel_effective_tag`。每行 = "某本书属于某个启用中的分类"，外加来源
 * （manual / mapped / auto）、自动标签分数、本书标签内的显示顺序 `rank`。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 这是全仓库唯一被允许写 `novel_effective_tag` 的文件。
 *
 * 这张表是派生数据，唯一真源是下面的规则 SQL（人工快照 / 上游标签映射 / 自动标签三套规则，
 * 与改造前 `src/lib/site/public-taxonomy.ts` 的现场计算逐字同语义）；别处写 = bug。
 * `tests/backend/tagging/effective-tag-write-path-registry.test.ts` 扫描全仓库，任何其它文件
 * 出现对该表的写操作都会让用例变红；迁移 SQL 里的"首次建表"是本文件规则 SQL 的逐字快照，
 * 由 `tests/backend/tagging/effective-tag-first-build-snapshot.test.ts` 钉住。
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## 规则（必须与 `queryPublicTaxonomyRows` 的两个分支等价）
 *
 * - base 段：`novel_tag_state.mode = 'manual'` 的书只认 `novel_canonical_tag.source = 'manual'`
 *   → provenance `manual`；其余（含没有状态行）的书走上游映射：`novel_source_item`（linked、
 *   未删、有 raw_language_scope）→ 启用中的 `channel_app` → 活跃的 `novel_source_item_label`
 *   → 同渠道 `series_type` 的 `source_label` → 同渠道、同语言范围、同原始词的活跃
 *   `source_label_mapping`（范围与原始词按 `COLLATE "C"` 逐字节比较）→ provenance `mapped`。
 * - auto 段：`mode = 'automatic'` 且 `classification_run_id = current_auto_run_id` 且
 *   `source = 'auto'` 的行，**只保留 base 段里没有的 (书, 分类)** → provenance `auto`，
 *   score 取 `novel_canonical_tag.score`。
 * - 只收录 `canonical_tag.status = 'active'` 的分类（CPS 解析器同款 ACTIVE_TAG）。
 * - `rank` = 本书标签内的显示顺序（从 0 起）。排序表达式**原样复制**改造前"自动开"分支的
 *   ORDER BY：base 段在前按 `sort_order`、`slug`，auto 段在后按 `score DESC`（PG 的 DESC 默认
 *   NULLS FIRST，所以分数为空的 auto 行排在最前——这是现状，不是笔误，不要"优化"）、`stable_id`。
 *   末尾追加 `ct.id` 只是让排序全序化：`slug`、`stable_id` 在库里各自唯一，所以它在真实数据上
 *   永远不会改变任何顺序，只保证 rank 在并列时也确定、对账不会因为并列抖动而反复改写。
 *   于是：自动标签开关打开时按 rank 读 = 改造前"开"分支的顺序；关闭时去掉 auto 行按 rank 读
 *   = 改造前"关"分支的顺序。开关本身**不写进表里**。
 *
 * ## 并发（咨询锁 50212）
 *
 * 全量对账拿**独占**锁，单本/单页重算拿**共享**锁（同一把键）。效果：对账一定在所有进行中的
 * 重算提交之后才取数；对账期间开始的重算会等对账结束。这样不会出现"对账用旧数据把刚改好的
 * 那本书改回去"。锁是事务级的（`pg_advisory_xact_*`），随事务结束释放，不会残留。
 *
 * 在咨询锁之外，单本重算还会先对这些书的 `novel` 行加 `FOR NO KEY UPDATE`（按 id 排序）：
 * 共享锁互相兼容，挡不住"两个事务同时重算同一本书"——后提交者会用自己取数时的旧快照把先提交
 * 者的结果改回去；另外后台改人工标签的事务已持有该书的 `FOR UPDATE`，目录同步事务若先把
 * 投影行插进去、再等外键检查要的父行锁，会和它互相等待成死锁。先锁书行就同时排除这两种情况。
 * 调用方的锁顺序纪律：**先咨询锁、后行锁**（见 `lockEffectiveTagProjectionShared/Exclusive`
 * 导出，`service.ts`、`admin-service.ts` 在拿行锁之前就先调用）。
 *
 * ## 只写差异
 *
 * 重算 / 对账都是"算出应有行 → 与表内现有行比对 → 只删多余、只插缺失、只改变了的"，一条
 * 语句（带数据修改的 CTE）完成。稳定状态下写入为零（连 UPDATE 都不发，也就没有行锁和 WAL）。
 *
 * ## 为什么重算是"同事务直接算"而不是 CPS 的发件箱
 *
 * 方案「再议 A」：海阅的归属是一条集合 SQL（生产上全部 18.5 万条 0.41 秒算完），可以在改动
 * 真源的同一事务里直接算完，不需要发件箱表和新的后台任务类型。**重算入口都收在本文件**——
 * 若 Owner 改判成发件箱，只改这一处。
 *
 * ## 🔴 `target_source_item AS MATERIALIZED` 必须保留
 *
 * 防"统计信息缺失时的坏计划"（`channel_app` 是一张从没被 analyze 过的 1 行表），完整的
 * 现象、数字和两条被证伪的归因见 `src/lib/site/public-taxonomy.ts` 里
 * `loadPublicTaxonomyByNovelIds` 上方的长注释。结论：不要为了"少一层 CTE"把它内联回去，
 * 也不要去掉 `MATERIALIZED`（PG12 起 CTE 默认可被内联）。`slm` 两列的 `COLLATE "C"` 同理不是
 * 冗余写法（`slm` 的两列本身是 `text COLLATE "C"`，对侧是默认排序规则，不显式指定会报
 * "无法确定排序规则"）。
 */
import { chunkIds } from "@/lib/db/chunked-id-lookup";
import { Prisma, type PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * 投影咨询锁的固定两整数键。50210 是站点地图刷新（`src/lib/tasks/sitemap-refresh.ts`），
 * 50211 是调度器按任务类型的入队锁（`src/lib/tasks/scheduler.ts`）。
 *
 * 共享（单本/单页重算）与独占（全量对账）使用同一把键。
 */
export const EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK = Object.freeze({ namespace: 50_212, scope: 1 });

/**
 * 每次查询最多带多少个小说 id。与 `PUBLIC_TAXONOMY_NOVEL_ID_CHUNK_SIZE` 同一个理由：
 * Prisma 单条语句最多 32,767 个绑定变量，同一组 id 在一条重算语句里会出现 4 次
 * （`target_source_item`、人工段、自动段、现有行比对），2,000 × 4 = 8,000，离上限还有 4 倍余量。
 */
export const EFFECTIVE_TAG_NOVEL_ID_CHUNK_SIZE = 2_000;

/** 全量对账 / 全量检查的事务超时。Prisma 交互式事务默认只有 5 秒，生产全量对账约 1 秒，留足余量。 */
export const EFFECTIVE_TAG_RECONCILE_TRANSACTION_TIMEOUT_MS = 60_000;

export type EffectiveTagChangeSummary = Readonly<{
  inserted: number;
  updated: number;
  deleted: number;
}>;

export type EffectiveTagCheckSample = Readonly<{
  kind: "missing" | "extra" | "changed";
  novelId: string;
  canonicalTagId: string;
}>;

export type EffectiveTagCheckResult = Readonly<{
  missing: number;
  extra: number;
  changed: number;
  samples: readonly EffectiveTagCheckSample[];
}>;

export const EFFECTIVE_TAG_CHECK_SAMPLE_LIMIT = 20;

const ZERO_SUMMARY: EffectiveTagChangeSummary = Object.freeze({ inserted: 0, updated: 0, deleted: 0 });

type Scope =
  | Readonly<{ kind: "novels"; ids: readonly string[] }>
  | Readonly<{ kind: "all" }>;

function uuidList(ids: readonly string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

/**
 * 规则 SQL（只定义这一次）。返回：
 * - `ctes`：以逗号分隔的 CTE 列表（不带前导 `WITH`），最后一个是 `public_membership`；
 * - `select`：产出 `(novel_id, canonical_tag_id, provenance, score, rank)` 的 SELECT。
 *
 * 按书范围的版本（`kind: "novels"`）把 id 列表写进四处过滤；全量版本（`kind: "all"`）不带
 * 任何 IN 列表。其余文本两个版本逐字相同。
 */
function buildDesiredMembershipSql(scope: Scope): Readonly<{ ctes: Prisma.Sql; select: Prisma.Sql }> {
  const ids = scope.kind === "novels" ? uuidList(scope.ids) : null;
  const sourceItemNovelFilter = ids
    ? Prisma.sql`nsi.novel_id IN (${ids})`
    : Prisma.sql`nsi.novel_id IS NOT NULL`;
  const manualNovelFilter = ids ? Prisma.sql`nct.novel_id IN (${ids}) AND` : Prisma.empty;
  const autoNovelFilter = ids ? Prisma.sql`nts.novel_id IN (${ids}) AND` : Prisma.empty;

  const ctes = Prisma.sql`
    target_source_item AS MATERIALIZED (
      SELECT nsi.id, nsi.novel_id, nsi.channel_app_id, nsi.raw_language_scope
      FROM novel_source_item nsi
      WHERE ${sourceItemNovelFilter}
        AND nsi.status = 'linked'
        AND nsi.deleted_at IS NULL
        AND nsi.raw_language_scope IS NOT NULL
    ),
    base_membership AS MATERIALIZED (
      SELECT nct.novel_id, nct.canonical_tag_id, 'manual'::text AS provenance, 0 AS source_rank, NULL::integer AS score
      FROM novel_canonical_tag nct
      JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'
      WHERE ${manualNovelFilter} nct.source = 'manual'
      UNION
      SELECT tsi.novel_id, slm.canonical_tag_id, 'mapped'::text AS provenance, 0 AS source_rank, NULL::integer AS score
      FROM target_source_item tsi
      JOIN channel_app ca ON ca.id = tsi.channel_app_id AND ca.status = 'active'
      JOIN novel_source_item_label nsil
        ON nsil.novel_source_item_id = tsi.id AND nsil.active IS TRUE
      JOIN source_label sl
        ON sl.id = nsil.source_label_id
       AND sl.channel_app_id = tsi.channel_app_id
       AND sl.label_kind = 'series_type'
      JOIN source_label_mapping slm
        ON slm.channel_app_id = tsi.channel_app_id
       AND slm.raw_language_scope COLLATE "C" = tsi.raw_language_scope COLLATE "C"
       AND slm.raw_token COLLATE "C" = sl.external_label_value::text COLLATE "C"
       AND slm.active IS TRUE
      WHERE NOT EXISTS (
          SELECT 1 FROM novel_tag_state nts
          WHERE nts.novel_id = tsi.novel_id AND nts.mode = 'manual'
        )
    ),
    auto_membership AS MATERIALIZED (
      SELECT nct.novel_id, nct.canonical_tag_id, 'auto'::text AS provenance, 1 AS source_rank, nct.score
      FROM novel_tag_state nts
      JOIN novel_canonical_tag nct
        ON nct.novel_id = nts.novel_id
       AND nct.classification_run_id = nts.current_auto_run_id
       AND nct.source = 'auto'
      WHERE ${autoNovelFilter} nts.mode = 'automatic'
    ),
    public_membership AS (
      SELECT * FROM base_membership
      UNION ALL
      SELECT automatic.* FROM auto_membership automatic
      WHERE NOT EXISTS (
        SELECT 1 FROM base_membership mapped
        WHERE mapped.novel_id = automatic.novel_id
          AND mapped.canonical_tag_id = automatic.canonical_tag_id
      )
    )
  `;

  const select = Prisma.sql`
    SELECT membership.novel_id,
           membership.canonical_tag_id,
           membership.provenance,
           membership.score,
           (ROW_NUMBER() OVER (
             PARTITION BY membership.novel_id
             ORDER BY membership.source_rank,
                      CASE WHEN membership.source_rank = 0 THEN ct.sort_order END,
                      CASE WHEN membership.source_rank = 0 THEN ct.slug END,
                      CASE WHEN membership.source_rank = 1 THEN membership.score END DESC,
                      CASE WHEN membership.source_rank = 1 THEN ct.stable_id END,
                      ct.id
           ) - 1)::integer AS rank
    FROM public_membership membership
    JOIN canonical_tag ct
      ON ct.id = membership.canonical_tag_id AND ct.status = 'active'
  `;

  return { ctes, select };
}

/**
 * 迁移 `20261009120000_b38_novel_effective_tag` 里"首次建表"那段 SQL 的来源。
 * 迁移里的文本是本函数输出的逐字快照（空白归一后相等），由静态用例钉住；改规则必须两处同改。
 */
export function buildEffectiveTagFirstBuildSql(): string {
  const { ctes, select } = buildDesiredMembershipSql({ kind: "all" });
  return Prisma.sql`
    INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
    WITH ${ctes}
    ${select}
  `.sql;
}

/** 应有行 vs 表内现有行，只写差异；返回三个计数。`cur` 与 DML 同一条语句，同一个快照。 */
function buildApplySql(scope: Scope): Prisma.Sql {
  const { ctes, select } = buildDesiredMembershipSql(scope);
  const currentFilter = scope.kind === "novels"
    ? Prisma.sql`WHERE existing.novel_id IN (${uuidList(scope.ids)})`
    : Prisma.empty;
  return Prisma.sql`
    WITH ${ctes},
    desired AS MATERIALIZED (${select}),
    cur AS MATERIALIZED (
      SELECT existing.novel_id, existing.canonical_tag_id, existing.provenance, existing.score, existing.rank
      FROM novel_effective_tag existing
      ${currentFilter}
    ),
    del AS (
      DELETE FROM novel_effective_tag target
      USING cur c
      WHERE target.novel_id = c.novel_id
        AND target.canonical_tag_id = c.canonical_tag_id
        AND NOT EXISTS (
          SELECT 1 FROM desired d
          WHERE d.novel_id = c.novel_id AND d.canonical_tag_id = c.canonical_tag_id
        )
      RETURNING 1 AS touched
    ),
    upd AS (
      UPDATE novel_effective_tag target
      SET provenance = d.provenance, score = d.score, rank = d.rank, computed_at = now()
      FROM cur c
      JOIN desired d ON d.novel_id = c.novel_id AND d.canonical_tag_id = c.canonical_tag_id
      WHERE target.novel_id = c.novel_id
        AND target.canonical_tag_id = c.canonical_tag_id
        AND (c.provenance IS DISTINCT FROM d.provenance
          OR c.score IS DISTINCT FROM d.score
          OR c.rank IS DISTINCT FROM d.rank)
      RETURNING 1 AS touched
    ),
    ins AS (
      INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
      SELECT d.novel_id, d.canonical_tag_id, d.provenance, d.score, d.rank
      FROM desired d
      WHERE NOT EXISTS (
        SELECT 1 FROM cur c
        WHERE c.novel_id = d.novel_id AND c.canonical_tag_id = d.canonical_tag_id
      )
      RETURNING 1 AS touched
    )
    SELECT (SELECT count(*) FROM ins)::int AS inserted,
           (SELECT count(*) FROM upd)::int AS updated,
           (SELECT count(*) FROM del)::int AS deleted
  `;
}

function buildCheckSql(limit: number): Prisma.Sql {
  const { ctes, select } = buildDesiredMembershipSql({ kind: "all" });
  return Prisma.sql`
    WITH ${ctes},
    desired AS MATERIALIZED (${select}),
    cur AS MATERIALIZED (
      SELECT existing.novel_id, existing.canonical_tag_id, existing.provenance, existing.score, existing.rank
      FROM novel_effective_tag existing
    ),
    missing AS (
      SELECT d.novel_id, d.canonical_tag_id FROM desired d
      WHERE NOT EXISTS (
        SELECT 1 FROM cur c WHERE c.novel_id = d.novel_id AND c.canonical_tag_id = d.canonical_tag_id
      )
    ),
    extra AS (
      SELECT c.novel_id, c.canonical_tag_id FROM cur c
      WHERE NOT EXISTS (
        SELECT 1 FROM desired d WHERE d.novel_id = c.novel_id AND d.canonical_tag_id = c.canonical_tag_id
      )
    ),
    changed AS (
      SELECT d.novel_id, d.canonical_tag_id
      FROM desired d
      JOIN cur c ON c.novel_id = d.novel_id AND c.canonical_tag_id = d.canonical_tag_id
      WHERE c.provenance IS DISTINCT FROM d.provenance
         OR c.score IS DISTINCT FROM d.score
         OR c.rank IS DISTINCT FROM d.rank
    )
    SELECT 'summary'::text AS kind, NULL::uuid AS novel_id, NULL::uuid AS canonical_tag_id,
           (SELECT count(*) FROM missing)::int AS missing,
           (SELECT count(*) FROM extra)::int AS extra,
           (SELECT count(*) FROM changed)::int AS changed
    UNION ALL
    (SELECT 'missing'::text, novel_id, canonical_tag_id, NULL::int, NULL::int, NULL::int
       FROM missing ORDER BY novel_id, canonical_tag_id LIMIT ${limit}::int)
    UNION ALL
    (SELECT 'extra'::text, novel_id, canonical_tag_id, NULL::int, NULL::int, NULL::int
       FROM extra ORDER BY novel_id, canonical_tag_id LIMIT ${limit}::int)
    UNION ALL
    (SELECT 'changed'::text, novel_id, canonical_tag_id, NULL::int, NULL::int, NULL::int
       FROM changed ORDER BY novel_id, canonical_tag_id LIMIT ${limit}::int)
  `;
}

type ApplyRow = { inserted: number; updated: number; deleted: number };

function toSummary(rows: readonly ApplyRow[]): EffectiveTagChangeSummary {
  const row = rows[0];
  if (!row) throw new Error("effective-tag projection returned no summary row");
  return { inserted: Number(row.inserted), updated: Number(row.updated), deleted: Number(row.deleted) };
}

function add(left: EffectiveTagChangeSummary, right: EffectiveTagChangeSummary): EffectiveTagChangeSummary {
  return {
    inserted: left.inserted + right.inserted,
    updated: left.updated + right.updated,
    deleted: left.deleted + right.deleted,
  };
}

function isTransactionCapable(db: unknown): db is PrismaClient {
  return typeof (db as { $transaction?: unknown }).$transaction === "function";
}

/**
 * 运行时闸（照 CPS `enqueueTagRecompute`）：类型层面挡不住——`Prisma.TransactionClient` 在结构类型下
 * 会照单全收一个完整的 PrismaClient，tsc 不会报错。Prisma 的事务客户端把 `$transaction` / `$connect` /
 * `$disconnect` 这些从类型里 Omit 掉了，运行时对象上也确实没有——拿这个当判别式是可靠的。
 */
function assertInsideTransaction(tx: unknown, caller: string): asserts tx is Prisma.TransactionClient {
  if (isTransactionCapable(tx)) {
    throw new Error(
      `${caller} 必须在事务里调用：传进来的是完整 PrismaClient 而不是事务客户端。`
      + "真源改动与投影重算分家就会出现「真源已改、投影还是旧的」且永久不一致。",
    );
  }
}

/** 共享锁：单本 / 单页重算。多个重算互相兼容，只与全量对账的独占锁互斥。 */
export async function lockEffectiveTagProjectionShared(tx: Prisma.TransactionClient): Promise<void> {
  assertInsideTransaction(tx, "lockEffectiveTagProjectionShared");
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock_shared(
      ${EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK.namespace}::int,
      ${EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK.scope}::int
    )::text AS lock_result
  `);
}

/** 独占锁：全量对账。要在拿任何会被投影写入牵连的行锁之前调用（先咨询锁、后行锁）。 */
export async function lockEffectiveTagProjectionExclusive(tx: Prisma.TransactionClient): Promise<void> {
  assertInsideTransaction(tx, "lockEffectiveTagProjectionExclusive");
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      ${EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK.namespace}::int,
      ${EFFECTIVE_TAG_PROJECTION_ADVISORY_LOCK.scope}::int
    )::text AS lock_result
  `);
}

/**
 * 重算若干本书的归属，只写差异。**必须在调用方改动真源的同一个事务里调用**
 * （传完整 PrismaClient 会抛错）。
 *
 * 顺序：共享咨询锁 → 对这些书的 `novel` 行加 `FOR NO KEY UPDATE`（按 id 排序，见文件头）→ 按块
 * 比对并写差异。书的 id 去重并排序；空列表什么都不做。
 */
export async function refreshEffectiveTagsForNovels(
  tx: Prisma.TransactionClient,
  novelIds: readonly string[],
): Promise<EffectiveTagChangeSummary> {
  assertInsideTransaction(tx, "refreshEffectiveTagsForNovels");
  const ids = [...new Set(novelIds)].sort();
  if (ids.length === 0) return ZERO_SUMMARY;

  await lockEffectiveTagProjectionShared(tx);

  let total = ZERO_SUMMARY;
  for (const chunk of chunkIds(ids, EFFECTIVE_TAG_NOVEL_ID_CHUNK_SIZE)) {
    await tx.$queryRaw(Prisma.sql`
      SELECT n.id FROM novel n
      WHERE n.id IN (${uuidList(chunk)})
      ORDER BY n.id
      FOR NO KEY UPDATE
    `);
    const rows = await tx.$queryRaw<ApplyRow[]>(buildApplySql({ kind: "novels", ids: chunk }));
    total = add(total, toSummary(rows));
  }
  return total;
}

async function reconcileInTransaction(tx: Prisma.TransactionClient): Promise<EffectiveTagChangeSummary> {
  await lockEffectiveTagProjectionExclusive(tx);
  return toSummary(await tx.$queryRaw<ApplyRow[]>(buildApplySql({ kind: "all" })));
}

/**
 * 全量对账：按规则重新算全部归属，与表内比对，只写差异。
 *
 * - 传入事务客户端（后台改映射 / 停用分类）：在调用方事务里执行，对账与真源改动同提交；
 * - 传入完整 PrismaClient（站点地图刷新兜底、运维命令）：自己开一个事务（超时 60 秒）。
 *
 * 开头拿独占咨询锁：所有进行中的单本重算提交之后才取数，对账进行中开始的重算要等。
 */
export async function reconcileAllEffectiveTags(db: Db): Promise<EffectiveTagChangeSummary> {
  if (isTransactionCapable(db)) {
    return db.$transaction((tx) => reconcileInTransaction(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: EFFECTIVE_TAG_RECONCILE_TRANSACTION_TIMEOUT_MS,
      maxWait: 10_000,
    });
  }
  return reconcileInTransaction(db as Prisma.TransactionClient);
}

type CheckRow = {
  kind: "summary" | "missing" | "extra" | "changed";
  novel_id: string | null;
  canonical_tag_id: string | null;
  missing: number | null;
  extra: number | null;
  changed: number | null;
};

async function checkInTransaction(tx: Prisma.TransactionClient): Promise<EffectiveTagCheckResult> {
  await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
  const rows = await tx.$queryRaw<CheckRow[]>(buildCheckSql(EFFECTIVE_TAG_CHECK_SAMPLE_LIMIT));
  const summary = rows.find((row) => row.kind === "summary");
  if (!summary) throw new Error("effective-tag check returned no summary row");
  return {
    missing: Number(summary.missing ?? 0),
    extra: Number(summary.extra ?? 0),
    changed: Number(summary.changed ?? 0),
    samples: rows
      .filter((row) => row.kind !== "summary" && row.novel_id && row.canonical_tag_id)
      .map((row) => ({
        kind: row.kind as EffectiveTagCheckSample["kind"],
        novelId: row.novel_id as string,
        canonicalTagId: row.canonical_tag_id as string,
      })),
  };
}

/**
 * 只读检查：按规则应有的归属 vs 表里的归属，报告差异条数（缺失 / 多余 / 内容不同）和最多 20 条样例。
 * 整个检查是一条语句、一个快照，且事务被标成 READ ONLY（任何误写在数据库层直接失败）。
 */
export async function checkEffectiveTags(db: Db): Promise<EffectiveTagCheckResult> {
  if (isTransactionCapable(db)) {
    return db.$transaction((tx) => checkInTransaction(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: EFFECTIVE_TAG_RECONCILE_TRANSACTION_TIMEOUT_MS,
      maxWait: 10_000,
    });
  }
  return checkInTransaction(db as Prisma.TransactionClient);
}
