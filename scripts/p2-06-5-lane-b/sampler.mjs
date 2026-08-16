import { createHash } from "node:crypto";

import { createLaneBBudgetController, SAMPLING_STOP_REASON } from "./budget-controller.mjs";
import { createLaneBReadClient } from "./http-client.mjs";
import { parseLaneBPage } from "./upstream-parser.mjs";
import {
  buildPageValueScores,
  deriveLanguageQuotas,
  selectAdaptiveWavePages,
  selectInitialEquidistantPages,
  selectQuotaBooks,
} from "./sampling.mjs";
import { PLANNED_UNIQUE_PAGES, TARGET_BOOKS, WAVE_COUNT } from "./constants.mjs";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uniqueTokens(book, observationsByBook) {
  return [...new Set((observationsByBook.get(book.sampleBookKey) ?? []).map(({ exactRawToken }) => exactRawToken))];
}

function tokenIdentity(book, token) {
  return sha256(JSON.stringify([book.sourceScope, book.rawLanguageScope, token]));
}

function buildPageMetrics(
  pageBooks,
  observationsByBook,
  tokenCarrierCounts,
  quotaPlan,
  priorLanguageCounts,
  previouslySeenTokens,
) {
  const books = [...new Map(pageBooks.map((book) => [book.sampleBookKey, book])).values()];
  if (books.length === 0) return null;
  const tokens = new Set();
  let underQuota = 0;
  let underFive = 0;
  const quotaByLanguage = new Map(quotaPlan.quotas.map((item) => [item.rawLanguageIdentity, item.quota]));
  for (const book of books) {
    const ids = uniqueTokens(book, observationsByBook).map((token) => tokenIdentity(book, token));
    ids.filter((id) => !previouslySeenTokens.has(id)).forEach((id) => tokens.add(id));
    if ((priorLanguageCounts.get(book.rawLanguageScope) ?? 0) < (quotaByLanguage.get(book.rawLanguageScope) ?? 0)) {
      underQuota += 1;
    }
    if (ids.some((id) => (tokenCarrierCounts.get(id) ?? 0) < 5)) underFive += 1;
  }
  return {
    uniqueBookCount: books.length,
    newDistinctTokenCount: tokens.size,
    underQuotaLanguageBookCount: underQuota,
    underFiveTokenBookCount: underFive,
  };
}

function aggregatePageValueFacts({ books, observations }) {
  const observationsByBook = new Map();
  for (const observation of observations) {
    const bucket = observationsByBook.get(observation.sampleBookKey) ?? [];
    bucket.push(observation);
    observationsByBook.set(observation.sampleBookKey, bucket);
  }
  const quotaBooks = books.map((book, index) => ({
    ...book,
    bookIdentity: book.sampleBookKey,
    rawLanguageIdentity: book.rawLanguageScope,
    acquisitionIndex: book.acquisitionIndex ?? index + 1,
    tokenIdentities: uniqueTokens(book, observationsByBook).map((token) => tokenIdentity(book, token)),
  }));
  const quotaPlan = deriveLanguageQuotas(quotaBooks, { targetBooks: TARGET_BOOKS });
  const tokenCarrierCounts = new Map();
  for (const book of quotaBooks) {
    for (const token of book.tokenIdentities) tokenCarrierCounts.set(token, (tokenCarrierCounts.get(token) ?? 0) + 1);
  }
  const byPage = new Map();
  for (const book of books) {
    const bucket = byPage.get(book.pageIndex) ?? [];
    bucket.push(book);
    byPage.set(book.pageIndex, bucket);
  }
  const previouslySeenTokens = new Set();
  const priorLanguageCounts = new Map();
  const pageMetrics = [];
  const orderedPages = [...byPage.entries()].sort((left, right) => {
    const leftAcquisition = Math.min(...left[1].map(({ acquisitionIndex }) => acquisitionIndex ?? Number.MAX_SAFE_INTEGER));
    const rightAcquisition = Math.min(...right[1].map(({ acquisitionIndex }) => acquisitionIndex ?? Number.MAX_SAFE_INTEGER));
    return leftAcquisition - rightAcquisition || left[0] - right[0];
  });
  for (const [pageIndex, pageBooks] of orderedPages) {
    pageMetrics.push({
      pageIndex,
      ...buildPageMetrics(
        pageBooks,
        observationsByBook,
        tokenCarrierCounts,
        quotaPlan,
        priorLanguageCounts,
        previouslySeenTokens,
      ),
    });
    for (const book of pageBooks) {
      priorLanguageCounts.set(
        book.rawLanguageScope,
        (priorLanguageCounts.get(book.rawLanguageScope) ?? 0) + 1,
      );
      for (const token of uniqueTokens(book, observationsByBook)) {
        previouslySeenTokens.add(tokenIdentity(book, token));
      }
    }
  }
  return pageMetrics;
}

