/**
 * B-38 运维命令 `scripts/ops/effective-tag-projection.ts` 的单元层契约（不连数据库）：
 * 参数解析、"不带确认短语一律只读"、退出码、输出行格式。真实库上的 check / reconcile 由
 * `tests/integration/tagging/effective-tag-projection-postgres.test.ts` 覆盖。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  EFFECTIVE_TAG_EXIT,
  EFFECTIVE_TAG_RECONCILE_CONFIRM_PHRASE,
  parseEffectiveTagOpsArgs,
  runEffectiveTagOps,
} from "../../../scripts/ops/effective-tag-projection";

const PHRASE = "RECONCILE-EFFECTIVE-TAGS";

describe("parseEffectiveTagOpsArgs", () => {
  it("确认短语就是 RECONCILE-EFFECTIVE-TAGS", () => {
    expect(EFFECTIVE_TAG_RECONCILE_CONFIRM_PHRASE).toBe(PHRASE);
  });

  it("默认与 check 都是只读检查", () => {
    expect(parseEffectiveTagOpsArgs([])).toEqual({ mode: "check" });
    expect(parseEffectiveTagOpsArgs(["check"])).toEqual({ mode: "check" });
  });

  it("reconcile 必须同时带 --apply 和精确的确认短语才算 apply", () => {
    expect(parseEffectiveTagOpsArgs(["reconcile"])).toEqual({ mode: "reconcile", apply: false });
    expect(parseEffectiveTagOpsArgs(["reconcile", "--apply"])).toEqual({ mode: "reconcile", apply: false });
    expect(parseEffectiveTagOpsArgs(["reconcile", "--confirm", PHRASE])).toEqual({ mode: "reconcile", apply: false });
    expect(parseEffectiveTagOpsArgs(["reconcile", "--apply", "--confirm", "reconcile-effective-tags"])).toEqual({ mode: "reconcile", apply: false });
    expect(parseEffectiveTagOpsArgs(["reconcile", "--apply", "--confirm", `${PHRASE} `])).toEqual({ mode: "reconcile", apply: false });
    expect(parseEffectiveTagOpsArgs(["reconcile", "--apply", "--confirm", PHRASE])).toEqual({ mode: "reconcile", apply: true });
    expect(parseEffectiveTagOpsArgs(["--apply", "--confirm", PHRASE, "reconcile"])).toEqual({ mode: "reconcile", apply: true });
  });

  it("未知子命令 / 多余参数直接报错，不会悄悄当成 check", () => {
    expect(() => parseEffectiveTagOpsArgs(["rebuild"])).toThrow("effective_tag_ops_unknown_command");
    expect(() => parseEffectiveTagOpsArgs(["check", "reconcile"])).toThrow("effective_tag_ops_too_many_arguments");
  });
});

function fakeDb(options: { check: Array<{ missing: number; extra: number; changed: number }>; apply?: { inserted: number; updated: number; deleted: number } }) {
  const statements: string[] = [];
  let checkCall = 0;
  const makeClient = () => {
    const client = {
      $executeRawUnsafe: vi.fn(async (sql: string) => { statements.push(sql); return 0; }),
      $queryRaw: vi.fn(async (statement: Prisma.Sql) => {
        if (statement.sql.includes("'summary'::text")) {
          statements.push("check");
          const summary = options.check[Math.min(checkCall++, options.check.length - 1)]!;
          return [
            { kind: "summary", novel_id: null, canonical_tag_id: null, ...summary },
            ...(summary.missing > 0
              ? [{ kind: "missing", novel_id: "00000000-0000-4000-8000-000000000001", canonical_tag_id: "00000000-0000-4000-8000-000000000002", missing: null, extra: null, changed: null }]
              : []),
          ];
        }
        if (statement.sql.includes("INSERT INTO novel_effective_tag")) {
          statements.push("apply");
          return [options.apply ?? { inserted: 0, updated: 0, deleted: 0 }];
        }
        statements.push("lock");
        return [];
      }),
    };
    return client;
  };
  const db = { ...makeClient(), $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(makeClient())) };
  return { db: db as never, statements };
}

describe("runEffectiveTagOps", () => {
  it("check：全 0 → 退出 0，输出 EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0", async () => {
    const { db } = fakeDb({ check: [{ missing: 0, extra: 0, changed: 0 }] });
    const result = await runEffectiveTagOps(db, { mode: "check" });
    expect(result.exitCode).toBe(EFFECTIVE_TAG_EXIT.clean);
    expect(result.lines).toEqual(["EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0"]);
  });

  it("check：有差异 → 退出 3，并列出样例", async () => {
    const { db } = fakeDb({ check: [{ missing: 2, extra: 0, changed: 1 }] });
    const result = await runEffectiveTagOps(db, { mode: "check" });
    expect(result.exitCode).toBe(3);
    expect(EFFECTIVE_TAG_EXIT.differences).toBe(3);
    expect(result.lines[0]).toBe("EFFECTIVE_TAG_CHECK missing=2 extra=0 changed=1");
    expect(result.lines[1]).toBe(
      "EFFECTIVE_TAG_CHECK_SAMPLE kind=missing novel_id=00000000-0000-4000-8000-000000000001 canonical_tag_id=00000000-0000-4000-8000-000000000002",
    );
  });

  it("reconcile 没有 --apply 或没有确认短语：只做只读检查，一次写入都不发（不拿锁、不跑 INSERT）", async () => {
    const { db, statements } = fakeDb({ check: [{ missing: 1, extra: 0, changed: 0 }] });
    const result = await runEffectiveTagOps(db, { mode: "reconcile", apply: false });
    expect(statements).toEqual(["SET TRANSACTION READ ONLY", "check"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toEqual(["effective_tag_reconcile_not_confirmed: ran the read-only check instead"]);
  });

  it("reconcile --apply --confirm：先对账再复查，复查为零才退出 0；输出对账计数与耗时", async () => {
    const { db, statements } = fakeDb({
      check: [{ missing: 0, extra: 0, changed: 0 }],
      apply: { inserted: 3, updated: 1, deleted: 2 },
    });
    let now = 1_000;
    const result = await runEffectiveTagOps(db, { mode: "reconcile", apply: true }, () => (now += 250));
    expect(statements).toEqual(["lock", "apply", "SET TRANSACTION READ ONLY", "check"]);
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual([
      "EFFECTIVE_TAG_RECONCILE inserted=3 updated=1 deleted=2 ms=250",
      "EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0",
    ]);
  });

  it("reconcile 之后复查仍有差异 → 退出 3（不会因为'已经执行过'就报成功）", async () => {
    const { db } = fakeDb({ check: [{ missing: 0, extra: 1, changed: 0 }], apply: { inserted: 0, updated: 0, deleted: 0 } });
    const result = await runEffectiveTagOps(db, { mode: "reconcile", apply: true });
    expect(result.exitCode).toBe(3);
  });

  it("输出里不含连接串、口令或环境变量名", async () => {
    const { db } = fakeDb({ check: [{ missing: 0, extra: 0, changed: 0 }], apply: { inserted: 0, updated: 0, deleted: 0 } });
    process.env.DATABASE_URL = "postgresql://secret_user:secret_pass@db.invalid:5432/x";
    try {
      const result = await runEffectiveTagOps(db, { mode: "reconcile", apply: true });
      const output = [...result.lines, ...result.stderr].join("\n");
      expect(output).not.toMatch(/secret_pass|postgresql:|DATABASE_URL/);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});
