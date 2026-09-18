/**
 * Owner decision 2026-09-18, 决策 2 — Preview 账号级确定性故障刹车.
 *
 * 要的是**故障隔离**，不是把重试次数从 1 改成 3：凭据坏掉时重试三次只会把
 * 7.9 万次失败变成 23.7 万次。所以每个用例都从"这次失败是不是账号级的"这个
 * 分类问题出发，而不是从"重试几次"出发。
 *
 * 分工：这份文件覆盖分类 / 写入 / 入队挡板 / 解除四段的真实行为；claim 期的
 * SQL 下推（`selectPending`）需要真实 Postgres，覆盖在
 * `tests/integration/tasks/preview-account-hold-postgres.test.ts`。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DETERMINISTIC_CREDENTIAL_FAILURE_CODES } from "@/lib/credentials/claim-readiness";
import {
  accountHoldExistsSql,
  CHANNEL_ACCOUNT_HOLD_SCOPES,
  findActiveAccountHold,
  PREVIEW_ACCOUNT_HOLD_SCOPE,
} from "@/lib/tasks/account-hold";
import { enqueueMoboreaderPreviewRefreshTask, MOBOREADER_TASK_TYPES } from "@/lib/tasks/moboreader";
import { readTaskControlMarker } from "@/lib/tasks/task-control";

import { createMoboreaderPreviewHandler } from "../../../worker/handlers/moboreader";
import {
  parsePreviewAccountHoldArgs,
  PREVIEW_ACCOUNT_HOLD_RELEASE_AUDIT_ACTION,
  PREVIEW_ACCOUNT_HOLD_RELEASE_CONFIRM_PHRASE,
  releaseAccountHold,
  RELEASE_REENABLE_CHUNK_SIZE,
} from "../../../scripts/preview-account-hold";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import {
  holdChannelAccountForPreview,
  isAccountLevelPreviewFailure,
  PREVIEW_ACCOUNT_HOLD_AUDIT_ACTION,
} from "../../../worker/handlers/preview-account-hold";

/**
 * `loadMoboreaderPreviewScope` decrypts via `decryptCredentialSecretForWorker`
 * *without* threading the handler's own `env` through (pre-existing, out of
 * this round's scope), so the keyring has to be visible on `process.env` for a
 * test that needs the scope to actually load. `vi.stubEnv` is undone by
 * `vi.unstubAllEnvs` in `beforeEach`.
 */
function stubKeyring(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") vi.stubEnv(key, value);
  }
}

