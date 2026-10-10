import { beforeEach, describe, expect, it } from "vitest";

import type { IndexNowBackfillManifest } from "@/lib/indexnow/backfill-manifest";
import { resumeIndexNowDelivery } from "@/lib/indexnow/delivery-control";
import { enqueueIndexNowFirstPublish } from "@/lib/indexnow/outbox";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { collectIndexNowStatus } from "../../../scripts/indexnow-status";
import {
  applyBackfill,
  assertBackfillStopConditions,
  collectBackfillGlobalSummary,
  type ApplyBackfillDeps,
  type ApplyBackfillOptions,
} from "../../../scripts/indexnow-backfill-apply";
import { buildBackfillManifest, selectBackfillCandidates } from "../../../scripts/indexnow-backfill-manifest";
import { FakeIndexNowDb, installTestSiteUrl, testEnv } from "./fake-db";
import { ENABLED_ALL_ENV, LOCALE_OK, RESUME_ACTOR, T0, fetchStub, runDelivery, runSweep, urlListOf } from "./helpers";

installTestSiteUrl();

beforeEach(() => invalidateSiteSettingCache());

function newFake(): FakeIndexNowDb {
  return new FakeIndexNowDb().setNow(T0);
}

const uuid = (index: number) => `0b1c2d3e-0000-4000-8000-${String(index).padStart(12, "0")}`;

function seedArticles(fake: FakeIndexNowDb, count: number, locales: readonly string[] = ["en"], firstIndex = 1) {
  for (let offset = 0; offset < count; offset++) {
    const index = firstIndex + offset;
    fake.seedArticle({
      id: uuid(index),
      novelId: `novel-${index}`,
      locale: locales[offset % locales.length]!,
      slug: `slug-${index}`,
      publicPageShortId: `p${index}`,
      publishedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  }
}

async function manifestOf(fake: FakeIndexNowDb): Promise<IndexNowBackfillManifest> {
  const selection = await selectBackfillCandidates(fake.asPrismaClient(), { eligibilityOptions: LOCALE_OK });
  return buildBackfillManifest(selection.candidates, { releaseCommit: "test-commit", expectedCount: selection.candidates.length, note: "test" });
}

/** Plays the part of the running system: sweep → batch task → delivery, until nothing more can move. */
function system(fake: FakeIndexNowDb, fetchImpl: ReturnType<typeof fetchStub>) {
  return async () => {
    for (let round = 0; round < 25; round++) {
      const swept = await runSweep(fake);
      if (swept.created === 0) return;
      await runDelivery(fake, fetchImpl);
      for (const task of fake.genericTasks.values()) task.status = "completed";
    }
    throw new Error("system() did not settle");
  };
}

function harness(fake: FakeIndexNowDb, fetchImpl: ReturnType<typeof fetchStub>, extra: Partial<ApplyBackfillDeps> = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const deps: ApplyBackfillDeps = {
    env: ENABLED_ALL_ENV,
    eligibilityOptions: LOCALE_OK,
    log: (line) => lines.push(line),
    waitForChunk: async () => system(fake, fetchImpl)(),
    ...extra,
  };
  const options = (overrides: Partial<ApplyBackfillOptions> = {}): ApplyBackfillOptions => ({ write: true, offset: 0, chunkSize: 3, ...overrides });
  return { lines, deps, options };
}

describe("dry run", () => {
  it("writes nothing, waits for nothing, and reports eligible / drifted / alreadyHasDelivery", async () => {
    const fake = newFake();
    seedArticles(fake, 7);
    const manifest = await manifestOf(fake);
    fake.articles.get(uuid(2))!.slug = "renamed"; // drift
    await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: uuid(3), source: "publish" }, ENABLED_ALL_ENV, LOCALE_OK); // already has a record
    const writes = fake.writes;
    const { deps, options, lines } = harness(fake, fetchStub(() => ({ status: 200 })), { waitForChunk: async () => { throw new Error("must not wait in a dry run"); } });

    const report = await applyBackfill(fake.asPrismaClient(), manifest, options({ write: false }), deps);
    expect(fake.writes).toBe(writes);
    expect(report).toMatchObject({ mode: "dry-run", selectedUrls: 7, eligibleUrls: 5, driftedUrls: 1, alreadyHasDeliveryUrls: 1, enqueuedUrls: 0 });
    expect(lines.filter((line) => "chunkIndex" in line)).toHaveLength(3); // 3 + 3 + 1
  });

  it("a dry run needs none of the write flags", async () => {
    const fake = newFake();
    seedArticles(fake, 2);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })), { env: testEnv() });
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options({ write: false }), deps)).resolves.toMatchObject({ eligibleUrls: 2 });
  });
});

