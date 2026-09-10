import { describe, expect, it } from "vitest";

import {
  BackfillSourceItemLocaleError,
  LEGACY_UNKNOWN_LOCALE_LITERAL,
  backfillSourceItemLocale,
  type AdminIdentityLookupRow,
  type BackfillSourceItemLocaleDb,
  type BackfillSourceItemLocaleRow,
  type OperationAuditLookupRow,
} from "../../../scripts/l10n/backfill-source-item-locale";
import { MAPPING_VERSION } from "@/lib/locale/channel-language";

/**
 * `施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.H:
 * "backfill fake-db：dry-run 零写入、approver 不存在拒绝、apply 幂等" —
 * fast, DB-free regression net for
 * `scripts/l10n/backfill-source-item-locale.ts`'s own batching/approval/
 * idempotency contract, same precedent as
 * `tests/backend/article-rebind/backfill-novel-title-normalized.test.ts`
 * and `scripts/p2-06-5-production/tagging-bootstrap.ts`'s approver gate.
 */

class FakeBackfillDb implements BackfillSourceItemLocaleDb {
  readonly rows: BackfillSourceItemLocaleRow[] = [];
  readonly admins: AdminIdentityLookupRow[] = [];
  readonly audits: Array<OperationAuditLookupRow & { requestId?: string; action: string; actorType: string }> = [];
  private nextAuditId = 1n;

  readonly novelSourceItem = {
    findMany: async (args: {
      where: Record<string, unknown>;
      orderBy: { id: "asc" };
      take: number;
    }): Promise<BackfillSourceItemLocaleRow[]> => {
      // Mirrors the real `where` shape: no `OR` clause = full scan
      // (`--re-resolve`); an `OR` clause = default target set (`sourceLocale
      // IS NULL OR = 'unknown'`), any one of whose branches must match.
      const where = args.where as { id?: { gt: string }; OR?: Array<{ sourceLocale: string | null }> };
      return this.rows
        .filter((row) => (where.id ? row.id > where.id.gt : true))
        .filter((row) => (where.OR ? where.OR.some((clause) => row.sourceLocale === clause.sourceLocale) : true))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, args.take)
        .map((row) => ({ ...row }));
    },
    updateMany: async (args: {
      where: { id: string; sourceLocale: string | null };
      data: { sourceLocale: string | null };
    }): Promise<{ count: number }> => {
      const row = this.rows.find(
        (candidate) => candidate.id === args.where.id && candidate.sourceLocale === args.where.sourceLocale,
      );
      if (!row) return { count: 0 };
      row.sourceLocale = args.data.sourceLocale;
      return { count: 1 };
    },
  };

  readonly adminIdentity = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<AdminIdentityLookupRow | null> => {
      const where = args.where as { id?: string; username?: string };
      return (
        this.admins.find((admin) => (where.id ? admin.id === where.id : admin.username === where.username)) ?? null
      );
    },
  };

  readonly operationAudit = {
    findFirst: async (args: { where: Record<string, unknown> }): Promise<OperationAuditLookupRow | null> => {
      const where = args.where as { requestId?: string; action: string };
      const found = this.audits.find(
        (audit) => audit.action === where.action && audit.requestId === where.requestId,
      );
      return found ? { id: found.id, actorId: found.actorId } : null;
    },
    create: async (args: { data: Record<string, unknown> }): Promise<{ id: bigint | string }> => {
      const id = this.nextAuditId++;
      this.audits.push({
        id,
        actorId: (args.data.actorId as string | null) ?? null,
        requestId: args.data.requestId as string | undefined,
        action: args.data.action as string,
        actorType: args.data.actorType as string,
      });
      return { id };
    },
  };
}

function seed(
  db: FakeBackfillDb,
  id: string,
  sourceLanguageCode: string,
  sourceLanguageName: string | null,
  sourceLocale: string | null = null,
) {
  db.rows.push({ id, sourceLanguageCode, sourceLanguageName, sourceLocale });
}

