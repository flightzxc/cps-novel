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

  /**
   * Opus 复核（2026-09-23）指出的缺口：既有的 D4 集成用例是手写插入
   * `side_effect_intent`、键名写死成 `novelSourceItemId`，如果
   * `worker/handlers/promo-link-claim.ts` 未来把 `requestSummary` 的键名
   * 改了（或 `promo-claim-release.ts` 的 SQL 提取键改了），D4 前置检查会在
   * 真实数据下静默失效——但两处的集成/单测都还是绿的，因为它们各自手写的
   * 键名从未真正跟着 handler 的源码走。这条测试同时钉死两侧源码文本里的
   * 键名，任何一侧改了拼写而另一侧没跟着改，这里就会先转红。
   *
   * 正则容忍换行/缩进等空白差异，但键名与右侧表达式必须逐字匹配——不能只
   * 匹配裸的 `novelSourceItemId` 子串：`promo-link-claim.ts` 里还有一处
   * 语义完全不同的 `novelSourceItemId: scope.source.id`（`promoLink.upsert`
   * 的 `create` 数据），这条正则要求前面紧跟 `requestSummary:` 这个对象
   * 字面量，只命中 `prepareSideEffectIntent` 调用点那一处。
   */
  it("D4 关联键 novelSourceItemId：worker 写意图记录与 scheduler 读意图记录用的是同一个键名", () => {
    const handlerSource = readFileSync(
      resolve(process.cwd(), "worker/handlers/promo-link-claim.ts"),
      "utf8",
    );
    expect(handlerSource).toMatch(
      /requestSummary:\s*\{\s*offerType:\s*payload\.offerType,\s*novelSourceItemId:\s*scope\.source\.id\s*\}/,
    );

    const releaseSource = readFileSync(
      resolve(process.cwd(), "src/lib/tasks/promo-claim-release.ts"),
      "utf8",
    );
    expect(releaseSource).toContain("se.request_summary ->> 'novelSourceItemId'");
  });
});
