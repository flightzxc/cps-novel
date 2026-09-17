/**
 * Behavioural coverage for the preview backfill recovery path
 * (`src/server/preview-recovery/backfill.ts` + `scripts/preview-backfill-recovery.ts`).
 *
 * The lowest-level task factory (`enqueueMoboreaderPreviewRefreshTask`) is the
 * only thing stubbed — exactly where
 * `tests/backend/content-creation/preview-enqueue.test.ts` already draws that
 * line — so the real `enqueueContentCreationPreview` (account resolution,
 * chunked source lookup, single-channel-app assertion) stays inside the tested
 * surface rather than being mocked away.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const taskFactory = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tasks/moboreader", () => ({
  enqueueMoboreaderPreviewRefreshTask: taskFactory,
  MOBOREADER_TASK_TYPES: Object.freeze({
    catalogScan: "catalog_scan",
    previewRefresh: "moboreader.preview_refresh.v1",
  }),
}));

const {
  NEVER_ATTEMPTED_KEY,
  PREVIEW_BACKFILL_MAX_BATCH_SIZE,
  PREVIEW_BACKFILL_MAX_LIMIT,
  chunkCandidates,
  previewBackfillRequestToken,
  runPreviewBackfill,
  surveyPreviewBackfillCandidates,
} = await import("@/server/preview-recovery/backfill");

const {
  PREVIEW_BACKFILL_ACTOR_ID,
  parsePreviewBackfillArgs,
  preflightPreviewCredential,
  runPreviewBackfillCli,
} = await import("../../../scripts/preview-backfill-recovery");

const { encryptCredentialSecretForWorker } = await import("../../../worker/credentials/crypto");

const APP_ID = "20000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "30000000-0000-4000-8000-000000000001";

function sourceId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

type Row = {
  novelSourceItemId: string;
  novelId: string;
  novelTitle: string;
  lastPreviewItemStatus: string | null;
  lastPreviewFailureMessage: string | null;
};

function burnedRow(index: number, overrides: Partial<Row> = {}): Row {
  return {
    novelSourceItemId: sourceId(index),
    novelId: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    novelTitle: `Novel ${index}`,
    lastPreviewItemStatus: "failed",
    lastPreviewFailureMessage: "credential_validation_failed",
    ...overrides,
  };
}

type FakeOptions = {
  rows?: Row[];
  credentials?: Array<{ id: string; encryptedSecret: Uint8Array; keyVersion: number }>;
  accountFound?: boolean;
};

function fakeDb(options: FakeOptions = {}) {
  const rows = options.rows ?? [];
  // Honours the bound LIMIT (always the last `Prisma.sql` parameter) instead of
  // returning the whole fixture: without that, a survey that forgot to fetch
  // one row past `limit` would still look correct here and the truncation
  // assertion below would be vacuous.
  const queryRaw = vi.fn(async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
    const bound = query.values[query.values.length - 1];
    return typeof bound === "number" ? rows.slice(0, bound) : rows;
  });
  return {
    $queryRaw: queryRaw,
    $transaction: vi.fn(async (callback: (tx: object) => unknown) => callback({ tx: true })),
    novelSourceItem: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id, channelAppId: APP_ID }))),
    },
    genericTask: { findFirst: vi.fn(async () => ({ channelAccountId: ACCOUNT_ID })) },
    channelAccount: {
      findFirst: vi.fn(async (args: { select?: { credentials?: unknown } }) => {
        if (options.accountFound === false) return null;
        return args.select && "credentials" in args.select
          ? { id: ACCOUNT_ID, credentials: options.credentials ?? [] }
          : { id: ACCOUNT_ID };
      }),
      findMany: vi.fn(async () => []),
    },
    __queryRaw: queryRaw,
  };
}

function keyring(): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-preview-backfill-keys-"));
  const v1 = path.join(directory, "v1");
  const fingerprint = path.join(directory, "fingerprint");
  writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
  return {
    env: {
      NODE_ENV: "test",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  taskFactory.mockReset();
  taskFactory.mockImplementation(async (_tx: unknown, input: { novelSourceItemIds: readonly string[] }) => ({
    status: "enqueued",
    taskId: randomUUID(),
    taskStatus: "pending",
    eligibleCount: input.novelSourceItemIds.length,
    skipReasonCounts: {},
  }));
});

describe("preview backfill candidate survey", () => {
  it("reports the failure taxonomy that stranded each candidate", async () => {
    const db = fakeDb({
      rows: [
        burnedRow(1),
        burnedRow(2),
        burnedRow(3, { lastPreviewItemStatus: null, lastPreviewFailureMessage: null }),
        burnedRow(4, { lastPreviewFailureMessage: "preview_read_capability_unavailable" }),
      ],
    });

    const survey = await surveyPreviewBackfillCandidates(db as never, { channelAppId: APP_ID, limit: 10 });

    expect(survey.candidates).toHaveLength(4);
    expect(survey.truncated).toBe(false);
    expect(survey.failureBreakdown).toEqual({
      credential_validation_failed: 2,
      [NEVER_ATTEMPTED_KEY]: 1,
      preview_read_capability_unavailable: 1,
    });
  });

  it("asks for one row past the limit and reports truncation without leaking it into the batch", async () => {
    const db = fakeDb({ rows: [burnedRow(1), burnedRow(2), burnedRow(3)] });

    const survey = await surveyPreviewBackfillCandidates(db as never, { channelAppId: APP_ID, limit: 2 });

    expect(survey.candidates.map((candidate) => candidate.novelSourceItemId)).toEqual([sourceId(1), sourceId(2)]);
    expect(survey.truncated).toBe(true);
  });

  it("binds an explicit source-item narrowing without loosening the candidate predicate", async () => {
    const db = fakeDb({ rows: [burnedRow(1)] });
    await surveyPreviewBackfillCandidates(db as never, {
      channelAppId: APP_ID,
      limit: 5,
      onlySourceItemIds: [sourceId(1)],
    });

    const query = db.__queryRaw.mock.calls[0]![0] as { strings: readonly string[]; values: readonly unknown[] };
    expect(query.strings.join("?")).toContain("s.id = ANY(");
    expect(query.values).toContainEqual([sourceId(1)]);

    // An empty narrowing must stay a no-op rather than an empty IN-list, which
    // would silently return zero candidates for every unnarrowed run — the
    // fake cannot execute SQL, so the `cardinality(...) = 0 OR` escape hatch is
    // asserted on the statement itself.
    expect(query.strings.join("?")).toContain("cardinality(");
    const unfiltered = fakeDb({ rows: [burnedRow(1)] });
    const survey = await surveyPreviewBackfillCandidates(unfiltered as never, { channelAppId: APP_ID, limit: 5 });
    expect(survey.candidates).toHaveLength(1);
    expect((unfiltered.__queryRaw.mock.calls[0]![0] as { values: readonly unknown[] }).values).toContainEqual([]);
  });

  it("rejects a non-positive limit instead of silently surveying everything", async () => {
    const db = fakeDb();
    await expect(surveyPreviewBackfillCandidates(db as never, { channelAppId: APP_ID, limit: 0 }))
      .rejects.toThrow("preview_backfill_limit_invalid");
  });

  it("keeps the query aligned with the publish gate's own preview predicate", async () => {
    const db = fakeDb({ rows: [burnedRow(1)] });
    await surveyPreviewBackfillCandidates(db as never, { channelAppId: APP_ID, limit: 5 });

    // Prisma.sql keeps the literal fragments in `strings`; the parameters are
    // bound separately. Assert on the predicates that make a candidate
    // *exactly* a row the gate rejects — a future edit that drops one of them
    // would start backfilling Novels that are already publishable, or skip
    // Novels stuck on a blank body.
    const sql = (db.__queryRaw.mock.calls[0]![0] as { strings: readonly string[] }).strings.join("?");
    expect(sql).toContain("c.status = 'preview'");
    expect(sql).toContain("btrim(cc.body) <> ''");
    expect(sql).toContain("c.status = 'withdrawn'");
    expect(sql).toContain("s.deleted_at IS NULL");
    expect(sql).toContain("n.deleted_at IS NULL");
  });
});

describe("preview backfill batching", () => {
  it("splits candidates into fixed-size batches with deterministic tokens", () => {
    const candidates = [1, 2, 3, 4, 5].map((index) => ({
      novelSourceItemId: sourceId(index),
      novelId: `novel-${index}`,
      novelTitle: `Novel ${index}`,
      lastPreviewItemStatus: "failed",
      lastPreviewFailureMessage: "credential_validation_failed",
    }));

    const batches = chunkCandidates(candidates, 2);

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(previewBackfillRequestToken("run-7", 0)).toBe("preview_backfill:run-7:0");
    expect(previewBackfillRequestToken("run-7", 2)).toBe("preview_backfill:run-7:2");
  });

  it("refuses a batch size above the per-task cap", () => {
    expect(() => chunkCandidates([], PREVIEW_BACKFILL_MAX_BATCH_SIZE + 1))
      .toThrow("preview_backfill_batch_size_invalid");
  });
});

describe("preview backfill run", () => {
  it("survey mode enqueues nothing", async () => {
    const db = fakeDb({ rows: [burnedRow(1), burnedRow(2)] });

    const result = await runPreviewBackfill(db as never, {
      channelAppId: APP_ID,
      requestId: "run-1",
      actorId: PREVIEW_BACKFILL_ACTOR_ID,
      limit: 10,
      batchSize: 1,
      apply: false,
    });

    expect(result.applied).toBe(false);
    expect(result.batches).toEqual([]);
    expect(taskFactory).not.toHaveBeenCalled();
  });

  it("apply mode drives the production enqueue path once per batch", async () => {
    const db = fakeDb({ rows: [burnedRow(1), burnedRow(2), burnedRow(3)] });

    const result = await runPreviewBackfill(db as never, {
      channelAppId: APP_ID,
      requestId: "run-2",
      actorId: PREVIEW_BACKFILL_ACTOR_ID,
      limit: 10,
      batchSize: 2,
      apply: true,
    });

    expect(taskFactory).toHaveBeenCalledTimes(2);
    expect(result.batches.map((batch) => batch.requestToken)).toEqual([
      "preview_backfill:run-2:0",
      "preview_backfill:run-2:1",
    ]);
    expect(taskFactory.mock.calls[0]![1]).toMatchObject({
      trigger: "auto",
      mode: "apply",
      channelAccountId: ACCOUNT_ID,
      channelAppId: APP_ID,
      requestToken: "preview_backfill:run-2:0",
      novelSourceItemIds: [sourceId(1), sourceId(2)],
    });
    expect(taskFactory.mock.calls[1]![1]).toMatchObject({
      requestToken: "preview_backfill:run-2:1",
      novelSourceItemIds: [sourceId(3)],
    });
    expect(result.batches.every((batch) => batch.enqueue.queued)).toBe(true);
  });
});

describe("preview backfill CLI contract", () => {
  it("requires an explicit limit and an explicit confirmation before applying", () => {
    const base = ["--channel-app-id", APP_ID, "--request-id", "run-3"];
    expect(() => parsePreviewBackfillArgs(base)).toThrow("limit_invalid");
    expect(() => parsePreviewBackfillArgs([...base, "--limit", "10", "--apply"]))
      .toThrow("apply_confirmation_invalid");
    expect(() => parsePreviewBackfillArgs([...base, "--limit", "10", "--apply", "--confirm", "yes"]))
      .toThrow("apply_confirmation_invalid");
    expect(() => parsePreviewBackfillArgs([...base, "--limit", String(PREVIEW_BACKFILL_MAX_LIMIT + 1)]))
      .toThrow("limit_invalid");
    expect(() => parsePreviewBackfillArgs(["--channel-app-id", "not-a-uuid", "--request-id", "x", "--limit", "1"]))
      .toThrow("channel_app_id_invalid");
    expect(() => parsePreviewBackfillArgs([...base, "--limit", "10", "--source-item-ids", "nope"]))
      .toThrow("source_item_ids_invalid");
    expect(parsePreviewBackfillArgs([...base, "--limit", "10", "--source-item-ids", `${sourceId(1)},${sourceId(2)}`]))
      .toMatchObject({ onlySourceItemIds: [sourceId(1), sourceId(2)] });

    expect(parsePreviewBackfillArgs([...base, "--limit", "10"]))
      .toMatchObject({ channelAppId: APP_ID, requestId: "run-3", limit: 10, apply: false, onlySourceItemIds: [] });
    expect(parsePreviewBackfillArgs([...base, "--limit", "10", "--apply", "--confirm", "APPLY_PREVIEW_BACKFILL"]))
      .toMatchObject({ apply: true });
  });

  it("passes the credential pre-flight when the active credential decrypts", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      const db = fakeDb({
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt-secret", ACCOUNT_ID, credentialId, 1, keys.env),
          keyVersion: 1,
        }],
      });

      await expect(preflightPreviewCredential(db as never, APP_ID, new Date(), keys.env))
        .resolves.toEqual({ status: "usable", channelAccountId: ACCOUNT_ID, credentialId });
    } finally {
      keys.cleanup();
    }
  });

  it("classifies an undecryptable credential as the 2026-09-14 failure and refuses to apply", async () => {
    const keys = keyring();
    const otherKeys = keyring();
    try {
      const credentialId = randomUUID();
      // Encrypted under a different keyring — the exact shape that turned
      // 79,183 preview tasks terminal on 2026-09-14.
      const db = fakeDb({
        rows: [burnedRow(1), burnedRow(2)],
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt-secret", ACCOUNT_ID, credentialId, 1, otherKeys.env),
          keyVersion: 1,
        }],
      });

      const preflight = await preflightPreviewCredential(db as never, APP_ID, new Date(), keys.env);
      expect(preflight).toEqual({
        status: "unusable",
        code: "credential_validation_failed",
        channelAccountId: ACCOUNT_ID,
      });

      const cli = await runPreviewBackfillCli(
        db as never,
        { channelAppId: APP_ID, requestId: "run-4", limit: 10, batchSize: 2, onlySourceItemIds: [], apply: true },
        new Date(),
        keys.env,
      );
      expect(cli.exitCode).toBe(65);
      expect(cli.report).toMatchObject({ refused: "credential_preflight_failed" });
      expect(taskFactory).not.toHaveBeenCalled();
    } finally {
      keys.cleanup();
      otherKeys.cleanup();
    }
  });

  it("carries --source-item-ids all the way into the candidate query", async () => {
    const keys = keyring();
    try {
      const credentialId = randomUUID();
      const db = fakeDb({
        rows: [burnedRow(2)],
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_ID, credentialId, 1, keys.env),
          keyVersion: 1,
        }],
      });

      await runPreviewBackfillCli(
        db as never,
        {
          channelAppId: APP_ID,
          requestId: "run-6",
          limit: 10,
          batchSize: 2,
          onlySourceItemIds: [sourceId(2)],
          apply: true,
        },
        new Date(),
        keys.env,
      );

      const values = (db.__queryRaw.mock.calls[0]![0] as { values: readonly unknown[] }).values;
      expect(values).toContainEqual([sourceId(2)]);
      expect(taskFactory).toHaveBeenCalledTimes(1);
      expect(taskFactory.mock.calls[0]![1]).toMatchObject({ novelSourceItemIds: [sourceId(2)] });
    } finally {
      keys.cleanup();
    }
  });

  it("still surveys (read-only) when the credential is unusable", async () => {
    const keys = keyring();
    const otherKeys = keyring();
    try {
      const credentialId = randomUUID();
      const db = fakeDb({
        rows: [burnedRow(1)],
        credentials: [{
          id: credentialId,
          encryptedSecret: encryptCredentialSecretForWorker("jwt", ACCOUNT_ID, credentialId, 1, otherKeys.env),
          keyVersion: 1,
        }],
      });

      const cli = await runPreviewBackfillCli(
        db as never,
        { channelAppId: APP_ID, requestId: "run-5", limit: 10, batchSize: 2, onlySourceItemIds: [], apply: false },
        new Date(),
        keys.env,
      );

      expect(cli.exitCode).toBe(0);
      expect(cli.report).toMatchObject({ mode: "survey", candidateCount: 1 });
      expect(taskFactory).not.toHaveBeenCalled();
    } finally {
      keys.cleanup();
      otherKeys.cleanup();
    }
  });

  it("reports credential_ambiguous rather than picking one of two active credentials", async () => {
    const keys = keyring();
    try {
      const db = fakeDb({
        credentials: [
          { id: randomUUID(), encryptedSecret: Buffer.from("x"), keyVersion: 1 },
          { id: randomUUID(), encryptedSecret: Buffer.from("y"), keyVersion: 1 },
        ],
      });
      await expect(preflightPreviewCredential(db as never, APP_ID, new Date(), keys.env))
        .resolves.toMatchObject({ status: "unusable", code: "credential_ambiguous" });
    } finally {
      keys.cleanup();
    }
  });
});
