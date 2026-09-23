import { describe, expect, it } from "vitest";

import {
  systemHoldReasonCodeLabel,
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
