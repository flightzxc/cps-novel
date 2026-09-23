import { describe, expect, it } from "vitest";

import {
  systemHoldReasonCodeLabel,
  systemHoldRecoveryHint,
  taskControlKindLabel,
  taskControlSummaryLine,
  type TaskControlSummary,
} from "@/app/(admin)/tasks/_lib/task-copy";

/**
 * X10 task control (pause/resume/abort): the tasks-list table and the
 * `/tasks/[id]` detail page both key their status rendering off this
 * module's copy helpers rather than the generic `taskStatusLabel("disabled")`
 * — every `disabled` row this feature produces carries a `taskControl`
 * marker, and the UI must render 人工暂停/人工中止/系统保护停止 as three
 * visibly distinct strings, never all collapsing to "已停用".
 */
describe("task-control copy", () => {
  it("gives each of the three kinds its own, distinct Chinese label", () => {
    const labels = ["paused", "aborted", "system_hold"].map(taskControlKindLabel);
    expect(new Set(labels).size).toBe(3);
    expect(taskControlKindLabel("paused")).toBe("人工暂停");
    expect(taskControlKindLabel("aborted")).toBe("人工中止");
    expect(taskControlKindLabel("system_hold")).toBe("系统保护停止");
  });

  it("distinguishes 人工暂停 from 系统保护停止 in the one-line list-table summary", () => {
    const paused: TaskControlSummary = { kind: "paused", source: "manual", at: "2026-09-16T00:00:00.000Z", actorId: "admin-1", reason: null };
    const systemHold: TaskControlSummary = { kind: "system_hold", source: "system", at: "2026-09-16T00:00:00.000Z", reasonCode: "credential_validation_failed" };
    const pausedLine = taskControlSummaryLine(paused);
    const systemHoldLine = taskControlSummaryLine(systemHold);
    expect(pausedLine).not.toBe(systemHoldLine);
    expect(pausedLine).toContain("人工暂停");
    expect(systemHoldLine).toContain("系统保护停止");
  });

  it("includes the failure-class reason code in a system_hold's summary line, distinguishing WHY it stopped", () => {
    const withReason = taskControlSummaryLine({ kind: "system_hold", source: "system", at: "x", reasonCode: "credential_missing" });
    const withoutReason = taskControlSummaryLine({ kind: "system_hold", source: "system", at: "x" });
    expect(withReason).toContain("credential_missing");
    expect(withReason).not.toBe(withoutReason);
  });

  it("never renders an unknown kind as if it were one of the three known ones", () => {
    expect(taskControlKindLabel("something_new")).toBe("something_new");
  });

  /**
   * Promo-claim lifecycle (阶段2 第 1 步, `docs/adr/ADR-PROMO-CLAIM-BATCH-
   * LIFECYCLE.md`): `awaiting_release` is a fifth `disabled`-row marker kind
   * — a lifecycle shard enumerated but not yet released by the scheduler
   * (D7: only the scheduler releases it, never a manual "resume"). It must
   * render as its own distinct Chinese label, never fall through to the raw
   * string and never collide with 人工暂停/人工中止/系统保护停止.
   */
  it("gives 'awaiting_release' its own distinct Chinese label, never colliding with the other four", () => {
    const labels = ["paused", "aborted", "system_hold", "awaiting_release"].map(taskControlKindLabel);
    expect(new Set(labels).size).toBe(4);
    expect(taskControlKindLabel("awaiting_release")).toBe("等待放行");
  });

  it("renders an 'awaiting_release' summary line distinct from a manual pause", () => {
    const awaitingRelease: TaskControlSummary = { kind: "awaiting_release", source: "system", at: "2026-09-23T00:00:00.000Z" };
    const paused: TaskControlSummary = { kind: "paused", source: "manual", at: "2026-09-23T00:00:00.000Z", actorId: "admin-1", reason: null };
    const line = taskControlSummaryLine(awaitingRelease);
    expect(line).toContain("等待放行");
    expect(line).not.toBe(taskControlSummaryLine(paused));
  });

  /**
   * The promo-claim lifecycle's five `system_hold` reason codes get Chinese
   * copy; every reason code this codebase already wrote before this feature
   * (e.g. `credential_validation_failed`) is untouched — falls back to the
   * raw code exactly as it did before (`task-control-copy.test.ts`'s
   * existing "includes the failure-class reason code" case above still
   * passes unmodified).
   */
  it.each([
    ["approval_expired", "批准已过期"],
    ["credential_not_ready", "凭据未就绪"],
    ["deadline_missed", "错过截止时间"],
    ["deadline_missed_twice", "连续两次错过截止时间"],
    ["lifecycle_disabled", "生命周期开关已关闭"],
  ])("translates system_hold reasonCode %s to %s", (reasonCode, expected) => {
    expect(systemHoldReasonCodeLabel(reasonCode)).toBe(expected);
    const line = taskControlSummaryLine({ kind: "system_hold", source: "system", at: "x", reasonCode });
    expect(line).toContain(expected);
    expect(line).not.toContain(reasonCode);
  });

  it("still falls back to the raw code for a system_hold reasonCode outside the lifecycle's five", () => {
    expect(systemHoldReasonCodeLabel("credential_validation_failed")).toBe("credential_validation_failed");
  });
});

