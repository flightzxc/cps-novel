import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { releasePromoClaimShardsForAccount } from "@/lib/tasks/promo-claim-release";
import { PROMO_CLAIM_LIFECYCLE_DEFAULTS, type PromoClaimLifecycleConfig } from "@/lib/tasks/promo-claim-lifecycle";

/**
 * 领推广链接生命周期正式修复第 2 阶段第 3 步——`releasePromoClaimShardsForAccount`
 * （`src/lib/tasks/promo-claim-release.ts`）本质上是"读几条 SQL、判定、写几条
 * SQL"的事务体，真正端到端的场景验证（含真实查询计划、并发、
 * `scheduler_app` 角色）需要一次性 Postgres 容器，见
 * `tests/integration/tasks/promo-claim-release-postgres.test.ts` 与
 * `scripts/run-promo-claim-release-postgres-verification.sh`。
 *
 * 但本轮施工环境 Docker 不可用（Owner 明确要求本轮不得启动 Docker——本地 X8
 * 栈会连带拉起、其 worker 持有与预生产共用的渠道令牌）。这个文件用一个手写的
 * 假 `Prisma.TransactionClient`（按 SQL 文本内容路由，不是按调用顺序计数，
 * 更不脆弱）在不接触任何数据库的前提下，把 D4 前置检查 / 凭据判定 / 批准
 * 时钟 / promo 双闸这四段判定各自的分支单独跑一遍——协调者要求"先做"的四项
 * 变异验证（b/c/d/e）都在这里完成；真正的咨询锁语义（变异 a）离不开真实
 * Postgres 并发,留给上面那个集成测试文件,本文件不冒充覆盖它。
 *
 * 假 `tx` 的路由方式：`$queryRaw` 收到的 `Prisma.Sql` 对象有一个 `.text`
 * getter（parameterized SQL 文本），按内容里的独有子串匹配到具体是哪一条
 * 查询——比按调用顺序数第几次调用更不脆弱，源码里语句顺序稍微调整也不会
 * 误判。凡是场景里没有显式提供响应的查询，一旦被访问就直接 throw，这本身就是
 * 一种断言："这条分支不应该被走到"。
 */

type FakeRow = Record<string, unknown>;

interface FakeTxHandle {
  readonly tx: Prisma.TransactionClient;
  readonly genericTaskUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  readonly operationAudits: Array<Record<string, unknown>>;
}

function textOf(query: unknown): string {
  const withText = query as { text?: string; strings?: readonly string[] };
  return withText.text ?? withText.strings?.join("") ?? String(query);
}

/**
 * `rules` 按顺序匹配：第一个 `match(text)` 为真的规则决定返回值。
 * 规则返回 `undefined` 视为"这条 SQL 没有配置响应"，触发 `$queryRaw` 抛错——
 * 用来断言某条分支的查询真的没有被执行到（例如 promo 双闸未通过时，
 * `selectNextReleasableShard` 根本不应该被调用）。
 */
function makeFakeTx(rules: ReadonlyArray<{ match: (text: string) => boolean; rows: FakeRow[] }>): FakeTxHandle {
  const genericTaskUpdates: FakeTxHandle["genericTaskUpdates"] = [];
  const operationAudits: FakeTxHandle["operationAudits"] = [];

  const tx = {
    $queryRaw: async (query: unknown) => {
      const text = textOf(query);
      const rule = rules.find((candidate) => candidate.match(text));
      if (!rule) {
        throw new Error(`promo-claim-release-branches fake tx: no rule matched query text:\n${text}`);
      }
      return rule.rows;
    },
    genericTask: {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        genericTaskUpdates.push(args);
        return { id: args.where.id, ...args.data };
      },
    },
    operationAudit: {
      create: async (args: { data: Record<string, unknown> }) => {
        operationAudits.push(args.data);
        return { id: 1n, ...args.data };
      },
    },
  };

  return { tx: tx as unknown as Prisma.TransactionClient, genericTaskUpdates, operationAudits };
}

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const BATCH_ID = "22222222-2222-4222-8222-222222222222";
const SHARD_ID = "33333333-3333-4333-8333-333333333333";