describe("[20] write mode preconditions", () => {
  it("refuses when delivery is switched off in this process (it could never wait for the chunk) and when outbox is", async () => {
    const fake = newFake();
    seedArticles(fake, 2);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    await expect(
      applyBackfill(fake.asPrismaClient(), manifest, options(), { ...deps, env: testEnv({ ...ENABLED_ALL_ENV, FEATURE_INDEXNOW_DELIVERY: "false" }) }),
    ).rejects.toThrow("delivery_disabled_cannot_wait");
    await expect(
      applyBackfill(fake.asPrismaClient(), manifest, options(), { ...deps, env: testEnv({ ...ENABLED_ALL_ENV, FEATURE_INDEXNOW_OUTBOX: undefined }) }),
    ).rejects.toThrow("outbox_disabled");
    expect(fake.outbox.size).toBe(0);
  });
});

describe("full run", () => {
  it("enqueues in chunks, waits for each chunk, and reports every count with its unit", async () => {
    const fake = newFake();
    seedArticles(fake, 7);
    const manifest = await manifestOf(fake);
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const { deps, options, lines } = harness(fake, fetchImpl);

    const report = await applyBackfill(fake.asPrismaClient(), manifest, options(), deps);
    expect(report).toMatchObject({
      mode: "apply",
      chunks: 3,
      enqueuedUrls: 7,
      acceptedUrls: 7,
      accepted200Urls: 7,
      accepted202Urls: 0,
      notAcceptedUrls: 0,
      httpRequests: 3,
    });
    expect([...fake.outbox.values()].every((row) => row.status === "accepted" && row.source === "backfill")).toBe(true);

    // [27] every counter carries its unit; the unit-less names are gone.
    const chunkLines = lines.filter((line) => "chunkIndex" in line);
    expect(chunkLines).toHaveLength(3);
    for (const line of chunkLines) {
      for (const required of ["chunkIndex", "urls", "enqueuedUrls", "alreadyHasDeliveryUrls", "driftedUrls", "acceptedUrls", "accepted200Urls", "accepted202Urls", "notAcceptedUrls", "httpRequests", "elapsedMs"]) {
        expect(line).toHaveProperty(required);
      }
      for (const forbidden of ["count", "completed", "enqueued", "accepted", "notAccepted", "drifted", "eligible", "total"]) {
        expect(line).not.toHaveProperty(forbidden);
      }
    }
    const summary = lines.find((line) => "summary" in line)!.summary as Record<string, unknown>;
    for (const forbidden of ["count", "completed", "enqueued", "accepted", "notAccepted", "drifted", "eligible", "total"]) {
      expect(summary).not.toHaveProperty(forbidden);
    }
  });

  it("[17] de-duplicates per ARTICLE: an article that gained a record of any revision/source after the manifest was cut is counted alreadyHasDelivery and gets no new row; a re-run adds nothing", async () => {
    const fake = newFake();
    seedArticles(fake, 4);
    const manifest = await manifestOf(fake);
    // A record from the live publish path appears for article 2 (different source; and its revision will differ from any later one).
    await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: uuid(2), source: "publish" }, ENABLED_ALL_ENV, LOCALE_OK);
    fake.articles.get(uuid(2))!.updatedAt = new Date("2026-02-02T00:00:00.000Z"); // a newer revision would be a NEW (url, revision) row if we keyed on that
    const rowsBefore = fake.outbox.size;
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const { deps, options, lines } = harness(fake, fetchImpl);

    const first = await applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 10 }), deps);
    expect(first).toMatchObject({ alreadyHasDeliveryUrls: 1, enqueuedUrls: 3 });
    expect(fake.outbox.size).toBe(rowsBefore + 3);
    expect([...fake.outbox.values()].filter((row) => row.articleId === uuid(2))).toHaveLength(1);

    const second = await applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 10 }), { ...deps, log: (line) => lines.push(line) });
    expect(second).toMatchObject({ alreadyHasDeliveryUrls: 4, enqueuedUrls: 0 });
    expect(fake.outbox.size).toBe(rowsBefore + 3);
  });

  it("202 responses are counted separately and flagged with the key-validation notice", async () => {
    const fake = newFake();
    seedArticles(fake, 3);
    const manifest = await manifestOf(fake);
    const { deps, options, lines } = harness(fake, fetchStub(() => ({ status: 202 })));
    const report = await applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 10 }), deps);
    expect(report).toMatchObject({ acceptedUrls: 3, accepted200Urls: 0, accepted202Urls: 3, notAcceptedUrls: 0 });
    expect(lines.find((line) => "chunkIndex" in line)).toMatchObject({ accepted202Urls: 3, notice: "协议已接收，密钥验证待完成" });
  });

  it("delivery_stalled: a chunk still pending/processing after 10 minutes fails the run", async () => {
    const fake = newFake();
    seedArticles(fake, 2);
    const manifest = await manifestOf(fake);
    let clock = 0;
    const slept: number[] = [];
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })), {
      waitForChunk: undefined,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    delete deps.waitForChunk; // use the real polling wait; nothing delivers in this test
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 10 }), deps)).rejects.toThrow("delivery_stalled");
    expect(slept.every((ms) => ms === 10_000)).toBe(true); // polled every 10 seconds
    expect(clock).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

