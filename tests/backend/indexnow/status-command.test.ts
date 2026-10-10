import { beforeEach, describe, expect, it } from "vitest";

import { resumeIndexNowDelivery } from "@/lib/indexnow/delivery-control";
import { invalidateSiteSettingCache } from "@/server/site-settings/service";

import { collectIndexNowStatus, describeControl, jsonSafe } from "../../../scripts/indexnow-status";
import { FakeIndexNowDb, TEST_SITE_URL, installTestSiteUrl } from "./fake-db";
import { RESUME_ACTOR, T0, fetchStub, runDelivery, seedDueRows } from "./helpers";

installTestSiteUrl();
beforeEach(() => invalidateSiteSettingCache());

function newFake(): FakeIndexNowDb {
  return new FakeIndexNowDb().setNow(T0);
}

describe("[21] 202 is recorded and surfaces as keyValidation", () => {
  it("a 202 attempt carries errorKind key_validation_pending (the row stays clean); status goes pending → verified after a 200", async () => {
    const fake = newFake();
    seedDueRows(fake, 1, { prefix: "a" });
    await runDelivery(fake, fetchStub(() => ({ status: 202 })));
    const attempt = [...fake.attempts.values()][0]!;
    expect(attempt.errorKind).toBe("key_validation_pending");
    expect(attempt.outcome).toBe("accepted");
    const [accepted] = [...fake.outbox.values()];
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.lastErrorKind).toBeNull();

    const pending = (await collectIndexNowStatus(fake.asPrismaClient())) as any;
    expect(pending.keyValidation.state).toBe("pending");
    expect(pending.keyValidation.lastAccepted.httpStatus).toBe(202);
    expect(pending.keyValidation.accepted.all.status202.urls).toBe(1);
    expect(pending.keyValidation.accepted.all.status200.urls).toBe(0);

    fake.advance(60_000);
    seedDueRows(fake, 1, { prefix: "b", baseMs: fake.clock().getTime() - 1000 });
    await runDelivery(fake, fetchStub(() => ({ status: 200 })));
    const verified = (await collectIndexNowStatus(fake.asPrismaClient())) as any;
    expect(verified.keyValidation.state).toBe("verified");
    expect(verified.keyValidation.lastAccepted.httpStatus).toBe(200);
    expect(verified.keyValidation.accepted.all.status200.urls).toBe(1);
    expect(verified.keyValidation.accepted.all.status202.urls).toBe(1);
    expect(verified.keyValidation.accepted.last24h.status200.httpRequests).toBe(1);
  });

  it("with nothing accepted yet the state is none", async () => {
    const status = (await collectIndexNowStatus(newFake().asPrismaClient())) as any;
    expect(status.keyValidation).toMatchObject({ state: "none", lastAccepted: null });
  });
});

describe("[8] status after a repeated failure lists the tripping batch and flags the repeat", () => {
  it("the held batch fails again after a resume: breaker open, repeatAfterResume true, the batch's URLs listed, lastBisect reported with units", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 4);
    const bad = rows[2]!;
    const fetchImpl = fetchStub((body) => ({ status: body.urlList.includes(bad.url) ? 422 : 200 }));
    await runDelivery(fake, fetchImpl);
    await resumeIndexNowDelivery(fake.asPrismaClient(), { actorId: RESUME_ACTOR, reason: "operator checked, retry" });
    await runDelivery(fake, fetchImpl);

    const status = (await collectIndexNowStatus(fake.asPrismaClient())) as any;
    expect(status.control.breaker.open).toBe(true);
    expect(status.control.breaker.repeatAfterResume).toBe(true);
    expect(status.breaker.repeatAfterResume).toBe(true);
    expect(status.breaker.urls).toBe(4);
    expect(status.breaker.batch.map((row: any) => row.url).sort()).toEqual(rows.map((row) => row.url).sort());
    expect(status.control.lastBisect).toMatchObject({ conclusion: "local", httpRequests: 4, acceptedUrls: 3, raisedMaxAttemptsBy: 9, urls: 4 });
    expect(status.control.lastBisect.culprits).toEqual([{ outboxId: bad.outboxId, url: bad.url }]);
    expect(status.control.lastResume).toMatchObject({ actorId: RESUME_ACTOR, reason: "operator checked, retry" });
  });

  it("a first failure (not yet resumed) is a trip with repeatAfterResume false", async () => {
    const fake = newFake();
    seedDueRows(fake, 2);
    await runDelivery(fake, fetchStub(() => ({ status: 403 })));
    const status = (await collectIndexNowStatus(fake.asPrismaClient())) as any;
    expect(status.control.breaker).toMatchObject({ open: true, repeatAfterResume: false });
    expect(status.control.breaker.trippedBy).toMatchObject({ httpStatus: 403, urls: 2, heldRetry: false });
    expect(status.breaker.urls).toBe(2);
  });
});

describe("[22] status lists cancelled rows by kind and the URLs of invalid ones", () => {
  it("url_invalid and url_host_mismatch rows are counted by lastErrorKind and listed with their URLs (redacted diagnosis)", async () => {
    const fake = newFake();
    const rows = seedDueRows(fake, 3);
    fake.outbox.get(rows[0]!.outboxId)!.url = `${TEST_SITE_URL}/novel/book-r-00000-pr00000?key=SECRETKEY123&x=1`;
    fake.outbox.get(rows[1]!.outboxId)!.url = "https://other-site.example/novel/book-r-00001-pr00001";
    await runDelivery(fake, fetchStub(() => ({ status: 200 })));

    const status = (await collectIndexNowStatus(fake.asPrismaClient())) as any;
    const byKind = Object.fromEntries(status.outbox.cancelledUrlsByErrorKind.map((entry: any) => [entry.lastErrorKind, entry.urls]));
    expect(byKind).toEqual({ url_invalid: 1, url_host_mismatch: 1 });
    expect(status.outbox.invalidUrls.map((entry: any) => entry.lastErrorKind).sort()).toEqual(["url_host_mismatch", "url_invalid"]);
    expect(JSON.stringify(status)).not.toContain("SECRETKEY123");
  });
});

describe("dead letters are listed on their own", () => {
  it("status lists dead_letter rows with url, attempts and last error", async () => {
    const fake = newFake();
    fake.seedOutbox({ id: "dead-1", url: "https://x.example/dead", revision: 1n, status: "dead_letter", attemptCount: 5, maxAttempts: 5, lastHttpStatus: 500, lastErrorKind: "http_5xx", lastErrorSummary: "boom" });
    const status = (await collectIndexNowStatus(fake.asPrismaClient())) as any;
    expect(status.outbox.deadLetters).toEqual([
      expect.objectContaining({ id: "dead-1", url: "https://x.example/dead", attemptCount: 5, lastHttpStatus: 500, lastErrorKind: "http_5xx" }),
    ]);
  });
});

describe("describeControl / jsonSafe", () => {
  it("jsonSafe turns bigint into strings so the JSON document can be printed", () => {
    expect(jsonSafe({ id: 12n, nested: [{ n: 1n }] })).toEqual({ id: "12", nested: [{ n: "1" }] });
    expect(typeof describeControl).toBe("function");
  });
});