const ENABLED_CONFIG: PromoClaimLifecycleConfig = Object.freeze({
  enabled: true,
  approvalTtlMinutes: PROMO_CLAIM_LIFECYCLE_DEFAULTS.approvalTtlMinutes,
  shardWindowMinutes: 90,
  shardSizeMin: PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardSizeMin,
  shardSizeMax: PROMO_CLAIM_LIFECYCLE_DEFAULTS.shardSizeMax,
  credentialSafetyMarginMinutes: 30,
  deadlineGraceMinutes: PROMO_CLAIM_LIFECYCLE_DEFAULTS.deadlineGraceMinutes,
});

const PROMO_ENABLED_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  FEATURE_PROMO_LINK_CLAIM: "true",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "true",
};

const NOW = new Date("2026-09-23T12:00:00.000Z");

// 除"是否存在活跃分片/旧路径任务"外，四个场景共用同一套"没有活跃分片、没有
// 旧路径占用"的准入前置规则——每个场景在此基础上追加自己关心的那条规则。
function admissionFreeRules(): Array<{ match: (text: string) => boolean; rows: FakeRow[] }> {
  return [
    { match: (t) => t.includes("pg_advisory_xact_lock"), rows: [{ locked: 1 }] },
    // 该账号当前没有任何处于 pending/processing 的生命周期分片。
    { match: (t) => t.includes("ORDER BY created_at ASC"), rows: [] },
    // D6 旧路径占用检查：count = 0。
    { match: (t) => t.includes("AS count FROM generic_task"), rows: [{ count: 0 }] },
    // 开关已开：不需要 hold，但仍会跑一次"解除 lifecycle_disabled"扫描，返回空。
    // findHeldBatches：既用于扫描 lifecycle_disabled，也用于扫描
    // credential_not_ready（reasonCode 是绑定参数，不是拼进 SQL 文本的字面量，
    // 两种调用的查询文本完全一样）——这里统一让它查不到任何被暂停的批次。
    // 匹配 "SELECT b.id, b.result"（只有这一条查询恰好是这两列、这个顺序），
    // 不能只匹配 "result->'taskControl'->>'reasonCode' ="——
    // selectNextReleasableShard 的查询里也有同一个子串（表别名是 s. 不是
    // b.，但子串匹配不看别名），曾经因为这个过宽的匹配把
    // selectNextReleasableShard 自己的响应规则"抢跑"掉,导致候选分片查询被
    // 误判成"没有被暂停的批次"而返回空数组。
    { match: (t) => t.includes("SELECT b.id, b.result\n"), rows: [] },
  ];
}

function shardRow(overrides: Partial<{ resultTaskControl: Record<string, unknown> | null; params: Record<string, unknown> }>) {
  return {
    id: SHARD_ID,
    parent_task_id: BATCH_ID,
    status: "disabled",
    params: { lifecycleVersion: 1, lifecycleRole: "shard", shardIndex: 0, releaseCount: 0, missedDeadlineCount: 0, ...overrides.params },
    result: overrides.resultTaskControl === null ? {} : { taskControl: overrides.resultTaskControl ?? { kind: "awaiting_release", source: "system", at: "2026-09-01T00:00:00.000Z" } },
  };
}

function selectNextRow(shard: ReturnType<typeof shardRow>, batchParams: Record<string, unknown>) {
  return {
    id: shard.id, parent_task_id: shard.parent_task_id, status: shard.status, params: shard.params, result: shard.result,
    batch_id: BATCH_ID, batch_status: "completed", batch_params: batchParams, batch_result: {},
  };
}