describe("[18] stop condition (a) — any single 422 stops; a resume lets the run continue", () => {
  it("ONE 422 (not four) in a previous chunk stops before the next chunk; after a resume the same manifest runs to the end", async () => {
    const fake = newFake();
    seedArticles(fake, 9);
    const manifest = await manifestOf(fake);
    let first = true;
    const fetchImpl = fetchStub(() => {
      if (first) {
        first = false;
        return { status: 422 };
      }
      return { status: 200 };
    });
    const { deps, options } = harness(fake, fetchImpl);

    await expect(applyBackfill(fake.asPrismaClient(), manifest, options(), deps)).rejects.toThrow(/breaker is open/);
    expect(fake.outbox.size).toBe(3); // only chunk 0 was ever enqueued
    expect([...fake.outbox.values()].every((row) => row.status === "retry_wait")).toBe(true);

    // The history of that one 422 does not stall the run forever: resume, then re-run.
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "operator confirmed config" });
    const rerun = await applyBackfill(fake.asPrismaClient(), manifest, options(), deps);
    expect(rerun).toMatchObject({ alreadyHasDeliveryUrls: 3, enqueuedUrls: 6 });
    expect([...fake.outbox.values()].every((row) => row.status === "accepted")).toBe(true);
  });
});

describe("(b) a 429 wait stops the run", () => {
  it("after a 429 the next chunk's pre-check fails on the wait", async () => {
    const fake = newFake();
    seedArticles(fake, 6);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 429 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options(), deps)).rejects.toThrow(/429 wait active until/);
    expect(fake.outbox.size).toBe(3);
  });
});

describe("[19] stop conditions (c), (d), (e) over the whole table", () => {
  function seedBackfillRows(fake: FakeIndexNowDb, statuses: Record<string, number>, extra: Record<string, unknown> = {}) {
    let index = 0;
    for (const [status, count] of Object.entries(statuses)) {
      for (let n = 0; n < count; n++, index++) {
        fake.seedOutbox({ id: `bf-${index}`, url: `https://x.example/bf/${index}`, revision: 1n, source: "backfill", status, ...extra });
      }
    }
  }

  it("(c) the terminal-failure ratio is computed in SQL over ALL backfill rows, not the current chunk: 6 of 100 stops, 5 of 100 does not", async () => {
    const stops = newFake();
    seedBackfillRows(stops, { accepted: 94, permanent_failed: 6 });
    const summary = await collectBackfillGlobalSummary(stops.asPrismaClient());
    expect(summary.backfillUrls).toEqual({ total: 100, permanentFailed: 6, deadLetter: 0 });
    expect(() => assertBackfillStopConditions(summary)).toThrow(/ratio exceeds 5%/);

    const passes = newFake();
    seedBackfillRows(passes, { accepted: 95, permanent_failed: 5 });
    const passingSummary = await collectBackfillGlobalSummary(passes.asPrismaClient());
    expect(() => assertBackfillStopConditions(passingSummary)).not.toThrow();
  });

  it("(c) rows from other sources do not dilute or inflate the backfill ratio", async () => {
    const fake = newFake();
    seedBackfillRows(fake, { accepted: 10, permanent_failed: 1 });
    for (let index = 0; index < 1000; index++) fake.seedOutbox({ id: `pub-${index}`, url: `https://x.example/p/${index}`, revision: 1n, source: "publish", status: "accepted" });
    const summary = await collectBackfillGlobalSummary(fake.asPrismaClient());
    expect(summary.backfillUrls.total).toBe(11);
    expect(() => assertBackfillStopConditions(summary)).toThrow(/ratio/);
  });

  it("(d) a failed delivery task that carried backfill rows stops the run; a failed task of someone else's rows does not", async () => {
    const fake = newFake();
    fake.genericTasks.set("t-failed", { id: "t-failed", taskType: "indexnow_delivery", status: "failed", operationScopeHash: "h" });
    fake.genericTasks.set("t-other", { id: "t-other", taskType: "indexnow_delivery", status: "failed", operationScopeHash: "h2" });
    fake.seedOutbox({ id: "bf-1", url: "https://x.example/1", revision: 1n, source: "backfill", status: "accepted", deliveryTaskId: "t-failed" });
    fake.seedOutbox({ id: "pub-1", url: "https://x.example/2", revision: 1n, source: "publish", status: "accepted", deliveryTaskId: "t-other" });
    const summary = await collectBackfillGlobalSummary(fake.asPrismaClient());
    expect(summary.failedDeliveryTasks).toBe(1);
    expect(() => assertBackfillStopConditions(summary)).toThrow(/worker task failed/);

    fake.genericTasks.get("t-failed")!.status = "completed";
    expect((await collectBackfillGlobalSummary(fake.asPrismaClient())).failedDeliveryTasks).toBe(0);
  });

  it("(e) a previous chunk with an unaccepted row stops the next chunk — and the message says 200 或 202", async () => {
    const fake = newFake();
    seedArticles(fake, 6);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 500 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options(), deps)).rejects.toThrow(/200 或 202/);
    expect(fake.outbox.size).toBe(3);
  });

  it("(e) is checked after the LAST chunk too, so a failing last chunk fails the run", async () => {
    const fake = newFake();
    seedArticles(fake, 3);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 503 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 10 }), deps)).rejects.toThrow(/200 或 202/);
  });

  it("(e) is not checked in a dry run", async () => {
    const fake = newFake();
    seedArticles(fake, 3);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options({ write: false }), deps)).resolves.toBeDefined();
  });
});