describe("backfillSourceItemLocale · dry-run", () => {
  it("零写入：只报告将变更的行数与每码计数，不落库", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", "英语"); // sourceLocale 目前是 NULL，应变为 en
    seed(db, "2", "7", "俄语");

    const report = await backfillSourceItemLocale(db);

    expect(report.mode).toBe("dry-run");
    expect(report.wrote).toBe(false);
    expect(report.scanned).toBe(2);
    expect(report.changed).toBe(2);
    expect(report.mappingVersion).toBe(MAPPING_VERSION);
    // 未写库：行仍是种下的 NULL。
    expect(db.rows.find((row) => row.id === "1")!.sourceLocale).toBeNull();
    expect(db.rows.find((row) => row.id === "2")!.sourceLocale).toBeNull();
  });

  it("每码 before/after 计数分别桶装，null 桶用字面键 \"null\"", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", null); // 未登记文案，code 命中 en
    seed(db, "2", "19", null); // 无名码，恒 unknown

    const report = await backfillSourceItemLocale(db);

    expect(report.byCode["3"]).toEqual({ total: 1, before: { null: 1 }, after: { en: 1 }, changed: 1 });
    expect(report.byCode["19"]).toEqual({ total: 1, before: { null: 1 }, after: { null: 1 }, changed: 0 });
  });

  it("默认扫 sourceLocale IS NULL 或遗留字面串 'unknown' 的行，不扫已有真实值的行；--re-resolve 才重算全部三类（Opus 复核 BLOCKING #1 — X8 实测 IS NULL=0 行/='unknown'=50625 行，默认过滤曾恒等扫 0 行）", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "4", "西语", LEGACY_UNKNOWN_LOCALE_LITERAL); // 旧 worker 遗留字面串 'unknown'
    seed(db, "2", "7", "俄语", null); // SQL NULL
    seed(db, "3", "3", "英语", "en"); // 已有真实值，默认不该被扫到

    const defaultReport = await backfillSourceItemLocale(db);
    expect(defaultReport.scanned).toBe(2); // 只扫行 1（'unknown'）与行 2（NULL）
    expect(defaultReport.changed).toBe(2); // 'unknown'→es，NULL→ru
    // dry-run：一律不落库。
    expect(db.rows.find((row) => row.id === "1")!.sourceLocale).toBe(LEGACY_UNKNOWN_LOCALE_LITERAL);
    expect(db.rows.find((row) => row.id === "2")!.sourceLocale).toBeNull();
    expect(db.rows.find((row) => row.id === "3")!.sourceLocale).toBe("en"); // 未被触碰/未被扫描

    const reResolveReport = await backfillSourceItemLocale(db, { reResolve: true });
    expect(reResolveReport.scanned).toBe(3); // 三类全扫，包括已有真实值的行 3
    expect(reResolveReport.changed).toBe(2); // 行 1、行 2 变更；行 3（英语→en）本就正确，不计变更
  });
});

describe("backfillSourceItemLocale · scanned=0 不写审计；scanned>0 changed=0 仍写审计（Opus 复核 BLOCKING #2）", () => {
  it("--apply 命中 0 行（未给 --re-resolve 时目标集为空）→ 不写 OperationAudit，wrote=false，auditId=null", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "active" });
    seed(db, "1", "3", "英语", "en"); // 已是真实值，默认目标集扫不到

    const report = await backfillSourceItemLocale(db, { apply: true, approver: "ops" });
    expect(report.scanned).toBe(0);
    expect(report.scannedZero).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.auditId).toBeNull();
    expect(db.audits).toHaveLength(0);
  });

  it("scanned>0 但 changed=0（扫到的行核对后无需变更）→ 仍写 OperationAudit", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "active" });
    seed(db, "1", "19", null, null); // 无成对证据（MAPPING_EVIDENCE_MISSING）：NULL → NULL，scanned=1 但 changed=0

    const report = await backfillSourceItemLocale(db, { apply: true, approver: "ops" });
    expect(report.scanned).toBe(1);
    expect(report.changed).toBe(0);
    expect(report.scannedZero).toBe(false);
    expect(report.wrote).toBe(true);
    expect(report.auditId).not.toBeNull();
    expect(db.audits).toHaveLength(1);
  });

  it("dry-run 下 scanned=0 同样标出 scannedZero=true（供 CLI 打印告警）；dry-run 本来就不写审计", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", "英语", "en");

    const report = await backfillSourceItemLocale(db);
    expect(report.scannedZero).toBe(true);
    expect(report.wrote).toBe(false);
    expect(report.auditId).toBeNull();
  });

  it("--request-id 重放优先于 scannedZero：第一轮真实写入命中的目标集耗尽后重放，仍能找回原 auditId 而不新写一条", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "active" });
    seed(db, "1", "3", "英语", null); // 首轮默认目标集命中（NULL）

    const first = await backfillSourceItemLocale(db, { apply: true, approver: "ops", requestId: "req-zero-replay" });
    expect(first.scannedZero).toBe(false);
    expect(first.wrote).toBe(true);
    expect(db.rows[0]!.sourceLocale).toBe("en"); // 首轮已把行 1 写成 en

    // 重放：同一 request-id，但此刻默认目标集已经空了（行 1 已经是真实值 en）。
    const replay = await backfillSourceItemLocale(db, { apply: true, approver: "ops", requestId: "req-zero-replay" });
    expect(replay.scanned).toBe(0);
    expect(replay.scannedZero).toBe(true);
    expect(replay.wrote).toBe(false);
    expect(replay.auditId).toBe(first.auditId); // 找回原审计，不是 null
    expect(db.audits).toHaveLength(1); // 没有新增第二条
  });
});

