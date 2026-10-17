-- 收益看板 v0.6.2 追加：国家分布加“激活”口径。只新增两列与两条 CHECK，不改、不删任何已有列与数据；
-- 上一条迁移 20261017120000_revenue_book_country_breakdown 逐字节不动。
--
-- 背景：Owner 10-17 在“国家分布看新增用户”之后追加“激活也看看”。同一个 GetCountryReport，
-- countryReportType=0 即激活口径（主控 10-17 从上游前端包确认：0 激活 / 1 新用户 / 2 收入；收入不取）。
-- 同一任务 `changdu.revenue_sync.v1` 里，对“激活 > 0 的日期”再各发一次 countryReportType=0。
--
-- 为什么要批次标记：激活要能区分“没拉过”和“拉了是 0”。早于本迁移的批次（只拉过新用户）
-- `country_active_included` 为 false，它写下的国家行 `real_dev_num` 为 NULL——页面据此显示“激活未同步”，
-- 而不是 0。授权不变：表级 grants 已覆盖新列（worker 读写、web / analyst 只读）。

-- ───────────────────────────────────────────────────────────────────────────
-- 1. revenue_sync_batch：国家这一段是否连激活一起拉了
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "revenue_sync_batch" ADD COLUMN     "country_active_included" BOOLEAN NOT NULL DEFAULT false;

-- 只有真的跑了国家这一段（country_status 非空）的批次才可能带激活。
ALTER TABLE "revenue_sync_batch" ADD CONSTRAINT "revenue_sync_batch_country_active_shape_check"
    CHECK ("country_active_included" = false OR "country_status" IS NOT NULL);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. revenue_country_daily_stat：该国家当天的激活用户数
-- ───────────────────────────────────────────────────────────────────────────
-- NULL = 写这一行的批次没有拉激活；新代码写入时一律非空（上游没列出的国家记 0）。
ALTER TABLE "revenue_country_daily_stat" ADD COLUMN     "real_dev_num" INTEGER;

ALTER TABLE "revenue_country_daily_stat" ADD CONSTRAINT "revenue_country_daily_stat_active_users_check"
    CHECK ("real_dev_num" IS NULL OR "real_dev_num" >= 0);