describe("[23][22] stop conditions (f) dead letters and (g) invalid-URL cancellations", () => {
  it("(f) ANY dead_letter row site-wide stops the run before it enqueues anything", async () => {
    const fake = newFake();
    seedArticles(fake, 4);
    const manifest = await manifestOf(fake);
    fake.seedOutbox({ id: "dead", url: "https://x.example/dead", revision: 1n, source: "publish", status: "dead_letter" });
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options(), deps)).rejects.toThrow(
      "死信必须交 Owner；原样重跑回填会跳过已有记录，不能代替重排",
    );
    expect(fake.outbox.size).toBe(1);
  });

  it("(g) a row cancelled for url_invalid / url_host_mismatch stops the run — and so does the real delivery path producing one", async () => {
    const fake = newFake();
    seedArticles(fake, 4);
    const manifest = await manifestOf(fake);
    fake.seedOutbox({ id: "bad", url: "https://x.example/bad", revision: 1n, source: "publish", status: "cancelled", lastErrorKind: "url_host_mismatch" });
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options(), deps)).rejects.toThrow(/url_invalid \/ url_host_mismatch/);
    expect(fake.outbox.size).toBe(1);

    // ordinary cancellations (eligibility drift) do NOT count
    const other = newFake();
    seedArticles(other, 2);
    const otherManifest = await manifestOf(other);
    other.seedOutbox({ id: "drift", url: "https://x.example/drift", revision: 1n, source: "publish", status: "cancelled", lastErrorKind: "eligibility_failed" });
    const run = harness(other, fetchStub(() => ({ status: 200 })));
    await expect(applyBackfill(other.asPrismaClient(), otherManifest, run.options({ chunkSize: 10 }), run.deps)).resolves.toBeDefined();
  });
});

describe("[24] new publications are not starved by a running backfill", () => {
  it("a record published between chunk k and chunk k+1 goes out in the NEXT batch (FIFO), not after the whole backfill", async () => {
    const fake = newFake();
    seedArticles(fake, 6);
    const manifest = await manifestOf(fake);
    seedArticles(fake, 1, ["en"], 900); // the article that will be published mid-run
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    let chunk = 0;
    let freshUrl = "";
    const drive = system(fake, fetchImpl);
    const { deps, options } = harness(fake, fetchImpl, {
      waitForChunk: async () => {
        await drive();
        if (chunk === 0) {
          fake.advance(1_000);
          const published = await enqueueIndexNowFirstPublish(fake.asPrismaClient(), { articleId: uuid(900), source: "publish" }, ENABLED_ALL_ENV, LOCALE_OK);
          freshUrl = fake.outbox.get(published.outboxId!)!.url;
          fake.advance(1_000);
        }
        chunk++;
      },
    });

    await applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 2 }), deps);
    // chunk 0 → request #1; chunk 1 → request #2 which carries the fresh publication FIRST; chunk 2 → request #3
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const second = urlListOf(fetchImpl, 1);
    expect(second[0]).toBe(freshUrl);
    expect(second).toHaveLength(3);
    expect(urlListOf(fetchImpl, 2)).not.toContain(freshUrl);
    expect([...fake.outbox.values()].find((row) => row.url === freshUrl)!.status).toBe("accepted");
  });
});