function keyring(): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-preview-hold-keys-"));
  const v1 = path.join(directory, "v1");
  const fingerprint = path.join(directory, "fingerprint");
  writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
  return {
    env: {
      NODE_ENV: "test",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

const ACCOUNT_A = "30000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "30000000-0000-4000-8000-00000000000b";
const APP_ID = "20000000-0000-4000-8000-000000000001";
const SOURCE_ID = "10000000-0000-4000-8000-000000000001";

/** First argument of a captured mock call, without the `calls[0]![0]` tuple-index gymnastics. */
function firstArgOf(call: unknown[] | undefined): unknown {
  return call?.[0];
}

/** Flattens a captured `Prisma.sql` call's literal fragments so a test can assert on the statement itself. */
function sqlTextOf(call: unknown[] | undefined): string {
  const query = call?.[0] as { strings?: readonly string[] } | undefined;
  return (query?.strings ?? []).join("?");
}

const GATES = Object.freeze({
  NODE_ENV: "test",
  FEATURE_NOVEL_CATALOG_SYNC: "true",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
  MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
});

// ---------------------------------------------------------------------------
// 分类：什么算账号级确定性失败
// ---------------------------------------------------------------------------

describe("账号级失败分类", () => {
  it("恰好复用推广链路既有的凭据失败分类，一个不多一个不少", () => {
    for (const code of DETERMINISTIC_CREDENTIAL_FAILURE_CODES) {
      expect(isAccountLevelPreviewFailure(code)).toBe(true);
    }
    // 该集合就是全集：这里断言"数量相等"，是为了让任何一次单方面扩充
    // （在试读侧偷偷多认一个码）都变成失败，而不是悄悄生效。
    expect(DETERMINISTIC_CREDENTIAL_FAILURE_CODES.size).toBe(5);
  });

  /**
   * Case 7 的分类半边。这一串是试读 handler 真实会产出的**其余全部**失败码：
   * 上游超时/连接重置/5xx/限流统一收敛到两个 upstream_* 码，其余是每本书
   * 自己的数据问题。任何一个都不许拉闸——一本书坏掉换来整个账号停摆，
   * 比不刹车更糟。
   */
  it.each([
    "upstream_material_read_failed",
    "upstream_preview_read_failed",
    "preview_task_scope_invalid",
    "preview_source_binding_missing",
    "preview_channel_binding_unavailable",
    "preview_read_capability_unavailable",
    "preview_catalog_identity_mismatch",
    "preview_account_unavailable",
    "withdrawn_chapter_requires_manual_review",
    "ambiguous_canonical_chapter",
    "handler_failed",
    "stale_processing",
    "",
  ])("%s 不触发账号级刹车", (code) => {
    expect(isAccountLevelPreviewFailure(code)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 写入：holdChannelAccountForPreview
// ---------------------------------------------------------------------------

function fakeTx(insertReturns: Array<{ id: string }> = [{ id: "hold-1" }]) {
  const queryRaw = vi.fn(async () => insertReturns);
  const auditCreate = vi.fn(async () => ({}));
  return { $queryRaw: queryRaw, operationAudit: { create: auditCreate }, __queryRaw: queryRaw, __audit: auditCreate };
}

describe("holdChannelAccountForPreview", () => {
  it("确定性凭据失败 → 写一行 hold + 一条审计", async () => {
    const tx = fakeTx();

    const outcome = await holdChannelAccountForPreview(tx as never, {
      channelAccountId: ACCOUNT_A,
      reasonCode: "credential_validation_failed",
      taskId: "11111111-1111-4111-8111-111111111111",
      itemId: "22222222-2222-4222-8222-222222222222",
    });

    expect(outcome).toEqual({ held: true, holdId: "hold-1" });
    expect(tx.__audit).toHaveBeenCalledTimes(1);
    expect(firstArgOf(tx.__audit.mock.calls[0])).toMatchObject({
      data: {
        actorType: "worker",
        action: PREVIEW_ACCOUNT_HOLD_AUDIT_ACTION,
        entityType: "ChannelAccount",
        entityId: ACCOUNT_A,
        taskType: MOBOREADER_TASK_TYPES.previewRefresh,
      },
    });
  });

  it("🔴 靠 ON CONFLICT DO NOTHING 幂等，而不是先查后插——先查后插在两个 worker 副本之间就是竞态", async () => {
    const tx = fakeTx();
    await holdChannelAccountForPreview(tx as never, {
      channelAccountId: ACCOUNT_A,
      reasonCode: "credential_validation_failed",
      taskId: "11111111-1111-4111-8111-111111111111",
      itemId: "22222222-2222-4222-8222-222222222222",
    });
    const sql = sqlTextOf(tx.__queryRaw.mock.calls[0]);
    expect(sql).toContain("INSERT INTO channel_account_hold");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("RETURNING id");
  });

  it("已有 active hold（插入被唯一索引吸收）→ held:false，不重复写审计", async () => {
    const tx = fakeTx([]);

    const outcome = await holdChannelAccountForPreview(tx as never, {
      channelAccountId: ACCOUNT_A,
      reasonCode: "credential_missing",
      taskId: "11111111-1111-4111-8111-111111111111",
      itemId: "22222222-2222-4222-8222-222222222222",
    });

    expect(outcome).toEqual({ held: false });
    expect(tx.__audit).not.toHaveBeenCalled();
  });

  it("🔴 非账号级失败码：一行都不写", async () => {
    const tx = fakeTx();

    const outcome = await holdChannelAccountForPreview(tx as never, {
      channelAccountId: ACCOUNT_A,
      reasonCode: "upstream_preview_read_failed",
      taskId: "11111111-1111-4111-8111-111111111111",
      itemId: "22222222-2222-4222-8222-222222222222",
    });

    expect(outcome).toEqual({ held: false });
    expect(tx.__queryRaw).not.toHaveBeenCalled();
    expect(tx.__audit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handler：只有凭据类失败才拉闸，其余原样放行
// ---------------------------------------------------------------------------

type ScopeDbOptions = {
  readonly credentials?: unknown[];
  readonly accountFound?: boolean;
  readonly capabilities?: string[];
};

/**
 * 最小的 `loadMoboreaderPreviewScope` 依赖面。默认摆成"账号在、但没有一条可用
 * 凭据"——也就是 2026-09-14 那一小时的形状。
 */
function scopeDb(options: ScopeDbOptions = {}) {
  return {
    channelSyncTaskItem: {
      findUnique: async () => ({
        taskId: "11111111-1111-4111-8111-111111111111",
        novelSourceItemId: SOURCE_ID,
        task: {
          taskType: MOBOREADER_TASK_TYPES.previewRefresh,
          channelAccountId: ACCOUNT_A,
          channelAppId: APP_ID,
        },
        novelSourceItem: {
          id: SOURCE_ID,
          novelId: "40000000-0000-4000-8000-000000000001",
          channelAppId: APP_ID,
          externalAgencyId: "7",
          sourceLanguageCode: "1",
          // `buildMoboreaderPreviewRequestsFromCatalogRow` + the identity
          // assertion right after it both read this, and both must pass for a
          // test to reach the upstream call at all — an empty object short-
          // circuits on `malformed_payload` long before that, which would
          // make the Case 7 assertions below vacuous.
          rawPayload: { agencyId: "7", seriesId: "series-1", language: "1", projectType: 1, materialType: "3" },
          deletedAt: null,
        },
      }),
    },
    channelApp: {
      findFirst: async () => ({
        channelId: "channel-1",
        projectType: 1,
        sourceApp: { code: "moboreader" },
        capabilities: (options.capabilities ?? ["getbydataid", "getchapterinfo"]).map((capabilityKey) => ({
          capabilityKey,
        })),
      }),
    },
    channelAccount: {
      findFirst: async () => (options.accountFound === false
        ? null
        : { id: ACCOUNT_A, credentials: options.credentials ?? [] }),
    },
    channelSyncTask: {
      findUnique: async () => ({ channelAccountId: ACCOUNT_A }),
    },
  };
}

function lease() {
  return {
    family: "channel_sync" as const,
    taskType: MOBOREADER_TASK_TYPES.previewRefresh,
    targetType: "novel_source_item",
    mode: "apply" as const,
    itemId: "22222222-2222-4222-8222-222222222222",
    taskId: "11111111-1111-4111-8111-111111111111",
    workerId: "worker-1",
    executionToken: "33333333-3333-4333-8333-333333333333",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(),
    payload: { trigger: "auto", actorId: "actor-1", requestId: "req-1" },
  };
}

function adapterSpy() {
  return {
    listBooks: vi.fn(),
    fetchBookMaterial: vi.fn(async () => ({})),
    fetchPreviewChapters: vi.fn(async () => ({ chapterList: [] as unknown[] })),
  } as unknown as {
    listBooks: ReturnType<typeof vi.fn>;
    fetchBookMaterial: ReturnType<typeof vi.fn>;
    fetchPreviewChapters: ReturnType<typeof vi.fn>;
  };
}

describe("试读 handler：凭据类失败拉闸，其余不拉", () => {
  it("Case 6 第一步：凭据无法使用 → failed 带真实码，并在同一个事务里落 hold；上游一次都没被调用", async () => {
    const adapter = adapterSpy();
    const handler = createMoboreaderPreviewHandler(scopeDb() as never, { adapter: adapter as never, env: GATES });

    const outcome = await handler({
      lease: lease(),
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "failed", error: { code: "credential_missing" } });
    // 上游读没有发生：刹车发生在任何渠道 API 调用之前。
    expect(adapter.fetchBookMaterial).not.toHaveBeenCalled();
    expect(adapter.fetchPreviewChapters).not.toHaveBeenCalled();

    // protectedWrite 真的会去写 hold（而不是挂了个空函数走过场）。
    const tx = fakeTx();
    await outcome.protectedWrite?.(tx as never);
    expect(tx.__queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlTextOf(tx.__queryRaw.mock.calls[0]);
    expect(sql).toContain("INSERT INTO channel_account_hold");
  });

  it("两条可用凭据（credential_ambiguous）同样拉闸", async () => {
    const handler = createMoboreaderPreviewHandler(
      scopeDb({ credentials: [{ id: "c1" }, { id: "c2" }] }) as never,
      { adapter: adapterSpy() as never, env: GATES },
    );

    const outcome = await handler({
      lease: lease(),
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    });

    expect(outcome).toMatchObject({ status: "failed", error: { code: "credential_ambiguous" } });
    expect(outcome.protectedWrite).toBeTypeOf("function");
  });

  /**
   * Case 7。能力缺失是"这个渠道应用配错了"，不是"这个账号的凭据坏了"——它必须
   * 保持原样抛出、走既有的 handler_failed 路径，绝不能顺手把账号拉闸。
   */
  it("Case 7：非凭据类的 scope 失败原样抛出，不落 hold", async () => {
    const handler = createMoboreaderPreviewHandler(
      scopeDb({ capabilities: ["getbydataid"] }) as never,
      { adapter: adapterSpy() as never, env: GATES },
    );

    await expect(handler({
      lease: lease(),
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    })).rejects.toThrow("preview_read_capability_unavailable");
  });

  /**
   * Case 7 的主用例：凭据是好的（用真密钥环真加密一条，让 scope 完整走通），
   * 失败发生在上游读那一步——超时正是事故报告里点名"不许拉闸"的那一类。
   * 必须只失败这一条：不带 protectedWrite（也就没有任何 hold 写入），
   * 下一本书照常可以被领取执行。
   */
  it("Case 7：凭据可用、上游超时 → 只失败这一条，不带 protectedWrite、不落 hold", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      stubKeyring(keys.env);
      const adapter = adapterSpy();
      adapter.fetchBookMaterial = vi.fn(async () => {
        throw new Error("ETIMEDOUT");
      });
      const handler = createMoboreaderPreviewHandler(
        scopeDb({
          credentials: [{
            id: credentialId,
            encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, keys.env),
            keyVersion: 1,
          }],
        }) as never,
        { adapter: adapter as never, env: { ...GATES, ...keys.env } },
      );

      const outcome = await handler({
        lease: lease(),
        mode: "apply",
        signal: new AbortController().signal,
        heartbeat: async () => true,
      });

      expect(outcome).toMatchObject({
        status: "failed",
        error: { code: "upstream_material_read_failed" },
      });
      expect(outcome.protectedWrite).toBeUndefined();
      // 凭据确实走通了（上游被真的调用过），所以这条用例没有在更早的地方短路。
      expect(adapter.fetchBookMaterial).toHaveBeenCalledTimes(1);
    } finally {
      keys.cleanup();
    }
  });

  it("Case 7：凭据可用、上游返回空试读 → skipped，同样不落 hold", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      stubKeyring(keys.env);
      const adapter = adapterSpy();
      const handler = createMoboreaderPreviewHandler(
        scopeDb({
          credentials: [{
            id: credentialId,
            encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, keys.env),
            keyVersion: 1,
          }],
        }) as never,
        { adapter: adapter as never, env: { ...GATES, ...keys.env } },
      );

      const outcome = await handler({
        lease: lease(),
        mode: "apply",
        signal: new AbortController().signal,
        heartbeat: async () => true,
      });

      expect(outcome).toMatchObject({ status: "skipped", result: { reason: "upstream_empty_preview" } });
      expect(outcome.protectedWrite).toBeUndefined();
    } finally {
      keys.cleanup();
    }
  });
});

/**
 * 2026-09-18 push 前的第三项收尾核验，固化成用例：
 * **拉闸码里不许混进 transient。**
 *
 * 全仓反查过 `credential_*` 五个码的每一处产出点，全部是本地判断，没有一处
 * 依赖网络结果：
 *   - `worker/credentials/crypto.ts` —— AES-GCM 解密失败/信封格式/版本不符；
 *   - `src/lib/credentials/claim-readiness.ts` `classifyCredentialRowsForClaim`
 *     —— 纯粹数 active 行与比 `expiresAt`；
 *   - `src/lib/credentials/jwt.ts` `validateCredentialJwtLocally` —— base64
 *     解码 + `exp` 比较，文件内零 fetch/http；
 *   - `src/lib/credentials/lifecycle.ts` / `src/server/credentials/service.ts`
 *     —— 状态机判断。
 * 因此不存在「上游超时 → 凭据被判 invalid → 后续 preview 看到 credential_missing
 * → 拉闸」这条把 transient 洗成 deterministic 的路径。
 *
 * 下面两条把这个结论钉住：JWT 校验器不得引入网络依赖；拉闸点遇到"长得不像
 * 失败码"的异常（DB 连接错误、Prisma 错误等）必须原样抛出。
 */
describe("拉闸码来源审计（2026-09-18 push 前核验）", () => {
  it("🔴 本地 JWT 校验器不得引入任何网络依赖——它一旦联网，超时就会被写成 credential_validation_failed", () => {
    const jwt = readFileSync(new URL("../../../src/lib/credentials/jwt.ts", import.meta.url), "utf8");
    expect(jwt).not.toMatch(/\bfetch\b|node:http|require\(["']https?|from ["']axios|from ["']undici/);
  });

  it("🔴 scope 加载器抛出的非失败码异常（如 DB 连接失败）原样抛出，绝不被误判成账号级失败", async () => {
    const failing = {
      ...scopeDb(),
      channelSyncTaskItem: {
        findUnique: async () => {
          // Prisma 的连接类错误：message 是一大段说明文字，与任何失败码都不相等。
          throw new Error("Can't reach database server at `postgres:5432`");
        },
      },
    };
    const handler = createMoboreaderPreviewHandler(failing as never, {
      adapter: adapterSpy() as never,
      env: GATES,
    });

    await expect(handler({
      lease: lease(),
      mode: "apply",
      signal: new AbortController().signal,
      heartbeat: async () => true,
    })).rejects.toThrow(/reach database server/);
  });

  it("🔴 拉闸判定只认全等的失败码，不做包含匹配——否则一段含有 credential 字样的报错就能拉闸", () => {
    for (const nearMiss of [
      "Can't reach database server at `postgres:5432`",
      "credential_validation_failed: upstream returned 503",
      "upstream timeout while validating credential",
      "CREDENTIAL_VALIDATION_FAILED",
      " credential_validation_failed ",
    ]) {
      expect(isAccountLevelPreviewFailure(nearMiss)).toBe(false);
    }
    expect(isAccountLevelPreviewFailure("credential_validation_failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 入队挡板
// ---------------------------------------------------------------------------

function enqueueDb(options: { activeHold?: { id: string; reasonCode: string } | null } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  return {
    channelAccountHold: {
      findFirst: vi.fn(async ({ where }: { where: { channelAccountId: string } }) =>
        options.activeHold && where.channelAccountId === ACCOUNT_A
          ? { ...options.activeHold, channelAccountId: ACCOUNT_A, credentialId: null, heldAt: new Date() }
          : null),
    },
    channelSyncTask: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
    channelApp: { findFirst: async () => ({ id: APP_ID, sourceApp: { code: "moboreader" } }) },
    channelAccount: { findFirst: async () => ({ id: ACCOUNT_A, credentials: [{ id: "cred-1" }] }) },
    novelSourceItem: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, novelId: "40000000-0000-4000-8000-000000000001", deletedAt: null, novel: { previewPolicy: null } })),
    },
    operationAudit: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; }) },
    __created: created,
    __audits: audits,
  };
}

function enqueue(db: ReturnType<typeof enqueueDb>, channelAccountId: string, requestToken: string) {
  return enqueueMoboreaderPreviewRefreshTask(
    db as never,
    {
      trigger: "auto",
      channelAccountId,
      channelAppId: APP_ID,
      novelSourceItemIds: [SOURCE_ID],
      requestToken,
      actorId: "actor-1",
      requestId: "req-1",
      mode: "apply",
    },
    GATES,
    new Date("2026-09-18T00:00:00.000Z"),
  );
}

describe("入队挡板：被 hold 的账号，新试读工作不进可运行池", () => {
  it("无 hold → 正常 pending", async () => {
    const db = enqueueDb();

    const result = await enqueue(db, ACCOUNT_A, "token-clean");

    expect(result).toMatchObject({ status: "enqueued", taskStatus: "pending" });
    expect(result).not.toHaveProperty("accountHeld");
    expect(db.__created[0]!.status).toBe("pending");
    expect(readTaskControlMarker(db.__created[0]!.result)).toBeUndefined();
  });

  it("有 hold → 建成 disabled + system_hold 标记 + 专属审计动作，工作被保留而不是被丢弃", async () => {
    const db = enqueueDb({ activeHold: { id: "hold-1", reasonCode: "credential_validation_failed" } });

    const result = await enqueue(db, ACCOUNT_A, "token-held");

    expect(result).toMatchObject({
      status: "enqueued",
      taskStatus: "disabled",
      accountHeld: { holdId: "hold-1", reasonCode: "credential_validation_failed" },
    });
    const created = db.__created[0]!;
    expect(created.status).toBe("disabled");
    // 任务本体的 result 字段没有被标记覆盖掉。
    expect(created.result).toMatchObject({ eligibleCount: 1 });
    expect(readTaskControlMarker(created.result)).toMatchObject({
      kind: "system_hold",
      source: "system",
      reasonCode: "credential_validation_failed",
    });
    expect(db.__audits[0]).toMatchObject({
      action: "moboreader.preview_refresh.queued_account_held",
      afterSnapshot: { accountHoldId: "hold-1" },
    });
  });

  it("Case 8：hold 只挡它自己那个账号，另一个账号照常 pending", async () => {
    const db = enqueueDb({ activeHold: { id: "hold-1", reasonCode: "credential_validation_failed" } });

    const other = await enqueue(db, ACCOUNT_B, "token-other-account");

    expect(other).toMatchObject({ status: "enqueued", taskStatus: "pending" });
    expect(db.__created[0]!.status).toBe("pending");
    expect(db.channelAccountHold.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ channelAccountId: ACCOUNT_B }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// 读侧谓词
// ---------------------------------------------------------------------------

describe("active hold 判定", () => {
  it("findActiveAccountHold 只认 released_at IS NULL", async () => {
    const findFirst = vi.fn(async () => null);
    await findActiveAccountHold({ channelAccountHold: { findFirst } } as never, ACCOUNT_A);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { channelAccountId: ACCOUNT_A, scope: PREVIEW_ACCOUNT_HOLD_SCOPE, releasedAt: null },
      }),
    );
  });

  it("🔴 SQL 下推与 findActiveAccountHold 同口径：也只认 released_at IS NULL", () => {
    const fragment = accountHoldExistsSql(
      { strings: ["t.channel_account_id"], values: [] } as never,
      PREVIEW_ACCOUNT_HOLD_SCOPE,
    );
    const text = fragment.strings.join("?");
    expect(text).toContain("channel_account_hold");
    expect(text).toContain("released_at IS NULL");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 解除（Case 9）
// ---------------------------------------------------------------------------

function releaseDb(options: {
  readonly activeHold?: { id: string } | null;
  readonly credentials?: Array<{ id: string; encryptedSecret: Uint8Array; keyVersion: number }>;
  readonly parkedChunks?: number[];
  /** What `countParkedTasks` reports — the crash-resume path keys off this. */
  readonly parkedTaskCount?: number;
} = {}) {
  const chunks = [...(options.parkedChunks ?? [0])];
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const auditCreate = vi.fn(async () => ({}));
  const executeRaw = vi.fn(async () => chunks.shift() ?? 0);
  const parked = options.parkedTaskCount ?? (options.parkedChunks ?? [0]).reduce((a, b) => a + b, 0);
  return {
    channelAccountHold: {
      findFirst: vi.fn(async () => (options.activeHold === undefined ? { id: "hold-1" } : options.activeHold)),
      findMany: vi.fn(async () => []),
      updateMany,
    },
    channelAccount: {
      findFirst: vi.fn(async () => ({ id: ACCOUNT_A, credentials: options.credentials ?? [] })),
    },
    operationAudit: { create: auditCreate },
    $executeRaw: executeRaw,
    $queryRaw: vi.fn(async () => [{ count: BigInt(parked) }]),
    __updateMany: updateMany,
    __audit: auditCreate,
    __executeRaw: executeRaw,
  };
}

describe("解除 hold", () => {
  it("参数把关：账号 id / 责任人 / 确认短语缺一不可", () => {
    expect(parsePreviewAccountHoldArgs([])).toEqual({ mode: "list" });
    expect(() => parsePreviewAccountHoldArgs(["--release"])).toThrow("channel_account_id_invalid");
    expect(() => parsePreviewAccountHoldArgs(["--release", "--channel-account-id", ACCOUNT_A]))
      .toThrow("released_by_invalid");
    expect(() => parsePreviewAccountHoldArgs([
      "--release", "--channel-account-id", ACCOUNT_A, "--released-by", "   ",
    ])).toThrow("released_by_invalid");
    expect(() => parsePreviewAccountHoldArgs([
      "--release", "--channel-account-id", ACCOUNT_A, "--released-by", "ops-1",
    ])).toThrow("release_confirmation_invalid");
    expect(parsePreviewAccountHoldArgs([
      "--release", "--channel-account-id", ACCOUNT_A, "--released-by", "ops-1",
      "--reason", "rotated", "--confirm", PREVIEW_ACCOUNT_HOLD_RELEASE_CONFIRM_PHRASE,
    ])).toEqual({ mode: "release", channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: "rotated" });
  });

  it("🔴 凭据仍然解不开 → 拒绝解除，hold 原样保留，一条任务都不放行", async () => {
    const keys = keyring();
    const otherKeys = keyring();
    try {
      const credentialId = randomUUID();
      const db = releaseDb({
        credentials: [{
          id: credentialId,
          // 用另一套密钥环加密：正是 2026-09-14 的形状。
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, otherKeys.env),
          keyVersion: 1,
        }],
      });

      const outcome = await releaseAccountHold(
        db as never,
        { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: null },
        new Date(),
        keys.env,
      );

      expect(outcome).toMatchObject({
        status: "refused",
        preflight: { status: "unusable", code: "credential_validation_failed" },
      });
      expect(db.__updateMany).not.toHaveBeenCalled();
      expect(db.__executeRaw).not.toHaveBeenCalled();
      expect(db.__audit).not.toHaveBeenCalled();
    } finally {
      keys.cleanup();
      otherKeys.cleanup();
    }
  });

  it("Case 9：凭据修好 → 解除 hold 并分块放回被挡下的任务，留审计", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      const db = releaseDb({
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, keys.env),
          keyVersion: 1,
        }],
        // 两轮：满块 500 触发继续循环，再来 7 条收尾。
        parkedChunks: [RELEASE_REENABLE_CHUNK_SIZE, 7],
      });

      const outcome = await releaseAccountHold(
        db as never,
        { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: "rotated credential" },
        new Date("2026-09-18T10:00:00.000Z"),
        keys.env,
      );

      expect(outcome).toEqual({
        status: "released",
        holdId: "hold-1",
        reEnabledTaskCount: RELEASE_REENABLE_CHUNK_SIZE + 7,
      });
      expect(db.__executeRaw).toHaveBeenCalledTimes(2);
      expect(db.__updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "hold-1", releasedAt: null },
        data: expect.objectContaining({ releasedBy: "ops-1", releaseReason: "rotated credential" }),
      }));
      expect(firstArgOf(db.__audit.mock.calls[0])).toMatchObject({
        data: {
          action: PREVIEW_ACCOUNT_HOLD_RELEASE_AUDIT_ACTION,
          entityId: ACCOUNT_A,
          afterSnapshot: { holdId: "hold-1", reEnabledTaskCount: RELEASE_REENABLE_CHUNK_SIZE + 7 },
        },
      });
    } finally {
      keys.cleanup();
    }
  });

  it("🔴 只放行本刹车挂起的任务，不碰因功能开关关闭而 disabled 的任务", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      const db = releaseDb({
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, keys.env),
          keyVersion: 1,
        }],
      });
      await releaseAccountHold(
        db as never,
        { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: null },
        new Date(),
        keys.env,
      );
      const sql = sqlTextOf(db.__executeRaw.mock.calls[0]);
      expect(sql).toContain("result->'taskControl'->>'kind' = 'system_hold'");
      expect(sql).toContain("status = 'disabled'");
      expect(sql).toContain("SET\n        status = 'pending'");
    } finally {
      keys.cleanup();
    }
  });

  it("没有 active hold 且没有残留挂起任务 → no_active_hold，连预检都不跑、不写任何东西", async () => {
    const db = releaseDb({ activeHold: null, parkedTaskCount: 0 });
    const outcome = await releaseAccountHold(
      db as never,
      { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: null },
    );
    expect(outcome).toEqual({ status: "no_active_hold" });
    expect(db.__updateMany).not.toHaveBeenCalled();
    expect(db.__executeRaw).not.toHaveBeenCalled();
    expect(db.__audit).not.toHaveBeenCalled();
  });

  /**
   * 崩溃续跑。释放分两段写（清 hold + 分块放回任务），中间必然可能断电：
   * 旧版本以「有没有 active hold」作为整个函数的入口条件，于是"hold 已清、
   * 任务只放回一半"就变成**永久孤儿**——闸已经抬了，没人再挡它们，也没有任何
   * 命令会再来捡。现在两件事各自收敛，重跑即可续完。
   */
  it("🔴 Case: hold 已清、任务只恢复了一部分时进程崩溃 → 重跑继续恢复剩余任务，不产生永久孤儿", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      const db = releaseDb({
        // 崩溃后的现场：hold 行已经是 released（findFirst 返回 null），
        // 但还有 120 张 disabled + system_hold 任务没放回去。
        activeHold: null,
        parkedTaskCount: 120,
        parkedChunks: [120],
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, keys.env),
          keyVersion: 1,
        }],
      });

      const outcome = await releaseAccountHold(
        db as never,
        { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: "resume after crash" },
        new Date(),
        keys.env,
      );

      expect(outcome).toEqual({ status: "resumed", reEnabledTaskCount: 120 });
      // 没有 active hold 可清，所以不该再去写 hold 行……
      expect(db.__updateMany).not.toHaveBeenCalled();
      // ……但残留任务确实被放回去了，并且留下了审计。
      expect(db.__executeRaw).toHaveBeenCalled();
      expect(firstArgOf(db.__audit.mock.calls[0])).toMatchObject({
        data: { afterSnapshot: { holdId: null, resumed: true, reEnabledTaskCount: 120 } },
      });
    } finally {
      keys.cleanup();
    }
  });

  it("🔴 续跑同样要过凭据预检——放回任务本身就是有风险的动作", async () => {
    const keys = keyring();
    const otherKeys = keyring();
    try {
      const credentialId = randomUUID();
      const db = releaseDb({
        activeHold: null,
        parkedTaskCount: 30,
        parkedChunks: [30],
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_A, credentialId, 1, otherKeys.env),
          keyVersion: 1,
        }],
      });

      const outcome = await releaseAccountHold(
        db as never,
        { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: null },
        new Date(),
        keys.env,
      );

      expect(outcome).toMatchObject({ status: "refused" });
      expect(db.__executeRaw).not.toHaveBeenCalled();
      expect(db.__audit).not.toHaveBeenCalled();
    } finally {
      keys.cleanup();
      otherKeys.cleanup();
    }
  });

  it("完全收敛后重跑是干净的 no-op（幂等）", async () => {
    const db = releaseDb({ activeHold: null, parkedTaskCount: 0 });
    await expect(releaseAccountHold(
      db as never,
      { channelAccountId: ACCOUNT_A, releasedBy: "ops-1", releaseReason: null },
    )).resolves.toEqual({ status: "no_active_hold" });
  });
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe("hold 的 scope 语义", () => {
  it("scope 取值域只有 preview，且 PREVIEW_ACCOUNT_HOLD_SCOPE 是它的成员", () => {
    expect([...CHANNEL_ACCOUNT_HOLD_SCOPES]).toEqual(["preview"]);
    expect(CHANNEL_ACCOUNT_HOLD_SCOPES).toContain(PREVIEW_ACCOUNT_HOLD_SCOPE);
  });

  it("🔴 数据库 CHECK 与 TS 取值域同步（两处必须一起改）", () => {
    const migration = readFileSync(
      new URL("../../../prisma/migrations/20260918090000_preview_account_hold/migration.sql", import.meta.url),
      "utf8",
    );
    const check = migration.match(/CHECK \("scope" IN \(([^)]*)\)\)/)?.[1] ?? "";
    const allowed = check.split(",").map((value) => value.trim().replace(/'/g, "")).filter(Boolean);
    expect(allowed).toEqual([...CHANNEL_ACCOUNT_HOLD_SCOPES]);
  });

  it("🔴 三个接入点都按 scope 过滤——一条业务线的 hold 不得殃及另一条", async () => {
    // 1. 读侧
    const findFirst = vi.fn(async () => null);
    await findActiveAccountHold({ channelAccountHold: { findFirst } } as never, ACCOUNT_A);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { channelAccountId: ACCOUNT_A, scope: PREVIEW_ACCOUNT_HOLD_SCOPE, releasedAt: null },
      }),
    );
    // 2. claim 期 SQL 下推
    const fragment = accountHoldExistsSql(
      { strings: ["t.channel_account_id"], values: [] } as never,
      PREVIEW_ACCOUNT_HOLD_SCOPE,
    );
    expect(fragment.strings.join("?")).toContain("h.scope =");
    expect(fragment.values).toContain(PREVIEW_ACCOUNT_HOLD_SCOPE);
    // 3. 写侧
    const tx = fakeTx();
    await holdChannelAccountForPreview(tx as never, {
      channelAccountId: ACCOUNT_A,
      reasonCode: "credential_validation_failed",
      taskId: "11111111-1111-4111-8111-111111111111",
      itemId: "22222222-2222-4222-8222-222222222222",
    });
    const insert = firstArgOf(tx.__queryRaw.mock.calls[0]) as { strings: readonly string[]; values: readonly unknown[] };
    expect(insert.strings.join("?")).toContain("scope");
    expect(insert.values).toContain(PREVIEW_ACCOUNT_HOLD_SCOPE);
  });
});
