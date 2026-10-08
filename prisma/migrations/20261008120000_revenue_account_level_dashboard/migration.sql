-- 收益看板（账号级每日汇总）：四张新表，只新增，不改任何旧表。
--
-- 背景：海阅与 CPS 短剧共用同一个畅读上游账号。上游收益接口
-- `POST /api/Report/GetReport` 靠请求体里的 `projectType` 区分网文(1)/短剧(2)，
-- **不带 projectType 时上游返回网文+短剧合计**（已在生产只读实测证实）。所以海阅
-- 自建看板，所有请求固定带 `projectType = 1`，数据按「渠道账号 × projectType」
-- 作用域落库，不会与 CPS 短剧的收益混在一起。
--
-- 设计依据：docs/architecture/candidate-v0.2.1/novel-v1-logical-data-model-v0.2.1.md §2.16
-- （收益五表；本期不建 RevenueAttributionSnapshot——按书/按推广码的拆分上游暂不支持，
--  GetMDetailsReport / GetMToTalReport 对网文无效，已实测）。
--
-- 写入方：只有 worker（任务 `changdu.revenue_sync.v1`，经 `protectedWrite` 在带
-- 租约围栏的 finalize 事务里落库）；web 只读（看板页）。授权见 infra/postgres/grants.sql。
--
-- 金额一律 numeric（Prisma Decimal），禁止浮点；主键 uuid 由 Prisma 客户端生成
-- （与仓库其他表一致，列上不带数据库 DEFAULT）。

-- ───────────────────────────────────────────────────────────────────────────
-- 1. revenue_sync_scope：收益作用域（一个渠道账号 × 一个 projectType）
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_sync_scope" (
    "id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    -- 上游 projectType：1=网文，2=短剧。本期只写 1；用 smallint 参数化，将来要接别的
    -- 业务线不用改表。
    "project_type" SMALLINT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_sync_scope_pkey" PRIMARY KEY ("id")
);

-- 一个账号在一个业务线上只有一个作用域；worker 用 upsert 取得/创建它。
CREATE UNIQUE INDEX "revenue_sync_scope_account_project_key"
    ON "revenue_sync_scope"("channel_account_id", "project_type");

ALTER TABLE "revenue_sync_scope" ADD CONSTRAINT "revenue_sync_scope_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 取值域与 src/domain/database-statuses.ts 的 REVENUE_SCOPE_STATUSES 同步。
ALTER TABLE "revenue_sync_scope" ADD CONSTRAINT "revenue_sync_scope_status_check"
    CHECK ("status" IN ('active', 'disabled'));

ALTER TABLE "revenue_sync_scope" ADD CONSTRAINT "revenue_sync_scope_project_type_check"
    CHECK ("project_type" > 0);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. revenue_sync_batch：一次同步批次（终态一次写入）
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_sync_batch" (
    "id" UUID NOT NULL,
    "revenue_sync_scope_id" UUID NOT NULL,
    -- 触发本批次的 generic_task。任务头按 365 天保留期清理时置 NULL（批次长期保留），
    -- 所以是 ON DELETE SET NULL。
    "generic_task_id" UUID,
    "begin_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    -- sha256(scopeId|projectType|begin|end|genericTaskId)：同一任务重试幂等（upsert）；
    -- 不同任务重拉同一区间是允许的（上游会回补近几天），指纹自然不同。
    "request_fingerprint" VARCHAR(96) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "detail_row_count" INTEGER NOT NULL DEFAULT 0,
    "total_row_count" INTEGER NOT NULL DEFAULT 0,
    -- 明细合计 vs 总计行的对账结论；还没对账（pending/running/失败在拉取前）为 NULL。
    "reconciliation_status" VARCHAR(32),
    -- 当时用的是哪一条凭证。故意不建 FK：凭证可能已被替换；这里只回答"当时用的是哪一条"。
    "credential_id" UUID,
    -- 取自 channel_account_credential.fingerprint_prefix 的已有列，不在这里自己算 token 哈希。
    "credential_fingerprint_prefix" VARCHAR(16),
    -- 凭证 JWT 里的 StarId（达人 ID）。不是密钥，是"这次查的是哪个达人"的口径证据
    -- （CPS 7 月"87 倍事故"：聚合账号凭证会把整个主体的收益混进来）。
    "upstream_star_id" VARCHAR(32),
    "error_code" VARCHAR(64),
    "error_message" VARCHAR(500),
    -- 后台操作人标识，宽度与 operation_audit.actor_id 一致。
    "requested_by" VARCHAR(128) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_sync_batch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "revenue_sync_batch_request_fingerprint_key"
    ON "revenue_sync_batch"("request_fingerprint");

-- 读服务按「作用域 + 区间」判定某天是否被某个成功批次覆盖。
CREATE INDEX "revenue_sync_batch_scope_begin_idx"
    ON "revenue_sync_batch"("revenue_sync_scope_id", "begin_date");

-- 看板「最近 20 个批次」。
CREATE INDEX "revenue_sync_batch_created_idx"
    ON "revenue_sync_batch"("created_at");

ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_revenue_sync_scope_id_fkey"
    FOREIGN KEY ("revenue_sync_scope_id") REFERENCES "revenue_sync_scope"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_generic_task_id_fkey"
    FOREIGN KEY ("generic_task_id") REFERENCES "generic_task"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 取值域与 src/domain/database-statuses.ts 的 REVENUE_BATCH_STATUSES 同步。
ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'partial_failed', 'failed'));

