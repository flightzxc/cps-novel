/**
 * P2-06.5 Lane B has one read-only catalogue request shape.  Keeping the
 * endpoint and every request field here prevents a sampling caller from
 * quietly widening the upstream operation.
 */

export const LANE_B_ENDPOINT = "https://kocserver-cn.cdreader.com/api/v1/res/getlistpc";

export const PAGE_SIZE = 100;
export const TARGET_BOOKS = 10_000;
export const HISTORICAL_CATALOG_ROWS = 95_479;
export const SOURCE_LANGUAGE_UPPER_BOUND = 18;

export const INITIAL_PAGE_COUNT = 20;
export const WAVE_COUNT = 22;
export const PAGES_PER_WAVE = 10;
export const EXPLORATION_PAGES_PER_WAVE = 6;
export const HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE = 4;
export const PLANNED_UNIQUE_PAGES = 240;

export const RETRY_BUDGET = 10;
export const HTTP_ATTEMPT_CAP = 250;
export const MIN_REQUEST_START_INTERVAL_MS = 1_000;

export const REQUEST_BODY_BASE = Object.freeze({
  name: "",
  orderType: 1,
  pageSize: PAGE_SIZE,
  projectType: 1,
});

if (INITIAL_PAGE_COUNT + (WAVE_COUNT * PAGES_PER_WAVE) !== PLANNED_UNIQUE_PAGES) {
  throw new Error("Lane B unique-page budget constants are inconsistent");
}
if (EXPLORATION_PAGES_PER_WAVE + HIGH_VALUE_NEIGHBOR_PAGES_PER_WAVE !== PAGES_PER_WAVE) {
  throw new Error("Lane B adaptive-wave constants are inconsistent");
}
if (PLANNED_UNIQUE_PAGES + RETRY_BUDGET !== HTTP_ATTEMPT_CAP) {
  throw new Error("Lane B HTTP-attempt budget constants are inconsistent");
}

/** Return a fresh body containing only the five production-proven fields. */
export function buildLaneBRequestBody(pageIndex) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) {
    throw new TypeError("pageIndex must be a positive safe integer");
  }
  return {
    name: REQUEST_BODY_BASE.name,
    orderType: REQUEST_BODY_BASE.orderType,
    pageIndex,
    pageSize: REQUEST_BODY_BASE.pageSize,
    projectType: REQUEST_BODY_BASE.projectType,
  };
}
