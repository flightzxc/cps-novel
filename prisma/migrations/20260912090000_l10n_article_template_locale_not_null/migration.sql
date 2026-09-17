-- L10N P3: ArticleTemplate.locale 非空化（矩阵 #5，施工提示词
-- 施工提示词_Sonnet_L10N_P3_模板locale非空化与15语模板资产_2026-09-10.md §1.A）。
--
-- CPS parity: `3a76877:prisma/schema.prisma:518` — `ArticleTemplate.locale` 是
-- `String @default("en")`（非空，无通用模板语义）。本仓迁移前是 `String?`
-- （无默认值），配合 `service.ts` 的 `{locale:null}` OR 通配实现了一个 CPS 没有的
-- "全部语种"第三态。本迁移把它收口到 CPS 同型：非空 + 默认 'en'。
--
-- 施工首步对目标库核实过一次 `SELECT count(*) FROM article_template WHERE
-- locale IS NULL`（X8 `cps-novel-x8-local-postgres-1`，2026-09-10，结果为 0——
-- 该表当前总行数也是 0，`ensureDefaultArticleTemplate` 从未在这套库上跑过）。
-- 下面这行 UPDATE 因此在 X8 上是零行回填，但对未来任何已有孤儿 NULL 行的库
-- （生产库未核实，以实查为准）仍是必要的、幂等的安全网：不依赖"今天是 0"
-- 这一个事实来省略防御性回填。
UPDATE "article_template" SET "locale" = 'en' WHERE "locale" IS NULL;

ALTER TABLE "article_template"
  ALTER COLUMN "locale" SET DEFAULT 'en',
  ALTER COLUMN "locale" SET NOT NULL;
