import { describe, expect, it } from "vitest";

import {
  SAMPLING_STOP_REASON,
  createLaneBBudgetController,
} from "../../../scripts/p2-06-5-lane-b/budget-controller.mjs";

describe("P2-06.5 Lane B request budget state machine", () => {
  it("counts every HTTP attempt, allows one retry per page, and never spends reserve on new pages", () => {
    const budget = createLaneBBudgetController({ plannedUniquePages: 2, retryBudget: 1, attemptCap: 3 });
    expect(budget.beforeAttempt(1)).toMatchObject({ allowed: true, retry: false, attemptNumberForPage: 1 });
    expect(budget.afterAttempt(1, { ok: false, status: 500, retryable: true }).shouldRetry).toBe(true);
    expect(budget.beforeAttempt(1)).toMatchObject({ allowed: true, retry: true, attemptNumberForPage: 2 });
    budget.afterAttempt(1, { ok: true, status: 200 });
    expect(budget.beforeAttempt(2)).toMatchObject({ allowed: true, retry: false });
    budget.afterAttempt(2, { ok: true, status: 200 });
    expect(budget.state()).toMatchObject({ attempts: 3, retries: 1, successfulPages: 2, stopped: true, stopReason: SAMPLING_STOP_REASON.PLANNED_PAGES_COMPLETE });
    expect(budget.beforeAttempt(3).allowed).toBe(false);
  });

  it.each([401, 403])("stops immediately on HTTP %i", (status) => {
    const budget = createLaneBBudgetController({ plannedUniquePages: 3, retryBudget: 1, attemptCap: 4 });
    budget.beforeAttempt(1);
    budget.afterAttempt(1, { ok: false, status, retryable: false });
    expect(budget.state()).toMatchObject({ stopped: true, stopReason: SAMPLING_STOP_REASON.AUTHORIZATION_REJECTED });
  });

  it("stops on two consecutive 429 attempts", () => {
    const budget = createLaneBBudgetController({ plannedUniquePages: 3, retryBudget: 2, attemptCap: 5 });
    budget.beforeAttempt(1);
    expect(budget.afterAttempt(1, { ok: false, status: 429, retryable: true }).shouldRetry).toBe(true);
    budget.beforeAttempt(1);
    budget.afterAttempt(1, { ok: false, status: 429, retryable: true });
    expect(budget.state()).toMatchObject({ stopped: true, stopReason: SAMPLING_STOP_REASON.CONSECUTIVE_429_LIMIT });
  });

  it("stops after three consecutive terminal page failures", () => {
    const budget = createLaneBBudgetController({ plannedUniquePages: 5, retryBudget: 0, attemptCap: 5 });
    for (const pageIndex of [1, 2, 3]) {
      budget.beforeAttempt(pageIndex);
      budget.afterAttempt(pageIndex, { ok: false, status: 400, retryable: false });
    }
    expect(budget.state()).toMatchObject({ stopped: true, stopReason: SAMPLING_STOP_REASON.CONSECUTIVE_PAGE_FAILURE_LIMIT, failedPages: 3 });
  });
});
