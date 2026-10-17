-- 收益看板 v0.6.2：按书归因 + 新增用户国家。只新增：批次表加 4 列（可空 / 带默认值），另建两张统计表；
-- 不改、不删任何已有列与数据。
--
-- 背景（10-17 主控在生产 worker 内只读实测）：
--   - 按书：同一个 `POST /api/Report/GetReport`，维度 ["1","8"]（日期 → 网文|短剧，即具体到书）。书行的
--     dimensionValue 形如 "1_<seriesId>"，seriesId 对应 `novel_source_item.raw_payload->>'seriesId'`
--     （不是 external_book_id）。匹配在 worker 同步时完成——web 读不到 raw_payload。
--   - 国家：`POST /api/Report/GetCountryReport` 对日期行下钻，countryReportType=1（新用户），
--     返回 [{ name: "巴西(BR)", value }]。
--   - 口令维度（7）永不请求：PlotNovel 口令码是 6 位纯数字，禁止落库。
--
-- 写入方：只有 worker（任务 `changdu.revenue_sync.v1`，同一任务里在按日请求之后追加按书与国家请求，
-- 不新增任务类型），在 finalize 事务的 protectedWrite 里落库；web 只读。授权见 infra/postgres/grants.sql。
-- 原始行仍存 revenue_raw_snapshot（dimension 列区分："8" 书行、"1,8" 按书请求的总计行、"country:1" 国家下钻）。

-- ───────────────────────────────────────────────────────────────────────────
-- 1. revenue_sync_batch：按书 / 国家两段各自的结果
-- ───────────────────────────────────────────────────────────────────────────
-- NULL = 本批次没有拉取这一段（早于 v0.6.2 的存量批次，或按日请求已先失败）。只有 completed 的批次
-- 才算覆盖了区间内的按书 / 国家数据；failed 时这一段不写任何统计行，批次整体记 partial_failed。
ALTER TABLE "revenue_sync_batch" ADD COLUMN     "book_row_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "book_status" VARCHAR(32),
ADD COLUMN     "country_row_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "country_status" VARCHAR(32);

-- 取值域与 src/domain/database-statuses.ts 的 REVENUE_BREAKDOWN_STATUSES 同步；允许 NULL（未拉取）。
ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_breakdown_status_check"
    CHECK (
        ("book_status" IS NULL OR "book_status" IN ('completed', 'failed'))
        AND ("country_status" IS NULL OR "country_status" IN ('completed', 'failed'))
    );

ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_breakdown_counts_check"
    CHECK ("book_row_count" >= 0 AND "country_row_count" >= 0);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. revenue_book_daily_stat：按书每日汇总
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_book_daily_stat" (
    "id" UUID NOT NULL,
    "revenue_sync_scope_id" UUID NOT NULL,
    -- 北京时间日期，取所在日期行的 dimensionValue。
    "stat_date" DATE NOT NULL,
    -- 上游书行 dimensionValue 原文，如 "1_20125409"（前缀 1 = projectType 网文）。
    "upstream_series_key" VARCHAR(64) NOT NULL,
    -- 去掉前缀后的 seriesId，对应 novel_source_item.raw_payload->>'seriesId'。
    "upstream_series_id" VARCHAR(32) NOT NULL,
    -- 上游书行 dimensionKey：书名原文（各语种）。未匹配时页面靠它显示。
    "upstream_book_name" VARCHAR(500) NOT NULL,
    -- matched / ambiguous / unmatched，见下方 CHECK。
    "match_status" VARCHAR(32) NOT NULL,
    "novel_source_item_id" UUID,
    -- 匹配到的来源条目所属剧场（MoboReader / PlotNovel …）。ambiguous 但候选同属一个剧场时也填。
    "channel_app_id" UUID,
    -- 以下四列同 revenue_daily_stat：字段缺失 = NULL，"0" = 0。
    "real_dev_num" INTEGER,
    "new_real_dev_num" INTEGER,
    "real_dev_num_rate" DECIMAL(9,6),
    "real_income" DECIMAL(18,4),
    "source_batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_book_daily_stat_pkey" PRIMARY KEY ("id")
);

