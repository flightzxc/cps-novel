import { describe, expect, it } from "vitest";

import {
  CATALOG_BATCH_TTL_MS,
  resolveCatalogBatchLifecycleFields,
  type CatalogBatchOperation,
} from "@/lib/tasks/catalog-batch";
import { PROMO_CLAIM_LIFECYCLE_ENV } from "@/lib/tasks/promo-claim-lifecycle";

/**
 * 领推广链接生命周期，正式修复第 2 阶段第 2 步（`docs/adr/ADR-PROMO-CLAIM-
 * BATCH-LIFECYCLE.md` 设计 §5.1/§5.2）：`enqueueCatalogBatch`
 * （`src/lib/tasks/catalog-batch.ts`）在入队时是否给批次打上
 * `lifecycleVersion`/`lifecycleRole: "batch"`/`approvedAt`/
 * `approvalValidUntil`，以及批次自身 `expiresAt` 用哪个值——这四个字段全部
 * 由纯函数 `resolveCatalogBatchLifecycleFields` 决定，`enqueueCatalogBatch`
 * 本身只在真实 Postgres 集成测试里覆盖（见
 * `tests/integration/catalog-batch/postgres.test.ts`），因为它其余的行为
 * （重放/指纹匹配、事务）本质上离不开数据库；这一个判定与数据库无关，因此
 * 单独抽出来做纯函数单测。
 */

/** `NodeJS.ProcessEnv`（本仓库的全局增强）要求 `NODE_ENV`；每个 fixture 都补上它，让字面量聚焦在被测变量上。 */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...overrides };
}

const NOW = new Date("2026-09-23T00:00:00.000Z");

describe("resolveCatalogBatchLifecycleFields: switch off (default) — byte-for-byte legacy behavior", () => {
  it.each(["promo_claim", "novel_materialize", "content_create"] as const)(
    "operation=%s: no lifecycle fields, expiresAt = submittedAt + 6h",
    (operation) => {
      const result = resolveCatalogBatchLifecycleFields(operation, NOW, env());
      expect(result.fields).toEqual({});
      expect(Object.keys(result.fields)).toHaveLength(0);
      expect(result.expiresAt).toBe(new Date(NOW.getTime() + CATALOG_BATCH_TTL_MS).toISOString());
    },
  );

  it("stays legacy even with an explicit 'false' value for the switch", () => {
    const result = resolveCatalogBatchLifecycleFields(
      "promo_claim",
      NOW,
      env({ [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: "false" }),
    );
    expect(result.fields).toEqual({});
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + CATALOG_BATCH_TTL_MS).toISOString());
  });
});

describe("resolveCatalogBatchLifecycleFields: switch on", () => {
  const onEnv = env({ [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: "true" });

  it("operation=promo_claim: stamps lifecycleVersion 1 / lifecycleRole batch / approvedAt=now / approvalValidUntil=now+1440min, and expiresAt mirrors approvalValidUntil", () => {
    const result = resolveCatalogBatchLifecycleFields("promo_claim", NOW, onEnv);
    const expectedApprovalValidUntil = new Date(NOW.getTime() + 1_440 * 60_000).toISOString();
    expect(result.fields).toEqual({
      lifecycleVersion: 1,
      lifecycleRole: "batch",
      approvedAt: NOW.toISOString(),
      approvalValidUntil: expectedApprovalValidUntil,
    });
    expect(result.expiresAt).toBe(expectedApprovalValidUntil);
    // 不是 submittedAt + 6h（旧路径）——设计 §5.2 明确要求替换掉这条legacy TTL。
    expect(result.expiresAt).not.toBe(new Date(NOW.getTime() + CATALOG_BATCH_TTL_MS).toISOString());
  });

  it("honors a custom PROMO_CLAIM_BATCH_APPROVAL_TTL_MINUTES override", () => {
    const result = resolveCatalogBatchLifecycleFields(
      "promo_claim",
      NOW,
      env({
        [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: "true",
        [PROMO_CLAIM_LIFECYCLE_ENV.approvalTtlMinutes]: "60",
      }),
    );
    const expected = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    expect(result.fields.approvalValidUntil).toBe(expected);
    expect(result.expiresAt).toBe(expected);
  });

  it.each(["novel_materialize", "content_create"] as const)(
    "operation=%s: switch being on never matters — no lifecycle fields, legacy 6h expiresAt",
    (operation: CatalogBatchOperation) => {
      const result = resolveCatalogBatchLifecycleFields(operation, NOW, onEnv);
      expect(result.fields).toEqual({});
      expect(result.expiresAt).toBe(new Date(NOW.getTime() + CATALOG_BATCH_TTL_MS).toISOString());
    },
  );

  it("fails closed on a malformed approval TTL override rather than silently falling back", () => {
    expect(() => resolveCatalogBatchLifecycleFields(
      "promo_claim",
      NOW,
      env({
        [PROMO_CLAIM_LIFECYCLE_ENV.enabled]: "true",
        [PROMO_CLAIM_LIFECYCLE_ENV.approvalTtlMinutes]: "not-a-number",
      }),
    )).toThrow();
  });
});