-- 取值域与 REVENUE_RECONCILIATION_STATUSES 同步；允许 NULL（尚未对账）。
ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_reconciliation_status_check"
    CHECK ("reconciliation_status" IS NULL OR "reconciliation_status" IN ('matched', 'mismatched', 'not_applicable'));

ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_date_range_check"
    CHECK ("begin_date" <= "end_date");

ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_counts_check"
    CHECK ("request_count" >= 0 AND "detail_row_count" >= 0 AND "total_row_count" >= 0);

-- 终态形状：已进入终态的批次必须有结束时间；失败 / 部分失败必须带错误码——
-- 页面「同步记录」靠它给运营看原因，一次漏写就会变成"失败但不知道为什么"。
ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_terminal_shape_check"
    CHECK (
        ("status" IN ('pending', 'running') OR "finished_at" IS NOT NULL)
        AND ("status" NOT IN ('failed', 'partial_failed') OR "error_code" IS NOT NULL)
    );

-- ───────────────────────────────────────────────────────────────────────────
-- 3. revenue_raw_snapshot：上游原始行存档（写入时不加工）
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_raw_snapshot" (
    "id" UUID NOT NULL,
    -- 指向最后一次写入这一行的批次（同一行被后续批次重拉时 upsert 更新它）。
    "sync_batch_id" UUID NOT NULL,
    "project_type" SMALLINT NOT NULL,
    -- 请求的 dimensions 值（本期恒为 "1"）。
    "dimension" VARCHAR(32) NOT NULL,
    "dimension_key" VARCHAR(64) NOT NULL,
    "dimension_value" VARCHAR(128),
    -- 上游总计行（isTotal=1/true/"1"）。总计行与明细行同表存档，靠这一列区分。
    "is_total" BOOLEAN NOT NULL DEFAULT false,
    "real_dev_num" INTEGER,
    "new_real_dev_num" INTEGER,
    -- 新用户比例，小数形式（"28.27%" → 0.2827）；字段缺失为 NULL，"0" 为 0。
    "real_dev_num_rate" DECIMAL(9, 6),
    "real_income" DECIMAL(18, 4),
    "real_distrib_income" DECIMAL(18, 4),
    "real_profit" DECIMAL(18, 4),
    -- 上游整行（约 49 个字段）原样存，不加工。
    "raw_payload" JSONB NOT NULL,
    -- sha256(scopeId|projectType|dimension|dimensionKey|'detail' 或 'total:'+begin+'~'+end)。
    "dedupe_key" VARCHAR(96) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_raw_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "revenue_raw_snapshot_dedupe_key_key"
    ON "revenue_raw_snapshot"("dedupe_key");

CREATE INDEX "revenue_raw_snapshot_project_dimension_key_idx"
    ON "revenue_raw_snapshot"("project_type", "dimension_key");

CREATE INDEX "revenue_raw_snapshot_batch_total_idx"
    ON "revenue_raw_snapshot"("sync_batch_id", "is_total");

ALTER TABLE "revenue_raw_snapshot" ADD CONSTRAINT "revenue_raw_snapshot_sync_batch_id_fkey"
    FOREIGN KEY ("sync_batch_id") REFERENCES "revenue_sync_batch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_raw_snapshot" ADD CONSTRAINT "revenue_raw_snapshot_project_type_check"
    CHECK ("project_type" > 0);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. revenue_daily_stat：按日汇总（看板读这张）
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE "revenue_daily_stat" (
    "id" UUID NOT NULL,
    "revenue_sync_scope_id" UUID NOT NULL,
    -- 北京时间（Asia/Shanghai）日期，直接取上游 dimensionValue（YYYY-MM-DD）。
    "stat_date" DATE NOT NULL,
    -- 以下四列均可空：字段缺失 = NULL，"0" = 0；两者在页面上含义不同，不得互相替代。
    "real_dev_num" INTEGER,
    "new_real_dev_num" INTEGER,
    "real_dev_num_rate" DECIMAL(9, 6),
    "real_income" DECIMAL(18, 4),
    -- 产生这一天当前数值的批次（后续批次回补同一天时被覆盖为后者）。
    "source_batch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "revenue_daily_stat_pkey" PRIMARY KEY ("id")
);

-- 同一作用域同一天只有一行；worker 用 upsert（含重复同步幂等）。
CREATE UNIQUE INDEX "revenue_daily_stat_scope_date_key"
    ON "revenue_daily_stat"("revenue_sync_scope_id", "stat_date");

ALTER TABLE "revenue_daily_stat" ADD CONSTRAINT "revenue_daily_stat_revenue_sync_scope_id_fkey"
    FOREIGN KEY ("revenue_sync_scope_id") REFERENCES "revenue_sync_scope"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "revenue_daily_stat" ADD CONSTRAINT "revenue_daily_stat_source_batch_id_fkey"
    FOREIGN KEY ("source_batch_id") REFERENCES "revenue_sync_batch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
