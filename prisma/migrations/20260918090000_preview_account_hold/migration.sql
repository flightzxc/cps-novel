-- Preview account hold (Owner decision 2026-09-18, 决策 2：Preview 账号级确定性故障刹车).
--
-- 2026-09-14 事故的第二半。同一个解不开的凭据在同一小时里烧掉了两条链路：
-- 推广领取链路事后补了任务级 system hold（worker/handlers/promo-link-claim-system-hold.ts），
-- 试读链路什么都没补，而且它比推广链路更脆——自动链路是「一本书一张单条目任务」
-- （worker/handlers/novel-materialize.ts），任务级 hold 对它等于没有：79,183 张任务
-- 每张都是"第一次也是最后一次"失败，halt 谁都拦不住下一张。
--
-- 所以刹车必须挂在**账号**上，而不是任务上：credential 能不能解密是
-- `channel_account_id` 的属性（src/lib/credentials/claim-readiness.ts 的
-- `DETERMINISTIC_CREDENTIAL_FAILURE_CODES` 就是按这个口径定义的），对该账号的
-- 每一张任务同真同假。一行 active hold 之后，该账号的试读工作停止被领取，
-- 条目原样留在 pending（不 requeue、不烧终态、不改任何 item 状态），
-- 等凭据修好后由 scripts/preview-account-hold.ts --release 放行。
--
-- 粒度：**账号 × 业务面（scope）**。
-- 「凭据能不能解密」确实是整个账号的属性，但一行 hold 实际**挡住的是哪条流水线**
-- 必须写清楚，否则表名说的是「账号被 hold」、行为却只停了试读，语义与命名对不上。
-- 本轮只有试读链路接了这道闸（`channel_sync` 家族今天恰好只有
-- `moboreader.preview_refresh.v1` 一个任务类型），所以 scope 的取值域现在就一个
-- `'preview'`，并由 CHECK 钉死：将来推广领取链路若要复用，是加一个取值 + 一处
-- 接线的增量，而不是"这张表一直暗示自己管全业务、其实只管一条线"。
-- 别的渠道账号完全不受影响，更不是 channel 级全局暂停。
CREATE TABLE "channel_account_hold" (
    "id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    -- 这行 hold 挡住的业务面。取值域的单一真源是
    -- `CHANNEL_ACCOUNT_HOLD_SCOPES`（src/lib/tasks/account-hold.ts），下面的
    -- CHECK 是它在数据库侧的镜像——加取值必须同时改两处。
    "scope" VARCHAR(32) NOT NULL,
    -- 触发本次 hold 的确定性失败码，取值域是 DETERMINISTIC_CREDENTIAL_FAILURE_CODES。
    -- 不在这里加 CHECK：该清单是 TypeScript 侧的单一真源，抄一份到数据库只会
    -- 多出一个需要同步、且迟早跑偏的第二真源。
    "reason_code" VARCHAR(64) NOT NULL,
    -- 触发时该账号那条 active 凭据的 id（可能已不存在/已被替换，故不设 FK）。
    -- 解除时用来说明"当时坏的是哪一条、现在是不是同一条"。
    "credential_id" UUID,
    "triggering_task_id" UUID,
    "triggering_item_id" UUID,
    "held_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    "released_by" VARCHAR(160),
    "release_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "channel_account_hold_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "channel_account_hold" ADD CONSTRAINT "channel_account_hold_channel_account_id_fkey"
    FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 每个账号的每个业务面至多一条未解除的 hold。这是 worker 侧
-- `INSERT ... ON CONFLICT DO NOTHING` 幂等性的依据：两个 worker 副本同时踩到
-- 同一个坏凭据，第二条插入被这个索引挡下，不会写出两条 active hold，
-- 也不必先查后插（那才是真正的竞态）。
CREATE UNIQUE INDEX "channel_account_hold_active_uidx"
    ON "channel_account_hold"("channel_account_id", "scope") WHERE "released_at" IS NULL;

-- 历史查询（这个账号的这条业务线被 hold 过几次、分别多久）。
CREATE INDEX "channel_account_hold_history_idx"
    ON "channel_account_hold"("channel_account_id", "scope", "held_at");

-- scope 取值域，与 CHANNEL_ACCOUNT_HOLD_SCOPES 同步。
ALTER TABLE "channel_account_hold" ADD CONSTRAINT "channel_account_hold_scope_check"
    CHECK ("scope" IN ('preview'));

-- 解除必须留下责任人。没有这条约束，一次 UPDATE 漏写 released_by 就能把
-- "谁放行的"这个问题永久变成无解。
ALTER TABLE "channel_account_hold" ADD CONSTRAINT "channel_account_hold_release_shape_check"
    CHECK (
        ("released_at" IS NULL AND "released_by" IS NULL)
        OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL)
    );