describe("[25] canary trial, then the main run skips what the trial pushed", () => {
  it("--canary-locales picks a deterministic multi-locale sample; the following full run skips exactly those entries", async () => {
    const fake = newFake();
    seedArticles(fake, 12, ["en", "es", "ru"]);
    const manifest = await manifestOf(fake);
    const fetchImpl = fetchStub(() => ({ status: 200 }));
    const { deps, options, lines } = harness(fake, fetchImpl);

    const trial = await applyBackfill(fake.asPrismaClient(), manifest, options({ canaryLocales: ["en", "es", "ru"], limit: 6, chunkSize: 100 }), deps);
    expect(trial).toMatchObject({ enqueuedUrls: 6, acceptedUrls: 6, canary: { en: 2, es: 2, ru: 2 } });
    expect(lines.find((line) => "canary" in line && "selectedUrls" in line)).toMatchObject({ canary: { en: 2, es: 2, ru: 2 } });
    const trialArticles = new Set([...fake.outbox.values()].map((row) => row.articleId));
    expect(trialArticles.size).toBe(6);

    const main = await applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 100 }), deps);
    expect(main).toMatchObject({ alreadyHasDeliveryUrls: 6, enqueuedUrls: 6 });
    expect(fake.outbox.size).toBe(12);
    expect(new Set([...fake.outbox.values()].map((row) => row.articleId)).size).toBe(12);
  });

  it("a canary locale that is not in the manifest is an error before anything is written", async () => {
    const fake = newFake();
    seedArticles(fake, 4, ["en", "es"]);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    await expect(applyBackfill(fake.asPrismaClient(), manifest, options({ canaryLocales: ["en", "fr"], limit: 2 }), deps)).rejects.toThrow("not present in the manifest: [fr]");
    expect(fake.outbox.size).toBe(0);
  });
});

describe("--offset / --limit select a slice of the manifest", () => {
  it("offset 2, limit 3 touches exactly entries 2..4", async () => {
    const fake = newFake();
    seedArticles(fake, 8);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    const report = await applyBackfill(fake.asPrismaClient(), manifest, options({ offset: 2, limit: 3, chunkSize: 10 }), deps);
    expect(report.selectedUrls).toBe(3);
    expect([...fake.outbox.values()].map((row) => row.articleId).sort()).toEqual(manifest.entries.slice(2, 5).map((entry) => entry.article_id).sort());
  });

  it("without --limit the run goes from the offset to the end — there is no 500 cap", async () => {
    const fake = newFake();
    seedArticles(fake, 620);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })), { waitForChunk: async () => {} });
    const report = await applyBackfill(fake.asPrismaClient(), manifest, options({ write: false, offset: 10, chunkSize: 500 }), deps);
    expect(report.selectedUrls).toBe(610);
    expect(report.chunks).toBe(2);
  });
});

describe("status output carries units", () => {
  it("no unit-less counter names anywhere in the status document", async () => {
    const fake = newFake();
    seedArticles(fake, 3);
    const manifest = await manifestOf(fake);
    const { deps, options } = harness(fake, fetchStub(() => ({ status: 200 })));
    await applyBackfill(fake.asPrismaClient(), manifest, options({ chunkSize: 10 }), deps);
    const status = await collectIndexNowStatus(fake.asPrismaClient());
    const keys: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.push(key);
          walk(child);
        }
      }
    };
    walk(status);
    for (const forbidden of ["count", "completed", "total", "accepted", "enqueued", "drifted"]) {
      // `accepted` appears only as the object holding status200/status202 sub-objects, whose leaves carry units
      if (forbidden === "accepted") continue;
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toEqual(expect.arrayContaining(["urls", "httpRequests", "urlsByStatusAndSource", "dueUrls", "deliveryTaskItemsByStatus", "scanTaskItemsByStatus"]));
    const outbox = (status as any).outbox.urlsByStatusAndSource as Array<{ status: string; source: string; urls: number }>;
    expect(outbox).toEqual([{ status: "accepted", source: "backfill", urls: 3 }]);
  });
});
