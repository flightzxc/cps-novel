import { describe, expect, it } from "vitest";

import {
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
});
