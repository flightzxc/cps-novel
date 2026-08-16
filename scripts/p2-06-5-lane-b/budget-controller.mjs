import {
  HTTP_ATTEMPT_CAP,
  PLANNED_UNIQUE_PAGES,
  RETRY_BUDGET,
} from "./constants.mjs";

export const SAMPLING_STOP_REASON = Object.freeze({
  PLANNED_PAGES_COMPLETE: "PLANNED_PAGES_COMPLETE",
  HTTP_ATTEMPT_CAP_REACHED: "HTTP_ATTEMPT_CAP_REACHED",
  RETRY_BUDGET_EXHAUSTED: "RETRY_BUDGET_EXHAUSTED",
  AUTHORIZATION_REJECTED: "AUTHORIZATION_REJECTED",
  CONSECUTIVE_429_LIMIT: "CONSECUTIVE_429_LIMIT",
  CONSECUTIVE_PAGE_FAILURE_LIMIT: "CONSECUTIVE_PAGE_FAILURE_LIMIT",
    PAGE_UNIVERSE_EXHAUSTED: "PAGE_UNIVERSE_EXHAUSTED",
  SAFETY_ERROR: "SAFETY_ERROR",
});

function pageNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("pageIndex must be a positive safe integer");
  return value;
}

export function createLaneBBudgetController({
  plannedUniquePages = PLANNED_UNIQUE_PAGES,
  retryBudget = RETRY_BUDGET,
  attemptCap = HTTP_ATTEMPT_CAP,
} = {}) {
  if (!Number.isSafeInteger(plannedUniquePages) || plannedUniquePages < 1) throw new TypeError("plannedUniquePages invalid");
  if (!Number.isSafeInteger(retryBudget) || retryBudget < 0) throw new TypeError("retryBudget invalid");
  if (attemptCap !== plannedUniquePages + retryBudget) {
    throw new Error("attemptCap must equal planned unique pages plus retry reserve");
  }

  const pages = new Map();
  let attempts = 0;
  let retries = 0;
  let consecutive429 = 0;
  let consecutivePageFailures = 0;
  let stopped = false;
  let stopReason = null;

  function state() {
    const successfulPages = [...pages.values()].filter(({ succeeded }) => succeeded).length;
    const failedPages = [...pages.values()].filter(({ terminalFailed }) => terminalFailed).length;
    return Object.freeze({
      attempts,
      retries,
      plannedUniquePages,
      attemptCap,
      retryBudget,
      uniquePagesStarted: pages.size,
      successfulPages,
      failedPages,
      consecutive429,
      consecutivePageFailures,
      stopped,
      stopReason,
    });
  }

  function stop(reason) {
    if (!stopped) {
      stopped = true;
      stopReason = reason;
    }
    return state();
  }

  function beforeAttempt(pageIndex) {
    pageNumber(pageIndex);
    if (stopped) return { allowed: false, state: state() };
    const existing = pages.get(pageIndex);
    const retry = existing !== undefined;
    if (!retry && pages.size >= plannedUniquePages) {
      stop(SAMPLING_STOP_REASON.PLANNED_PAGES_COMPLETE);
      return { allowed: false, state: state() };
    }
    if (retry) {
      if (existing.attempts >= 2 || existing.succeeded || retries >= retryBudget) {
        if (retries >= retryBudget) stop(SAMPLING_STOP_REASON.RETRY_BUDGET_EXHAUSTED);
        return { allowed: false, state: state() };
      }
    }
    if (attempts >= attemptCap) {
      stop(SAMPLING_STOP_REASON.HTTP_ATTEMPT_CAP_REACHED);
      return { allowed: false, state: state() };
    }
    attempts += 1;
    if (retry) retries += 1;
    const page = existing ?? { attempts: 0, succeeded: false, terminalFailed: false };
    page.attempts += 1;
    pages.set(pageIndex, page);
    return { allowed: true, retry, attemptNumberForPage: page.attempts, state: state() };
  }

  function afterAttempt(pageIndex, outcome) {
    pageNumber(pageIndex);
    const page = pages.get(pageIndex);
    if (!page || page.attempts < 1) throw new Error("afterAttempt requires a matching beforeAttempt");
    if (!outcome || typeof outcome !== "object") throw new TypeError("outcome must be a record");
    if (outcome.ok === true) {
      page.succeeded = true;
      page.terminalFailed = false;
      consecutive429 = 0;
      consecutivePageFailures = 0;
      if ([...pages.values()].filter(({ succeeded }) => succeeded).length >= plannedUniquePages) {
        stop(SAMPLING_STOP_REASON.PLANNED_PAGES_COMPLETE);
      }
      return { shouldRetry: false, state: state() };
    }

    const status = outcome.status;
    if (status === 401 || status === 403) {
      page.terminalFailed = true;
      stop(SAMPLING_STOP_REASON.AUTHORIZATION_REJECTED);
      return { shouldRetry: false, state: state() };
    }
    consecutive429 = status === 429 ? consecutive429 + 1 : 0;
    if (consecutive429 >= 2) {
      page.terminalFailed = true;
      stop(SAMPLING_STOP_REASON.CONSECUTIVE_429_LIMIT);
      return { shouldRetry: false, state: state() };
    }

    const shouldRetry = outcome.retryable === true
      && page.attempts < 2
      && retries < retryBudget
      && attempts < attemptCap;
    if (!shouldRetry) {
      page.terminalFailed = true;
      consecutivePageFailures += 1;
      if (consecutivePageFailures >= 3) stop(SAMPLING_STOP_REASON.CONSECUTIVE_PAGE_FAILURE_LIMIT);
    }
    return { shouldRetry, state: state() };
  }

  return Object.freeze({ beforeAttempt, afterAttempt, state, stop });
}
