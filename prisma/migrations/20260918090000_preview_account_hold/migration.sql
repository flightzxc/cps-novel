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
-- 粒度刻意只到账号：别的渠道账号完全不受影响，更不是 channel 级全局暂停。
CREATE TABLE "channel_account_hold" (
    "id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
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

-- 每个账号至多一条未解除的 hold。这是 worker 侧 `INSERT ... ON CONFLICT DO NOTHING`
-- 幂等性的依据：两个 worker 副本同时踩到同一个坏凭据，第二条插入被这个索引挡下，
-- 不会写出两条 active hold，也不必先查后插（那才是真正的竞态）。
CREATE UNIQUE INDEX "channel_account_hold_active_uidx"
    ON "channel_account_hold"("channel_account_id") WHERE "released_at" IS NULL;

-- 历史查询（这个账号被 hold 过几次、分别多久）。
CREATE INDEX "channel_account_hold_history_idx"
    ON "channel_account_hold"("channel_account_id", "held_at");

-- 解除必须留下责任人。没有这条约束，一次 UPDATE 漏写 released_by 就能把
-- "谁放行的"这个问题永久变成无解。
ALTER TABLE "channel_account_hold" ADD CONSTRAINT "channel_account_hold_release_shape_check"
    CHECK (
        ("released_at" IS NULL AND "released_by" IS NULL)
        OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL)
    );