/**
 * 阶段2 第4步（施工任务 3.5，设计 §5.8 暂停与恢复一览表）：每个系统暂停
 * 原因对应的中文恢复方式说明。
 */
describe("systemHoldRecoveryHint", () => {
  it("approval_expired 说明只能运营重新批准", () => {
    expect(systemHoldRecoveryHint("approval_expired")).toContain("重新批准");
  });

  it("credential_not_ready 说明凭据校验通过且剩余有效期足够后自动恢复", () => {
    const hint = systemHoldRecoveryHint("credential_not_ready");
    expect(hint).toContain("自动恢复");
  });

  it("deadline_missed 说明满足条件后自动重新放行", () => {
    const hint = systemHoldRecoveryHint("deadline_missed");
    expect(hint).toContain("自动重新放行");
  });

  it("deadline_missed_twice 默认说明需要人工处理", () => {
    const hint = systemHoldRecoveryHint("deadline_missed_twice");
    expect(hint).toContain("人工处理");
    expect(hint).not.toContain("禁止自动重试");
  });

  it("deadline_missed_twice 且 reason=unsafe_to_auto_retry 时，额外说明存在已尝试或已调用过领取接口的条目", () => {
    const hint = systemHoldRecoveryHint("deadline_missed_twice", "unsafe_to_auto_retry");
    expect(hint).toContain("禁止自动重试");
    expect(hint).not.toBe(systemHoldRecoveryHint("deadline_missed_twice"));
  });

  /**
   * Opus 复核（2026-09-24 F5）：deadline_missed_twice 的分片是 disabled——
   * 单任务"暂停/恢复/中止"里只有"中止"接受 disabled，所以运营唯一可行的
   * 人工处置路径是批次级中止。两条分支（单纯超时两次 / 有副作用风险）都
   * 必须给出这条具体做法，不能只停在"需要人工处理"这种运营不知道能做什么
   * 的空话上。
   */
  it("deadline_missed_twice 两条分支都给出具体做法：批次级中止 + 已调用接口的条目去人工核对", () => {
    const generic = systemHoldRecoveryHint("deadline_missed_twice");
    const unsafe = systemHoldRecoveryHint("deadline_missed_twice", "unsafe_to_auto_retry");
    for (const hint of [generic, unsafe]) {
      expect(hint).toContain("中止");
      expect(hint).toContain("未尝试条目");
      expect(hint).toContain("重新提交剩余书目");
      expect(hint).toContain("人工核对");
    }
  });

  it("lifecycle_disabled 说明重新开启开关后自动恢复", () => {
    const hint = systemHoldRecoveryHint("lifecycle_disabled");
    expect(hint).toContain("重新开启开关");
    expect(hint).toContain("自动恢复");
  });

  it("五个已知原因码互不相同，且未知原因码返回 undefined（不是空字符串，调用方据此决定是否渲染）", () => {
    const hints = [
      "approval_expired", "credential_not_ready", "deadline_missed", "deadline_missed_twice", "lifecycle_disabled",
    ].map((code) => systemHoldRecoveryHint(code));
    expect(new Set(hints).size).toBe(5);
    expect(systemHoldRecoveryHint("credential_validation_failed")).toBeUndefined();
  });
});
