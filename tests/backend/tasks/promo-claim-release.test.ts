import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyShardReleaseEligibility,
  nextMissedDeadlineReasonCode,
  PROMO_CLAIM_INTENT_OPERATION_TYPE,
} from "@/lib/tasks/promo-claim-release";
import type { TaskControlMarker } from "@/lib/tasks/task-control";

/**
 * 领推广链接生命周期，正式修复第 2 阶段第 3 步（`docs/adr/
 * ADR-PROMO-CLAIM-BATCH-LIFECYCLE.md`，设计 §5.4/§5.7）——这里只覆盖
 * `src/lib/tasks/promo-claim-release.ts` 里不接触数据库的纯判定：一个
 * `disabled` 分片的任务控制标记是否处于"可放行"状态、错过截止时间后下一个
 * 系统暂停原因码该是什么。放行/暂停的完整事务逻辑（咨询锁、批次/分片选择、
 * D1/D5/D4 判定、唯一约束冲突处理）离不开真实 Postgres 的查询计划与并发
 * 语义，覆盖在 `tests/integration/tasks/promo-claim-release-postgres.test.ts`。
 */

function marker(partial: Partial<TaskControlMarker> & Pick<TaskControlMarker, "kind">): TaskControlMarker {
  return { source: "system", at: "2026-09-23T00:00:00.000Z", ...partial };
}

describe("promo-claim-release: classifyShardReleaseEligibility", () => {
  it("首次放行前的 awaiting_release 标记可放行", () => {
    expect(classifyShardReleaseEligibility(marker({ kind: "awaiting_release" }))).toBe("awaiting_release");
  });

  it("错过截止时间第 1 次（system_hold:deadline_missed）可重新放行", () => {
    expect(
      classifyShardReleaseEligibility(marker({ kind: "system_hold", reasonCode: "deadline_missed" })),
    ).toBe("deadline_missed_retry");
  });

  it("连续两次错过（deadline_missed_twice）不可自动放行", () => {
    expect(
      classifyShardReleaseEligibility(marker({ kind: "system_hold", reasonCode: "deadline_missed_twice" })),
    ).toBe("not_eligible");
  });

  it("批准过期 / 凭据未就绪 / 回退开关关闭都不可放行（这三种只出现在批次上，但函数本身按输入完全判定）", () => {
    for (const reasonCode of ["approval_expired", "credential_not_ready", "lifecycle_disabled"] as const) {
      expect(classifyShardReleaseEligibility(marker({ kind: "system_hold", reasonCode }))).toBe("not_eligible");
    }
  });

  it("人工暂停 / 中止不可放行", () => {
    expect(classifyShardReleaseEligibility(marker({ kind: "paused" }))).toBe("not_eligible");
    expect(classifyShardReleaseEligibility(marker({ kind: "aborted" }))).toBe("not_eligible");
  });

  it("标记缺失（undefined）不可放行——fail-closed", () => {
    expect(classifyShardReleaseEligibility(undefined)).toBe("not_eligible");
  });
});

describe("promo-claim-release: nextMissedDeadlineReasonCode", () => {
  it("第 1 次错过（计数变为 1）返回 deadline_missed", () => {
    expect(nextMissedDeadlineReasonCode(1)).toBe("deadline_missed");
  });

  it("第 2 次及以后（计数 >= 2）返回 deadline_missed_twice", () => {
    expect(nextMissedDeadlineReasonCode(2)).toBe("deadline_missed_twice");
    expect(nextMissedDeadlineReasonCode(3)).toBe("deadline_missed_twice");
  });

  it("边界：0 按未到阈值处理（理论上不会传入 0，调用方总是先 +1 才传进来）", () => {
    expect(nextMissedDeadlineReasonCode(0)).toBe("deadline_missed");
  });
});

describe("promo-claim-release: 与 worker/handlers/promo-link-claim.ts 的意图操作类型字面量保持一致", () => {
  /**
   * `worker/handlers/promo-link-claim.ts` 的 `prepareSideEffectIntent`
   * 调用点把 `operationType` 写死成字符串字面量（该文件本步未改、也没有导出
   * 这个常量），`src/lib/tasks/promo-claim-release.ts` 的 D4 前置检查必须查
   * 同一个值才能真正命中已存在的意图记录。两处字面量各自独立维护，这条
   * 测试是防止未来其中一处改了拼写却忘了改另一处的唯一防线。
   */
  it("PROMO_CLAIM_INTENT_OPERATION_TYPE 等于 promo-link-claim.ts 里写死的 operationType 字面量", () => {
    const source = readFileSync(
      resolve(process.cwd(), "worker/handlers/promo-link-claim.ts"),
      "utf8",
    );
    expect(source).toContain(`operationType: "${PROMO_CLAIM_INTENT_OPERATION_TYPE}"`);
    expect(PROMO_CLAIM_INTENT_OPERATION_TYPE).toBe("promo_link.claim_promo");
  });
});