describe("promo-claim-release: releasePromoClaimShardsForAccount 分支（假 tx，无真实数据库）", () => {
  it("对照组：全部条件满足时真的放行（证明假 tx 本身可用）", async () => {
    const shard = shardRow({});
    const batchParams = { approvedAt: "2026-09-20T00:00:00.000Z", approvalValidUntil: "2026-09-21T00:00:00.000Z", firstReleasedAt: "2026-09-20T01:00:00.000Z" };
    const { tx, genericTaskUpdates } = makeFakeTx([
      ...admissionFreeRules(),
      { match: (t) => t.includes("JOIN generic_task b ON b.id = s.parent_task_id"), rows: [selectNextRow(shard, batchParams)] },
      { match: (t) => t.includes("FROM channel_account_credential"), rows: [{ id: "cred-1", status: "active", last_validated_at: new Date("2026-09-22T00:00:00.000Z"), expires_at: new Date("2027-01-01T00:00:00.000Z"), created_at: new Date("2026-09-01T00:00:00.000Z") }] },
    ]);
    const outcome = await releasePromoClaimShardsForAccount(tx, ACCOUNT_ID, ENABLED_CONFIG, NOW, PROMO_ENABLED_ENV);
    expect(outcome.action).toBe("released");
    const shardUpdate = genericTaskUpdates.find((u) => u.where.id === SHARD_ID);
    expect(shardUpdate?.data.status).toBe("pending");
  });

  describe("(b) D4 前置检查：错过截止时间后重新放行前，已有意图记录的条目必须挡住重放", () => {
    function buildRetryScenario() {
      const shard = shardRow({ resultTaskControl: { kind: "system_hold", source: "system", at: "2026-09-22T00:00:00.000Z", reasonCode: "deadline_missed" }, params: { missedDeadlineCount: 1 } });
      const batchParams = { approvedAt: "2026-09-20T00:00:00.000Z", approvalValidUntil: "2026-09-21T00:00:00.000Z", firstReleasedAt: "2026-09-20T01:00:00.000Z" };
      return makeFakeTx([
        ...admissionFreeRules(),
        { match: (t) => t.includes("JOIN generic_task b ON b.id = s.parent_task_id"), rows: [selectNextRow(shard, batchParams)] },
        { match: (t) => t.includes("FROM channel_account_credential"), rows: [{ id: "cred-1", status: "active", last_validated_at: new Date("2026-09-22T00:00:00.000Z"), expires_at: new Date("2027-01-01T00:00:00.000Z"), created_at: new Date("2026-09-01T00:00:00.000Z") }] },
        // D4 前置检查命中：该分片存在一个不安全的 pending 条目。
        { match: (t) => t.includes("side_effect_intent se"), rows: [{ unsafe: true }] },
      ]);
    }

    it("按现有代码：不自动重放，转 deadline_missed_twice（reason=unsafe_to_auto_retry）", async () => {
      const { tx, genericTaskUpdates } = buildRetryScenario();
      const outcome = await releasePromoClaimShardsForAccount(tx, ACCOUNT_ID, ENABLED_CONFIG, NOW, PROMO_ENABLED_ENV);
      expect(outcome.action).toBe("deadline_missed_twice");
      expect(outcome.detail).toMatchObject({ reason: "unsafe_to_auto_retry" });
      const shardUpdate = genericTaskUpdates.find((u) => u.where.id === SHARD_ID);
      expect(shardUpdate?.data.status).toBe("disabled");
    });
  });

  describe("(c) 凭据判定：缺少校验（lastValidatedAt 为空）必须挡住放行", () => {
    function buildScenario() {
      const shard = shardRow({});
      const batchParams = { approvedAt: "2026-09-20T00:00:00.000Z", approvalValidUntil: "2026-09-21T00:00:00.000Z", firstReleasedAt: "2026-09-20T01:00:00.000Z" };
      return makeFakeTx([
        ...admissionFreeRules(),
        { match: (t) => t.includes("JOIN generic_task b ON b.id = s.parent_task_id"), rows: [selectNextRow(shard, batchParams)] },
        // 凭据存在、状态 active，但从未校验过（last_validated_at = null）。
        { match: (t) => t.includes("FROM channel_account_credential"), rows: [{ id: "cred-1", status: "active", last_validated_at: null, expires_at: new Date("2027-01-01T00:00:00.000Z"), created_at: new Date("2026-09-01T00:00:00.000Z") }] },
      ]);
    }

    it("按现有代码：credential_not_ready，reasons 含 not_validated，批次被暂停而不是放行", async () => {
      const { tx, genericTaskUpdates } = buildScenario();
      const outcome = await releasePromoClaimShardsForAccount(tx, ACCOUNT_ID, ENABLED_CONFIG, NOW, PROMO_ENABLED_ENV);
      expect(outcome.action).toBe("credential_not_ready");
      expect(outcome.detail).toMatchObject({ reasons: ["not_validated"] });
      const batchUpdate = genericTaskUpdates.find((u) => u.where.id === BATCH_ID);
      expect(batchUpdate?.data.status).toBe("disabled");
      const shardUpdate = genericTaskUpdates.find((u) => u.where.id === SHARD_ID);
      expect(shardUpdate).toBeUndefined();
    });
  });

  describe("(d) 批准时钟：首个分片放行后，即使早已超过批准有效期也不再要求重新批准", () => {
    function buildScenario() {
      const shard = shardRow({});
      // approvalValidUntil 早已过去，但 firstReleasedAt 已经写过——D1 规定
      // 此后永不再因为批次创建时间要求重新批准。
      const batchParams = { approvedAt: "2020-01-01T00:00:00.000Z", approvalValidUntil: "2020-01-02T00:00:00.000Z", firstReleasedAt: "2020-01-02T01:00:00.000Z" };
      return makeFakeTx([
        ...admissionFreeRules(),
        { match: (t) => t.includes("JOIN generic_task b ON b.id = s.parent_task_id"), rows: [selectNextRow(shard, batchParams)] },
        { match: (t) => t.includes("FROM channel_account_credential"), rows: [{ id: "cred-1", status: "active", last_validated_at: new Date("2026-09-22T00:00:00.000Z"), expires_at: new Date("2027-01-01T00:00:00.000Z"), created_at: new Date("2026-09-01T00:00:00.000Z") }] },
      ]);
    }

    it("按现有代码：仍然放行，不判批准过期", async () => {
      const { tx, genericTaskUpdates } = buildScenario();
      const outcome = await releasePromoClaimShardsForAccount(tx, ACCOUNT_ID, ENABLED_CONFIG, NOW, PROMO_ENABLED_ENV);
      expect(outcome.action).toBe("released");
      const shardUpdate = genericTaskUpdates.find((u) => u.where.id === SHARD_ID);
      expect(shardUpdate?.data.status).toBe("pending");
    });
  });

  describe("(e) promo 双闸：任一开关未开都必须挡住放行，且不能走到「选下一个分片」这一步", () => {
    it("FEATURE_PROMO_LINK_CLAIM=false 时：promo_feature_disabled，且从未查询过候选分片", async () => {
      const { tx, genericTaskUpdates } = makeFakeTx(admissionFreeRules());
      const outcome = await releasePromoClaimShardsForAccount(
        tx, ACCOUNT_ID, ENABLED_CONFIG, NOW,
        { NODE_ENV: "test", FEATURE_PROMO_LINK_CLAIM: "false", PROMO_LINK_CLAIM_ALLOW_WRITE: "true" },
      );
      expect(outcome.action).toBe("promo_feature_disabled");
      expect(genericTaskUpdates).toHaveLength(0);
    });

    it("PROMO_LINK_CLAIM_ALLOW_WRITE=false 时：同样 promo_feature_disabled", async () => {
      const { tx } = makeFakeTx(admissionFreeRules());
      const outcome = await releasePromoClaimShardsForAccount(
        tx, ACCOUNT_ID, ENABLED_CONFIG, NOW,
        { NODE_ENV: "test", FEATURE_PROMO_LINK_CLAIM: "true", PROMO_LINK_CLAIM_ALLOW_WRITE: "false" },
      );
      expect(outcome.action).toBe("promo_feature_disabled");
    });
  });
});