-- 读服务按「作用域 + 书」取单书按日明细。
CREATE INDEX "revenue_book_daily_stat_scope_series_idx" ON "revenue_book_daily_stat"("revenue_sync_scope_id", "upstream_series_key");

-- 外键列索引（来源条目一侧删除检查 RESTRICT 时用）。
CREATE INDEX "revenue_book_daily_stat_source_item_idx" ON "revenue_book_daily_stat"("novel_source_item_id");

-- 同一作用域同一天同一本书只有一行。
CREATE UNIQUE INDEX "revenue_book_daily_stat_scope_date_series_key" ON "revenue_book_daily_stat"("revenue_sync_scope_id", "stat_date", "upstream_series_key");

-- 取值域与 src/domain/database-statuses.ts 的 REVENUE_BOOK_MATCH_STATUSES 同步。
ALTER TABLE "revenue_book_daily_stat" ADD CONSTRAINT "revenue_book_daily_stat_match_status_check"
    CHECK ("match_status" IN ('matched', 'ambiguous', 'unmatched'));

-- 匹配形状：matched ⇔ 有来源条目；unmatched 时剧场也必须为空。
ALTER TABLE "revenue_book_daily_stat" ADD CONSTRAINT "revenue_book_daily_stat_match_shape_check"
    CHECK (
        ("match_status" = 'matched') = ("novel_source_item_id" IS NOT NULL)
        AND ("match_status" <> 'unmatched' OR "channel_app_id" IS NULL)
    );

-- ───────────────────────────────────────────────────────────────────────────
-- 3. revenue_country_daily_stat：新增用户国家每日分布
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_country_daily_stat" (
    "id" UUID NOT NULL,
    "revenue_sync_scope_id" UUID NOT NULL,
    "stat_date" DATE NOT NULL,
    -- 上游国家名原文，如 "巴西(BR)"（中文国名 + ISO 二字码）。
    "country_label" VARCHAR(128) NOT NULL,
    -- 从 country_label 拆出的 ISO 二字码（大写）；上游名称不是该形状时为 NULL。
    "country_code" VARCHAR(8),
    -- 该国家当天的新用户数（countryReportType=1 的 value）。
    "new_real_dev_num" INTEGER NOT NULL,
    "source_batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_country_daily_stat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "revenue_country_daily_stat_scope_date_label_key" ON "revenue_country_daily_stat"("revenue_sync_scope_id", "stat_date", "country_label");

ALTER TABLE "revenue_country_daily_stat" ADD CONSTRAINT "revenue_country_daily_stat_new_users_check"
    CHECK ("new_real_dev_num" >= 0);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. 外键：与 v0.5.11 四表一致，一律 RESTRICT（统计行长期保留，不随上游对象消失）
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "revenue_book_daily_stat" ADD CONSTRAINT "revenue_book_daily_stat_revenue_sync_scope_id_fkey" FOREIGN KEY ("revenue_sync_scope_id") REFERENCES "revenue_sync_scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_book_daily_stat" ADD CONSTRAINT "revenue_book_daily_stat_source_batch_id_fkey" FOREIGN KEY ("source_batch_id") REFERENCES "revenue_sync_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_book_daily_stat" ADD CONSTRAINT "revenue_book_daily_stat_novel_source_item_id_fkey" FOREIGN KEY ("novel_source_item_id") REFERENCES "novel_source_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_book_daily_stat" ADD CONSTRAINT "revenue_book_daily_stat_channel_app_id_fkey" FOREIGN KEY ("channel_app_id") REFERENCES "channel_app"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_country_daily_stat" ADD CONSTRAINT "revenue_country_daily_stat_revenue_sync_scope_id_fkey" FOREIGN KEY ("revenue_sync_scope_id") REFERENCES "revenue_sync_scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_country_daily_stat" ADD CONSTRAINT "revenue_country_daily_stat_source_batch_id_fkey" FOREIGN KEY ("source_batch_id") REFERENCES "revenue_sync_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
