import { describe, expect, it } from "vitest";

import {
  isPausedByTaskControl,
  mergeTaskControlResult,
  readTaskControlMarker,
  type TaskControlMarker,
} from "@/lib/tasks/task-control";

/**
 * `generic_task_status_check`/`channel_sync_task_status_check` (real Postgres
 * CHECK constraints, `prisma/migrations/20260803090000_p1_initial_schema`)
 * only allow `status` to be one of six literals with no room for a dedicated
 * `paused`/`aborted`/`system_hold` value. This module is the entire safety
 * net that makes reusing `'disabled'` for all three (plus its three
 * pre-existing, unrelated meanings) actually distinguishable — these tests
 * are the load-bearing proof that an unmarked `disabled` row and a marked
 * one read differently, and that a marked write never destroys a taskType's
 * own unrelated `result` fields.
 */
describe("task-control marker", () => {
  const marker: TaskControlMarker = {
    kind: "paused",
    source: "manual",
    at: "2026-09-16T00:00:00.000Z",
    actorId: "admin-1",
    reason: "operator requested",
  };

  it("round-trips a written marker through readTaskControlMarker", () => {
    const result = mergeTaskControlResult(null, marker);
    expect(readTaskControlMarker(result)).toEqual(marker);
  });

  it("preserves a taskType's own unrelated result fields when merging the marker in", () => {
    const existing = { stopReason: "upstream_error", catalogObservedTotal: 42 };
    const merged = mergeTaskControlResult(existing, marker);
    expect(merged).toMatchObject({ stopReason: "upstream_error", catalogObservedTotal: 42, taskControl: marker });
  });

  it("treats an unmarked disabled row's result as 'not ours' — legacy out-of-band rows, feature-flag-off tasks, and catalog-batch double-gate refusals all read the same way", () => {
    expect(readTaskControlMarker(null)).toBeUndefined();
    expect(readTaskControlMarker({})).toBeUndefined();
    expect(readTaskControlMarker({ enumerationStatus: "completed" })).toBeUndefined();
    expect(isPausedByTaskControl(null)).toBe(false);
  });

  it("rejects a malformed or foreign taskControl value rather than guessing", () => {
    expect(readTaskControlMarker({ taskControl: "not an object" })).toBeUndefined();
    expect(readTaskControlMarker({ taskControl: { kind: "not_a_real_kind", source: "manual", at: "x" } })).toBeUndefined();
    expect(readTaskControlMarker({ taskControl: { kind: "paused", source: "not_a_real_source", at: "x" } })).toBeUndefined();
    expect(readTaskControlMarker({ taskControl: { kind: "paused", source: "manual" } })).toBeUndefined(); // missing `at`
  });

  it("isPausedByTaskControl is true only for kind 'paused', never 'aborted' or 'system_hold'", () => {
    expect(isPausedByTaskControl(mergeTaskControlResult(null, marker))).toBe(true);
    const aborted: TaskControlMarker = { ...marker, kind: "aborted" };
    const systemHold: TaskControlMarker = { kind: "system_hold", source: "system", at: marker.at, reasonCode: "credential_validation_failed" };
    expect(isPausedByTaskControl(mergeTaskControlResult(null, aborted))).toBe(false);
    expect(isPausedByTaskControl(mergeTaskControlResult(null, systemHold))).toBe(false);
  });

  it("drops unknown extra keys inside the marker rather than passing them through", () => {
    const raw = { taskControl: { kind: "paused", source: "manual", at: "x", extra: "should not survive" } };
    expect(readTaskControlMarker(raw)).toEqual({ kind: "paused", source: "manual", at: "x", actorId: null, reason: null });
  });
});
