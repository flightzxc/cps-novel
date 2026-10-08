-- B-38（方案_B38根治_公开列表改数据库分页_v0.5.13_2026-10-09.md §4.3 / 附录 B）：
-- 新增「小说分类归属」派生表 novel_effective_tag（CPS drama_effective_tag 平移），
-- 以及公开列表排序用的部分索引 article_public_list_order_idx。只新增，不改任何旧表、旧数据。
--
-- 表里存什么：每行 = "某本书属于某个启用中的分类"，外加来源（manual / mapped / auto）、
-- 自动标签分数（仅 auto 行有值）、本书标签内的显示顺序 rank（从 0 起）。规则与改造前
-- src/lib/site/public-taxonomy.ts 的现场计算逐字同语义，唯一实现见
-- src/server/tagging/effective-tag-projection.ts（全仓库唯一允许写这张表的文件）。
-- 自动标签开关不写进表里：读取时按当时的开关决定 provenance = 'auto' 的行算不算。
--
-- 首次建表（B38_FIRST_BUILD 段）：与本迁移同事务，一次把全部归属算好写进去，上线第一个请求起
-- 表就是满的，不存在"表已上线但还是空的"这段窗口（CPS 2026-08-26 吃过这个亏）。迁移在维护模式
-- 里执行（所有服务已停，没有并发写入），不需要咨询锁。B38_FIRST_BUILD 段是
-- buildEffectiveTagFirstBuildSql()（src/server/tagging/effective-tag-projection.ts）输出的
-- 逐字快照，空白归一后必须相等，tests/backend/tagging/effective-tag-first-build-snapshot.test.ts
-- 钉住；真实库用例把这一段单独执行一遍，与 reconcileAllEffectiveTags 的结果逐行比对。
-- 改规则必须两处同改。
--
-- 物理约束里 Prisma 表达不了的两个 CHECK 与一个部分索引只存在于本迁移 SQL（schema.prisma 的
-- 模型注释里登记，docs/governance/database-governance.md §5 登记）：
--   novel_effective_tag_provenance_check  CHECK (provenance IN ('manual','mapped','auto'))
--   novel_effective_tag_rank_check        CHECK (rank >= 0)
--   article_public_list_order_idx         (locale, published_at DESC, id)
--                                         WHERE status = 'published' AND deleted_at IS NULL
--                                           AND article_type = 'novel_article'
--
-- 不用 CREATE INDEX CONCURRENTLY：迁移在 Prisma 事务里执行，CONCURRENTLY 不能在事务块中运行；
-- release.sh 的 migrate-approved 在维护模式（应用已停）下执行。
--
-- 回滚：把镜像回滚到 v0.5.12 即可。新表和新索引留在库里无害，旧代码完全不读它们，不需要反向迁移。
-- 回滚后再前滚：回滚期间改过的标签在表里是旧的，前滚后先跑只读检查
-- （scripts/ops/effective-tag-projection.ts check），差异不为 0 再执行一次对账。

-- ───────────────────────────────────────────────────────────────────────────
-- 1. novel_effective_tag
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "novel_effective_tag" (
    "novel_id" UUID NOT NULL,
    "canonical_tag_id" UUID NOT NULL,
    -- manual | mapped | auto（同一分类映射与自动都有时记 mapped）
    "provenance" VARCHAR(16) NOT NULL,
    -- 仅 auto 行有值，取自 novel_canonical_tag.score
    "score" INTEGER,
    -- 本书标签内的显示顺序，从 0 起：人工/映射段按分类排序号与 slug，自动段按分数降序与 stable_id
    "rank" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_effective_tag_pkey" PRIMARY KEY ("novel_id","canonical_tag_id")
);

CREATE INDEX "novel_effective_tag_tag_idx" ON "novel_effective_tag"("canonical_tag_id");

CREATE INDEX "novel_effective_tag_rank_idx" ON "novel_effective_tag"("novel_id", "rank");

-- 书或分类被硬删时归属行跟着走（CASCADE）；软删除/停用不删行，由规则 SQL 与读取侧处理。
ALTER TABLE "novel_effective_tag"
    ADD CONSTRAINT "novel_effective_tag_novel_id_fkey"
    FOREIGN KEY ("novel_id") REFERENCES "novel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "novel_effective_tag"
    ADD CONSTRAINT "novel_effective_tag_canonical_tag_id_fkey"
    FOREIGN KEY ("canonical_tag_id") REFERENCES "canonical_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "novel_effective_tag"
    ADD CONSTRAINT "novel_effective_tag_provenance_check"
    CHECK ("provenance" IN ('manual', 'mapped', 'auto'));

ALTER TABLE "novel_effective_tag"
    ADD CONSTRAINT "novel_effective_tag_rank_check"
    CHECK ("rank" >= 0);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. 公开列表排序部分索引（第二段读取侧使用；本机实测使首屏从 20ms 级降到 0.05ms 级）
-- ───────────────────────────────────────────────────────────────────────────
CREATE INDEX "article_public_list_order_idx"
    ON "article" ("locale", "published_at" DESC, "id")
    WHERE "status" = 'published' AND "deleted_at" IS NULL AND "article_type" = 'novel_article';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. 首次建表
-- ───────────────────────────────────────────────────────────────────────────
-- B38_FIRST_BUILD_BEGIN
INSERT INTO novel_effective_tag (novel_id, canonical_tag_id, provenance, score, rank)
WITH 
target_source_item AS MATERIALIZED (
  SELECT nsi.id, nsi.novel_id, nsi.channel_app_id, nsi.raw_language_scope
  FROM novel_source_item nsi
  WHERE nsi.novel_id IS NOT NULL
    AND nsi.status = 'linked'
    AND nsi.deleted_at IS NULL
    AND nsi.raw_language_scope IS NOT NULL
),
base_membership AS MATERIALIZED (
  SELECT nct.novel_id, nct.canonical_tag_id, 'manual'::text AS provenance, 0 AS source_rank, NULL::integer AS score
  FROM novel_canonical_tag nct
  JOIN novel_tag_state nts ON nts.novel_id = nct.novel_id AND nts.mode = 'manual'
  WHERE  nct.source = 'manual'
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
  WHERE  nts.mode = 'automatic'
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
;
-- B38_FIRST_BUILD_END