export function buildAdaptivePageMetrics(input) {
  return aggregatePageValueFacts(input);
}

export function resolveLaneBManifestStatus({
  requestedStatus,
  selectionComplete,
  languageQuotaSatisfiedOrExhausted,
}) {
  return requestedStatus === "COMPLETE" && selectionComplete && languageQuotaSatisfiedOrExhausted
    ? "COMPLETE"
    : "PARTIAL";
}

export function selectFinalBooks(books, observations) {
  const observationsByBook = new Map();
  for (const observation of observations) {
    const bucket = observationsByBook.get(observation.sampleBookKey) ?? [];
    bucket.push(observation);
    observationsByBook.set(observation.sampleBookKey, bucket);
  }
  const candidateBooks = books.map((book, index) => ({
    ...book,
    bookIdentity: book.sampleBookKey,
    rawLanguageIdentity: book.rawLanguageScope,
    acquisitionIndex: book.acquisitionIndex ?? index + 1,
    tokenIdentities: uniqueTokens(book, observationsByBook).map((token) => tokenIdentity(book, token)),
  }));
  return selectQuotaBooks({ books: candidateBooks, targetBooks: TARGET_BOOKS });
}

function pageUniverse(totalCount, pageSize = 100) {
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) throw new Error("totalCount invalid");
  return Math.max(1, Math.ceil(totalCount / pageSize));
}

/**
 * Execute the frozen B1 read plan. This function never creates DB tasks and
 * has no database dependency. Every network attempt passes through the fixed
 * endpoint client and budget controller.
 * @param {{credentialFile?:string, credentialCapsule?:object, repoRoot:string, channelAppId:string, store:any, fetchImpl?:typeof fetch, sleep?:(milliseconds:number)=>Promise<void>, now?:()=>Date}} [options]
 */