describe("backfillSourceItemLocale · --batch-size 校验（Opus 复核 NON_BLOCKING c）", () => {
  it.each([0, -1, -100, 1.5, Number.NaN])(
    "非正整数/非整数 batchSize=%s → invalid_batch_size，且从不触达 db 读",
    async (batchSize) => {
      const db = new FakeBackfillDb();
      seed(db, "1", "3", "英语");
      let findManyCalled = false;
      const originalFindMany = db.novelSourceItem.findMany.bind(db.novelSourceItem);
      (db.novelSourceItem as unknown as { findMany: typeof db.novelSourceItem.findMany }).findMany = async (
        args,
      ) => {
        findManyCalled = true;
        return originalFindMany(args);
      };

      const error = await backfillSourceItemLocale(db, { batchSize }).catch((e) => e);
      expect(error).toBeInstanceOf(BackfillSourceItemLocaleError);
      expect((error as BackfillSourceItemLocaleError).code).toBe("invalid_batch_size");
      expect(findManyCalled).toBe(false);
    },
  );

  it("合法正整数 batchSize 不受影响，report.batchSize 原样回显", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", "英语");

    const report = await backfillSourceItemLocale(db, { batchSize: 10 });
    expect(report.batchSize).toBe(10);
  });

  it("越过 MAX_BATCH_SIZE 的正整数仍被钳制，不算校验失败", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", "英语");

    const report = await backfillSourceItemLocale(db, { batchSize: 999_999 });
    expect(report.batchSize).toBe(5000);
  });
});

describe("backfillSourceItemLocale · --apply 审批门禁", () => {
  it("--apply 不给 --approver 直接拒绝，零读写", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", "英语");

    await expect(backfillSourceItemLocale(db, { apply: true })).rejects.toThrow(BackfillSourceItemLocaleError);
    expect(db.rows[0]!.sourceLocale).toBeNull();
  });

  it("approver 在 admin_identity 里不存在 → 拒绝", async () => {
    const db = new FakeBackfillDb();
    seed(db, "1", "3", "英语");

    const error = await backfillSourceItemLocale(db, { apply: true, approver: "ghost-admin" }).catch((e) => e);
    expect(error).toBeInstanceOf(BackfillSourceItemLocaleError);
    expect((error as BackfillSourceItemLocaleError).code).toBe("approver_not_found");
    expect(db.rows[0]!.sourceLocale).toBeNull();
  });

  it("approver 存在但 status 非 active → 拒绝", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "disabled" });
    seed(db, "1", "3", "英语");

    const error = await backfillSourceItemLocale(db, { apply: true, approver: "ops" }).catch((e) => e);
    expect(error).toBeInstanceOf(BackfillSourceItemLocaleError);
    expect((error as BackfillSourceItemLocaleError).code).toBe("approver_inactive");
  });
});

describe("backfillSourceItemLocale · --apply 幂等", () => {
  it("首轮写入命中的行，第二轮重跑零变化", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "active" });
    seed(db, "1", "3", "英语");
    seed(db, "2", "19", null);
    seed(db, "3", "8", "意大利语"); // 非站点语种，仍会写入 it（映射成功≠站点语种）

    const first = await backfillSourceItemLocale(db, { apply: true, approver: "ops" });
    expect(first.mode).toBe("apply");
    expect(first.wrote).toBe(true);
    expect(first.changed).toBe(2); // 行 1（→en）与行 3（→it）；行 2 本就是 null→null，不计变更
    expect(db.rows.find((row) => row.id === "1")!.sourceLocale).toBe("en");
    expect(db.rows.find((row) => row.id === "2")!.sourceLocale).toBeNull();
    expect(db.rows.find((row) => row.id === "3")!.sourceLocale).toBe("it");

    const second = await backfillSourceItemLocale(db, { apply: true, approver: "ops", reResolve: true });
    expect(second.changed).toBe(0);
    expect(second.scanned).toBe(3);
  });

  it("同一 --request-id 重放不产生第二条 OperationAudit", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "active" });
    seed(db, "1", "3", "英语");

    const first = await backfillSourceItemLocale(db, { apply: true, approver: "ops", requestId: "req-1" });
    expect(first.wrote).toBe(true);
    expect(db.audits).toHaveLength(1);

    const replay = await backfillSourceItemLocale(db, { apply: true, approver: "ops", requestId: "req-1" });
    expect(replay.wrote).toBe(false);
    expect(replay.auditId).toBe(first.auditId);
    expect(db.audits).toHaveLength(1);
  });

  it("并发写入不会被覆盖：conditional updateMany 重申读到的旧值", async () => {
    const db = new FakeBackfillDb();
    db.admins.push({ id: "admin-1", username: "ops", status: "active" });
    seed(db, "1", "3", "英语");
    const originalFindMany = db.novelSourceItem.findMany.bind(db.novelSourceItem);
    let firstCall = true;
    (db.novelSourceItem as unknown as { findMany: typeof db.novelSourceItem.findMany }).findMany = async (args) => {
      const rows = await originalFindMany(args);
      if (firstCall) {
        firstCall = false;
        db.rows[0]!.sourceLocale = "concurrently-written";
      }
      return rows;
    };

    const report = await backfillSourceItemLocale(db, { apply: true, approver: "ops" });
    expect(report.changed).toBe(1); // still counted as "would change" against the read snapshot
    expect(db.rows[0]!.sourceLocale).toBe("concurrently-written"); // not clobbered by the conditional write
  });
});
