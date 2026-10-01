import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TAGGING_AUTO_CLASSIFY_TASK_TYPE } from "@/lib/tagging/task-contract";
import { createTaggingAutoClassifyTask, TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE } from "@/server/tagging/tasks";
import {
  compareImplementations,
  createInput,
  seedLocale,
} from "../../../scripts/measure-tagging-task-creation-memory";

// B-21 on a real PostgreSQL 16.14 (run by scripts/run-tagging-public-auto-postgres-verification.sh):
// bounded chunked task creation must leave exactly the task row, item set and
// audit row the pre-fix implementation left, stay idempotent and atomic, work
// with the web_app role's real grants, and the measurement script must run.

const enabled = process.env.P2_06_5_DATABASE_TEST === "1";
const url = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};
const owner = new PrismaClient({ datasourceUrl: url("P2_06_5_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: url("P2_06_5_WEB_DATABASE_URL") });

const LOCALE_A = "b21t-a";
const LOCALE_B = "b21t-b";
// 3.35 insert chunks and 4 read pages; initialize_missing still keeps more than two chunks.
const SEEDED = 3 * TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE + 350;
const REQUEST_PREFIX = "b21t-";
const env = { ...process.env, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };

async function removeMyRows() {
  // Item rows go with their task. operation_audit is append-only (trigger), so
  // its rows stay; every assertion on it uses a request id unique to the test.
  await owner.$executeRawUnsafe(`DELETE FROM generic_task WHERE task_type = '${TAGGING_AUTO_CLASSIFY_TASK_TYPE}' AND request_token LIKE 'tagging:auto_classify:b21%'`);
}

async function removeMyData() {
  await removeMyRows();
  const locales = `'${LOCALE_A}', '${LOCALE_B}'`;
  await owner.$executeRawUnsafe(`DELETE FROM novel_tag_state WHERE novel_id IN (SELECT id FROM novel WHERE locale IN (${locales}))`);
  await owner.$executeRawUnsafe(`DELETE FROM tag_classification_run WHERE novel_id IN (SELECT id FROM novel WHERE locale IN (${locales}))`);
  await owner.$executeRawUnsafe(`DELETE FROM novel_source_item WHERE channel_app_id IN (SELECT ca.id FROM channel_app ca JOIN channel c ON c.id = ca.channel_id WHERE c.code = 'b21-measure')`);
  await owner.$executeRawUnsafe(`DELETE FROM novel WHERE locale IN (${locales})`);
  await owner.$executeRawUnsafe(`DELETE FROM channel_app WHERE channel_id IN (SELECT id FROM channel WHERE code = 'b21-measure')`);
  await owner.$executeRawUnsafe(`DELETE FROM channel WHERE code = 'b21-measure'`);
  await owner.$executeRawUnsafe(`DELETE FROM source_app WHERE code = 'b21-measure'`);
}

describe.skipIf(!enabled).sequential("B-21 chunked task creation on PostgreSQL", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await owner.$queryRawUnsafe<Array<{ database_name: string; version: string }>>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS version",
    );
    if (!databaseName.includes("p2_06_5")) throw new Error(`Refusing B-21 tests against ${databaseName}`);
    if (!version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${version}`);
    await removeMyData();
    await seedLocale(owner, { locale: LOCALE_A, count: SEEDED, seed: 21, descMedianChars: 200, manualRatio: 0.05, taggedRatio: 0.3 });
    await seedLocale(owner, { locale: LOCALE_B, count: 40, seed: 22, descMedianChars: 200, manualRatio: 0, taggedRatio: 0 });
  }, 60_000);

  afterAll(async () => {
    await removeMyData();
    await owner.$disconnect();
    await web.$disconnect();
  }, 60_000);

  it.each(["initialize_missing", "reclassify_existing"] as const)(
    "leaves the same task row, item set and audit row as the pre-fix implementation (%s)",
    async (lifecycle) => {
      const { equal, legacy, current } = await compareImplementations(owner, LOCALE_A, lifecycle);
      expect(current.itemCount).toBeGreaterThan(2 * TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE);
      expect(current.itemCount).toBe(legacy.itemCount);
      expect(current.itemsFingerprint).toBe(legacy.itemsFingerprint);
      expect(current.task).toEqual(legacy.task);
      expect(current.audit).toEqual(legacy.audit);
      expect(current.derivationViolations).toBe(0);
      expect(legacy.derivationViolations).toBe(0);
      expect(equal).toBe(true);
      // The lifecycles differ in what they select: tagged novels only qualify for a reclassification.
      if (lifecycle === "initialize_missing") expect(current.itemCount).toBeLessThan(SEEDED);
    },
    60_000,
  );

  it("is idempotent per request id with web_app's real grants, including a concurrent replay", async () => {
    await removeMyRows();
    const requestId = `${REQUEST_PREFIX}idem-${randomUUID()}`;
    const input = () => createInput(web, LOCALE_A, "reclassify_existing", requestId);
    const first = await createTaggingAutoClassifyTask({ ...input(), env });
    expect(first.status).toBe("enqueued");
    if (first.status !== "enqueued") throw new Error("unreachable");
    const itemsAfterFirst = await owner.genericTaskItem.count({ where: { taskId: first.taskId } });
    expect(itemsAfterFirst).toBe(first.eligibleCount);

    expect(await createTaggingAutoClassifyTask({ ...input(), env })).toEqual({ status: "duplicate", taskId: first.taskId, eligibleCount: first.eligibleCount });
    await expect(createTaggingAutoClassifyTask({ ...createInput(web, LOCALE_A, "initialize_missing", requestId), env })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await owner.genericTaskItem.count({ where: { taskId: first.taskId } })).toBe(itemsAfterFirst);

    await removeMyRows();
    const racedRequest = `${REQUEST_PREFIX}race-${randomUUID()}`;
    const raced = await Promise.all([1, 2].map(() => createTaggingAutoClassifyTask({ ...createInput(web, LOCALE_A, "reclassify_existing", racedRequest), env })));
    expect(raced.map((result) => result.status).sort()).toEqual(["duplicate", "enqueued"]);
    const tasks = await owner.genericTask.findMany({ where: { requestToken: `tagging:auto_classify:${racedRequest}` } });
    expect(tasks).toHaveLength(1);
    expect(await owner.genericTaskItem.count({ where: { taskId: tasks[0]!.id } })).toBe(tasks[0]!.totalCount);
    expect(await owner.operationAudit.count({ where: { requestId: racedRequest } })).toBe(1);
  }, 60_000);

  it("rolls the task, every item chunk and the audit row back when a later chunk fails, and a retry succeeds", async () => {
    await removeMyRows();
    const requestId = `${REQUEST_PREFIX}atomic-${randomUUID()}`;
    let itemStatements = 0;
    const flaky = new Proxy(web, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, options: unknown) => (target.$transaction as (f: unknown, o: unknown) => Promise<unknown>)(
          (tx: Record<string, unknown>) => fn(new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== "genericTaskItem") return Reflect.get(txTarget, txProperty, txReceiver);
              const delegate = Reflect.get(txTarget, txProperty, txReceiver) as { createMany: (args: unknown) => unknown };
              return { createMany: (args: unknown) => {
                itemStatements += 1;
                if (itemStatements === 2) throw new Error("injected second-chunk failure");
                return delegate.createMany(args);
              } };
            },
          })),
          options,
        );
      },
    }) as PrismaClient;

    await expect(createTaggingAutoClassifyTask({ ...createInput(flaky, LOCALE_A, "reclassify_existing", requestId), env })).rejects.toThrow("injected second-chunk failure");
    expect(itemStatements).toBe(2);
    expect(await owner.genericTask.count({ where: { requestToken: `tagging:auto_classify:${requestId}` } })).toBe(0);
    expect(await owner.operationAudit.count({ where: { requestId } })).toBe(0);

    const retried = await createTaggingAutoClassifyTask({ ...createInput(web, LOCALE_A, "reclassify_existing", requestId), env });
    expect(retried.status).toBe("enqueued");
    if (retried.status !== "enqueued") throw new Error("unreachable");
    expect(await owner.genericTaskItem.count({ where: { taskId: retried.taskId } })).toBe(retried.eligibleCount);
  }, 60_000);

  it("the measurement script runs for both implementations and reports a peak RSS", async () => {
    const root = path.resolve(__dirname, "../../..");
    for (const impl of ["current", "legacy"] as const) {
      await removeMyRows();
      const run = spawnSync("npx", [
        "tsx", "scripts/measure-tagging-task-creation-memory.ts", "measure", "--impl", impl,
        "--locale", LOCALE_B, "--lifecycle", "reclassify_existing", "--request-id", `${REQUEST_PREFIX}measure-${impl}-${randomUUID()}`,
      ], { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: url("P2_06_5_WEB_DATABASE_URL") }, timeout: 90_000 });
      expect(run.status, run.stderr).toBe(0);
      const line = run.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1)!;
      const report = JSON.parse(line) as { impl: string; result: { status: string; eligibleCount: number }; peakRssMiB: number; startRssMiB: number; elapsedMs: number };
      expect(report).toMatchObject({ impl, result: { status: "enqueued", eligibleCount: 40 } });
      expect(report.peakRssMiB).toBeGreaterThan(0);
      expect(report.peakRssMiB).toBeGreaterThanOrEqual(report.startRssMiB);
      expect(Number.isFinite(report.elapsedMs)).toBe(true);
    }
  }, 180_000);
});