export async function runLaneBSampling({
  credentialFile,
  credentialCapsule,
  repoRoot,
  channelAppId,
  store,
  fetchImpl,
  sleep,
  now = () => new Date(),
} = {}) {
  const client = await createLaneBReadClient({
    credentialFile,
    credentialCapsule,
    repoRoot,
    fetchImpl,
    sleep,
    now: () => now().getTime(),
  });
  const budget = createLaneBBudgetController();
  const sampledPages = new Set();
  const successfulPages = new Set();
  const pageAttempts = new Map();
  const firstBooks = new Map();
  const allBooks = [];
  const allObservations = [];
  const rawPageArtifacts = [];
  const requestAudits = [];
  const duplicateAudits = [];
  let duplicateBookObservationCount = 0;
  let totalCount = null;
  let totalPages = null;
  let acquisitionIndex = 0;
  let finalizationPromise = null;

  async function fetchPage(pageIndex, selection) {
    sampledPages.add(pageIndex);
    while (true) {
      const gate = budget.beforeAttempt(pageIndex);
      if (!gate.allowed) return;
      const attemptNumber = gate.attemptNumberForPage;
      pageAttempts.set(pageIndex, attemptNumber);
      let outcome;
      try {
        outcome = await client.requestPage(pageIndex);
      } catch (error) {
        budget.stop(SAMPLING_STOP_REASON.SAFETY_ERROR);
        const fallbackMs = now().getTime();
        outcome = {
          ok: false,
          pageIndex,
          status: null,
          rawText: null,
          parsed: null,
          errorCode: error?.code ?? "client_safety_error",
          retryable: false,
          startedAtMs: Number.isFinite(error?.startedAtMs) ? error.startedAtMs : fallbackMs,
          finishedAtMs: Number.isFinite(error?.finishedAtMs) ? error.finishedAtMs : fallbackMs,
          durationMs: Number.isFinite(error?.durationMs) ? error.durationMs : 0,
        };
      }
      if (!Number.isSafeInteger(outcome.startedAtMs) || !Number.isSafeInteger(outcome.finishedAtMs)
        || outcome.finishedAtMs < outcome.startedAtMs) {
        throw new Error("Lane B client outcome timing is invalid");
      }
      const requestStartedAt = new Date(outcome.startedAtMs).toISOString();
      const responseReceivedAt = new Date(outcome.finishedAtMs).toISOString();
      const audit = {
        schemaVersion: 1,
        pageIndex,
        attemptNumber,
        isRetry: gate.retry,
        selection,
        requestedAt: requestStartedAt,
        requestStartedAt,
        responseReceivedAt,
        status: outcome.status,
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        retryable: outcome.retryable,
        durationMs: outcome.durationMs,
      };
      if (typeof outcome.rawText === "string") {
        client.scanArtifactText(outcome.rawText);
        rawPageArtifacts.push(await store.writeRawPage({
          pageIndex,
          attempt: attemptNumber,
          rawText: outcome.rawText,
        }));
      }
      if (!outcome.ok) {
        requestAudits.push(audit);
        await store.appendJsonl(store.paths.requestAudit, [audit]);
        const decision = budget.afterAttempt(pageIndex, outcome);
        if (decision.shouldRetry) continue;
        return;
      }
      let parsed;
      try {
        parsed = parseLaneBPage({
          payload: outcome.parsed,
          pageIndex,
          fetchedAt: requestStartedAt,
          channelAppId,
        });
      } catch {
        audit.ok = false;
        audit.errorCode = "upstream_schema_invalid";
        audit.retryable = true;
        requestAudits.push(audit);
        await store.appendJsonl(store.paths.requestAudit, [audit]);
        const schemaFailure = {
          ...outcome,
          ok: false,
          errorCode: "upstream_schema_invalid",
          retryable: true,
        };
        const decision = budget.afterAttempt(pageIndex, schemaFailure);
        if (decision.shouldRetry) continue;
        return;
      }
      if (totalCount === null) {
        totalCount = parsed.totalCount;
        totalPages = pageUniverse(totalCount);
      } else if (parsed.totalCount !== totalCount) {
        audit.catalogTotalChangedFrom = totalCount;
        audit.catalogTotalChangedTo = parsed.totalCount;
      }
      requestAudits.push(audit);
      await store.appendJsonl(store.paths.requestAudit, [audit]);
      budget.afterAttempt(pageIndex, outcome);
      const acceptedBooks = [];
      const acceptedRows = new Set();
      for (const book of parsed.books) {
        if (firstBooks.has(book.sampleBookKey)) {
          const duplicate = {
            sampleBookKey: book.sampleBookKey,
            firstSeen: firstBooks.get(book.sampleBookKey),
            duplicatePageIndex: book.pageIndex,
            duplicateRowIndex: book.rowIndex,
            observedAt: book.fetchedAt,
          };
          duplicateAudits.push(duplicate);
          duplicateBookObservationCount += 1;
          continue;
        }
        acquisitionIndex += 1;
        const accepted = { ...book, acquisitionIndex };
        firstBooks.set(book.sampleBookKey, {
          pageIndex: book.pageIndex,
          rowIndex: book.rowIndex,
          fetchedAt: book.fetchedAt,
          acquisitionIndex,
        });
        acceptedBooks.push(accepted);
        acceptedRows.add(book.rowIndex);
        allBooks.push(accepted);
      }
      // Row identity matters here: the same book may occur twice on one page.
      // Only observations belonging to the first accepted row are facts.
      const acceptedObservations = parsed.observations.filter(({ rowIndex }) => acceptedRows.has(rowIndex));
      const acceptedAnomalies = parsed.anomalies.filter(({ rowIndex }) => acceptedRows.has(rowIndex));
      allObservations.push(...acceptedObservations);
      await store.appendJsonl(store.paths.bookSamples, acceptedBooks);
      await store.appendJsonl(store.paths.tokenObservations, acceptedObservations);
      await store.appendJsonl(store.paths.structureAnomalies, acceptedAnomalies);
      await store.appendJsonl(store.paths.duplicateAudit, duplicateAudits.splice(0));
      successfulPages.add(pageIndex);
      return;
    }
  }

  try {
    // Page 1 is both the total-count refresh and the first equidistant page.
    await fetchPage(1, { wave: 0, reason: "TOTAL_COUNT_REFRESH_AND_EQUIDISTANT" });
    if (totalPages === null || budget.state().stopped) {
      return await finalize("PARTIAL");
    }
    const initial = selectInitialEquidistantPages(totalPages).filter((page) => page !== 1);
    for (const page of initial) {
      if (budget.state().stopped) break;
      await fetchPage(page, { wave: 0, reason: "EQUIDISTANT_INITIAL" });
    }

    for (let wave = 1; wave <= WAVE_COUNT && !budget.state().stopped; wave += 1) {
      const pageMetrics = aggregatePageValueFacts({ books: allBooks, observations: allObservations });
      const allowedMetrics = buildPageValueScores(pageMetrics).filter(({ pageIndex }) => successfulPages.has(pageIndex));
      const plan = selectAdaptiveWavePages({
        totalPages,
        sampledPages,
        pageMetrics: allowedMetrics,
      });
      if (plan.pages.length === 0) {
        budget.stop(SAMPLING_STOP_REASON.PAGE_UNIVERSE_EXHAUSTED);
        break;
      }
      for (const item of plan.pagePlan) {
        if (budget.state().stopped) break;
        await fetchPage(item.pageIndex, { wave, ...item });
      }
    }
    return await finalize(budget.state().successfulPages >= PLANNED_UNIQUE_PAGES ? "COMPLETE" : "PARTIAL");
  } catch (error) {
    if (store.paths.rawManifest) {
      try {
        const partial = await finalize("PARTIAL");
        return { ...partial, fatalErrorCode: error?.code ?? "sampling_failed" };
      } catch {
        throw error;
      }
    }
    throw error;
  } finally {
    client.dispose();
  }

  async function finalize(status) {
    if (finalizationPromise !== null) return finalizationPromise;
    finalizationPromise = finalizeOnce(status);
    return finalizationPromise;
  }

  async function finalizeOnce(status) {
    const selection = selectFinalBooks(allBooks, allObservations);
    const selectionRecords = selection.selectionAudit.map((entry) => ({
      sampleBookKey: entry.bookIdentity,
      selectedSampleIndex: entry.selectedSampleIndex,
      selectionReason: entry.selectionReason,
    }));
    const budgetState = budget.state();
    const requestBudgetQaPassed = budgetState.attempts <= 250
      && budgetState.retries <= 10
      && budgetState.uniquePagesStarted <= 240;
    const languageQuotaSatisfiedOrExhausted = selection.quotaSatisfied
      || selection.quotaResults.every(({ deficit, available, quota, selectedForQuota }) => (
        deficit === 0 || (available < quota && selectedForQuota === available)
      ));
    const manifest = {
      schema_version: 1,
      run_id: store.paths.runDir.split(/[\\/]/u).at(-1),
      channel_app_id: channelAppId,
      status: resolveLaneBManifestStatus({
        requestedStatus: status,
        selectionComplete: selection.complete,
        languageQuotaSatisfiedOrExhausted,
      }),
      total_count_refreshed: totalCount,
      total_pages_refreshed: totalPages,
      planned_unique_pages: 240,
      retry_budget: 10,
      http_attempt_cap: 250,
      actual_http_attempts: budgetState.attempts,
      actual_unique_pages: budgetState.uniquePagesStarted,
      successful_pages: budgetState.successfulPages,
      retry_attempts: budgetState.retries,
      stop_reason: budgetState.stopReason,
      candidate_unique_books: allBooks.length,
      final_sample_books: selection.selectedCount,
      target_unique_books: TARGET_BOOKS,
      duplicate_book_observations: duplicateBookObservationCount,
      language_quota_satisfied_or_exhausted: languageQuotaSatisfiedOrExhausted,
      raw_round_trip_qa_passed: false,
      request_budget_qa_passed: requestBudgetQaPassed,
      raw_page_artifacts: rawPageArtifacts,
    };
    await store.finalizeRun({ manifest, selectionRecords });
    return { manifest, selection, books: allBooks, observations: allObservations, requestAudits };
  }
}
