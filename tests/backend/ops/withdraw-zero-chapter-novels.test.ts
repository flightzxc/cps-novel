/**
 * 一次性运维脚本 `scripts/ops/withdraw-zero-chapter-novels-20261007.ts` 的无库单测：
 * 参数、名单解析、请求编号、前置条件求值、错误分类，以及一条静态「不越界」守卫（脚本源码里只允许出现
 * 对 novel / article / operation_audit 的写，且不 import 业务代码）。
 *
 * 真实库用例（与按钮逐项一致、幂等、前置条件拒绝、不越界、单本失败、只读）见
 * `tests/integration/publish-gate/withdraw-zero-chapter-novels-postgres.test.ts`，
 * 由 `scripts/run-article-publish-batch-postgres-verification.sh` 运行。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONFIRM_PHRASE,
  OpsError,
  REQUEST_ID_MAX_LENGTH,
  UsageError,
  buildRequestId,
  classifyError,
  evaluateChecks,
  loadList,
  parseArgs,
  parseListTsv,
  resolveProjectPackageJson,
  type ScopeInspection,
} from "../../../scripts/ops/withdraw-zero-chapter-novels-20261007";

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts/ops/withdraw-zero-chapter-novels-20261007.ts");
const HEADER = "novel_id\tarticle_id\tnovel_source_item_id\texternal_book_id\tlocale\ttitle";
const N1 = "45d14bdb-34b0-4128-80c2-ab7ae825952c";
const A1 = "5de777cc-7127-4f9d-a5e5-26491090a54a";
const S1 = "30386317-58a0-41e7-95c9-f0643b89f78f";
const N2 = "cdf75801-13c1-47bf-879e-26ea2e5dfa33";
const A2 = "386a59d1-1f5a-4f4a-bddf-1c1927a1ff59";
const S2 = "4b198767-abf1-48c8-92ee-641fef553f81";
const ACTOR = "71f0e655-0640-4f07-bcbb-041f027fa7cb";

const APPLY_ARGV = [
  "--list", "/tmp/list.tsv",
  "--list-sha256-prefix", "cc63e467",
  "--expect-count", "236",
  "--reason", "  上游零章节，切换前下线  ",
  "--request-id-prefix", "withdraw-zero-chapter-20261007",
  "--actor-id", ACTOR,
  "--apply",
  "--confirm", CONFIRM_PHRASE,
];

function usageCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).code;
  }
  throw new Error("expected UsageError");
}

describe("parseArgs", () => {
  it("accepts the full execute command line and normalises the values", () => {
    expect(parseArgs(APPLY_ARGV)).toEqual({
      help: false,
      apply: true,
      list: "/tmp/list.tsv",
      listSha256Prefix: "cc63e467",
      expectCount: 236,
      reason: "上游零章节，切换前下线",
      requestIdPrefix: "withdraw-zero-chapter-20261007",
      actorId: ACTOR,
      confirm: CONFIRM_PHRASE,
    });
  });

  it("statistics mode needs only --list; the other flags are optional and still validated", () => {
    const args = parseArgs(["--list", "x.tsv"]);
    expect(args).toMatchObject({ apply: false, listSha256Prefix: undefined, expectCount: undefined, reason: undefined });
    expect(usageCode(() => parseArgs(["--list", "x.tsv", "--expect-count", "0"]))).toBe("invalid_expect_count");
    expect(usageCode(() => parseArgs(["--list", "x.tsv", "--list-sha256-prefix", "cc63"]))).toBe("invalid_list_sha256_prefix");
    expect(usageCode(() => parseArgs(["--list", "x.tsv", "--reason", "   "]))).toBe("reason_required");
  });

  it("--apply requires every flag; each missing one is named", () => {
    const withoutFlag = (flag: string) => {
      const argv = [...APPLY_ARGV];
      const at = argv.indexOf(flag);
      argv.splice(at, 2);
      return argv;
    };
    for (const flag of ["--list-sha256-prefix", "--expect-count", "--reason", "--request-id-prefix", "--actor-id", "--confirm"]) {
      expect(usageCode(() => parseArgs(withoutFlag(flag)))).toBe("missing_argument");
    }
    expect(usageCode(() => parseArgs(withoutFlag("--list")))).toBe("missing_argument");
  });

  it("rejects unknown flags, duplicates, positionals, a missing value and a value-taking --apply", () => {
    expect(usageCode(() => parseArgs(["--list", "x", "--nope", "1"]))).toBe("unknown_flag");
    expect(usageCode(() => parseArgs(["--list", "x", "--list", "y"]))).toBe("duplicate_flag");
    expect(usageCode(() => parseArgs(["--list", "x", "stray"]))).toBe("unexpected_positional_argument");
    expect(usageCode(() => parseArgs(["--list", "x", "--reason", "--apply"]))).toBe("missing_value");
    expect(usageCode(() => parseArgs(["--list", "x", "--apply=1"]))).toBe("flag_takes_no_value");
  });

  it("validates the request-id prefix so every derived request id fits operation_audit.request_id (160)", () => {
    const longest = "p".repeat(REQUEST_ID_MAX_LENGTH - 36 - 1);
    expect(buildRequestId(longest, N1).length).toBe(REQUEST_ID_MAX_LENGTH);
    expect(parseArgs(["--list", "x", "--request-id-prefix", longest]).requestIdPrefix).toBe(longest);
    expect(usageCode(() => parseArgs(["--list", "x", "--request-id-prefix", `${longest}p`]))).toBe("request_id_prefix_too_long");
    expect(usageCode(() => parseArgs(["--list", "x", "--request-id-prefix", "has space"]))).toBe("invalid_request_id_prefix");
    expect(usageCode(() => parseArgs(["--list", "x", "--request-id-prefix", ":lead"]))).toBe("invalid_request_id_prefix");
  });

  it("validates --actor-id as a UUID and the reason length like trimmedReason (<=1000 after trim)", () => {
    expect(usageCode(() => parseArgs(["--list", "x", "--actor-id", "owner"]))).toBe("invalid_actor_id");
    expect(parseArgs(["--list", "x", "--reason", "r".repeat(1000)]).reason).toHaveLength(1000);
    expect(usageCode(() => parseArgs(["--list", "x", "--reason", "r".repeat(1001)]))).toBe("reason_too_long");
  });

  it("--help does not require --list", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("buildRequestId", () => {
  it("derives one distinct request id per novel (operation_audit (request_id, action) is unique)", () => {
    expect(buildRequestId("run", N1)).toBe(`run:${N1}`);
    expect(buildRequestId("run", N1)).not.toBe(buildRequestId("run", N2));
  });
});

describe("parseListTsv / loadList", () => {
  const row = (n: string, a: string, s: string, title = "T") => `${n}\t${a}\t${s}\t5553785\ten\t${title}`;

  it("parses rows, lower-cases ids and keeps odd titles intact", () => {
    const rows = parseListTsv(`${HEADER}\n${row(N1.toUpperCase(), A1, S1, 'Our World, or, "Quoted" é')}\n${row(N2, A2, S2)}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      novelId: N1,
      articleId: A1,
      novelSourceItemId: S1,
      externalBookId: "5553785",
      locale: "en",
      title: 'Our World, or, "Quoted" é',
    });
  });

  it("accepts CRLF line endings and a BOM (the SHA is taken over the raw bytes, not the parse)", () => {
    expect(parseListTsv(`﻿${HEADER}\r\n${row(N1, A1, S1)}\r\n`)).toHaveLength(1);
  });

  it.each([
    ["wrong header", `novel_id\tarticle_id\n${row(N1, A1, S1)}\n`, "list_header_mismatch"],
    ["only a header", `${HEADER}\n`, "list_empty"],
    ["empty file", "", "list_empty"],
    ["short row", `${HEADER}\n${N1}\t${A1}\n`, "list_row_malformed"],
    ["bad uuid", `${HEADER}\n${row("not-a-uuid", A1, S1)}\n`, "list_row_invalid_uuid"],
    ["blank line in the middle", `${HEADER}\n${row(N1, A1, S1)}\n\n${row(N2, A2, S2)}\n`, "list_row_malformed"],
    ["duplicate novel", `${HEADER}\n${row(N1, A1, S1)}\n${row(N1, A2, S2)}\n`, "list_duplicate_novel"],
    ["duplicate article", `${HEADER}\n${row(N1, A1, S1)}\n${row(N2, A1, S2)}\n`, "list_duplicate_article"],
  ])("rejects %s", (_name, text, code) => {
    try {
      parseListTsv(text);
    } catch (error) {
      expect(error).toBeInstanceOf(OpsError);
      expect((error as OpsError).code).toBe(code);
      return;
    }
    throw new Error("expected OpsError");
  });

  it("loadList hashes the raw bytes (SHA-256) and reports unreadable files", () => {
    const bytes = Buffer.from(`${HEADER}\n${row(N1, A1, S1)}\n`, "utf8");
    const loaded = loadList("/virtual/list.tsv", () => bytes);
    expect(loaded.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(loaded.rows).toHaveLength(1);
    expect(() =>
      loadList("/virtual/missing.tsv", () => {
        throw new Error("ENOENT");
      }),
    ).toThrowError(OpsError);
  });
});

describe("resolveProjectPackageJson", () => {
  it("prefers /app/package.json (container) and falls back to the current project's package.json", () => {
    expect(resolveProjectPackageJson("/repo", (target) => target === "/app/package.json")).toBe("/app/package.json");
    expect(resolveProjectPackageJson("/repo", () => false)).toBe(path.join("/repo", "package.json"));
  });
});

function scope(overrides: Partial<ScopeInspection> = {}): ScopeInspection {
  return {
    queryRows: [{ novelId: N1, articleId: A1, novelSourceItemId: S1, externalBookId: "1", locale: "en", title: "T" }],
    queryNovelIds: [N1],
    inListNotInQuery: [],
    inQueryNotInList: [],
    articleMismatches: [],
    replayableChecked: false,
    replayableNovelIds: [],
    republishedAfterWithdraw: [],
    unexplainedMissing: [],
    queryHasOneRowPerNovel: true,
    setsEqual: true,
    novels: [],
    statusCounts: { novel: {}, article: {} },
    localeDistribution: { list: {}, query: {} },
    ...overrides,
  };
}

describe("evaluateChecks", () => {
  const base = {
    args: { apply: true, confirm: CONFIRM_PHRASE, listSha256Prefix: "cc63e467", expectCount: 1 },
    listSha256: `cc63e467${"0".repeat(56)}`,
    listRowCount: 1,
    role: "web_app",
  } as const;

  it("passes when everything matches", () => {
    expect(evaluateChecks({ ...base, scope: scope() }).failures).toEqual([]);
  });

  it.each([
    ["wrong confirm phrase", { args: { ...base.args, confirm: "yes" } }, "confirmPhraseMatches"],
    ["sha mismatch", { listSha256: `deadbeef${"0".repeat(56)}` }, "listSha256PrefixMatches"],
    ["expect-count != list count", { args: { ...base.args, expectCount: 2 } }, "expectCountEqualsListCount"],
    ["expect-count != query count", { listRowCount: 2, args: { ...base.args, expectCount: 2 } }, "expectCountEqualsQueryCount"],
    ["wrong role", { role: "migration_owner" }, "databaseRoleIsWebApp"],
  ])("fails on %s", (_name, override, failure) => {
    expect(evaluateChecks({ ...base, ...override, scope: scope() }).failures).toContain(failure);
  });

  it("fails when the query set differs from the list, or has several rows for one novel", () => {
    expect(evaluateChecks({ ...base, scope: scope({ setsEqual: false }) }).failures).toContain("listAndQuerySetsEqual");
    expect(evaluateChecks({ ...base, scope: scope({ queryHasOneRowPerNovel: false }) }).failures).toContain("queryHasOneRowPerNovel");
  });

  it("counts novels already withdrawn under this prefix as part of the query count (so a re-run is accepted)", () => {
    const rerun = scope({ queryRows: [], queryNovelIds: [], replayableNovelIds: [N1], replayableChecked: true });
    expect(evaluateChecks({ ...base, scope: rerun }).failures).toEqual([]);
  });

  it("in statistics mode flags without a supplied parameter are not applicable (null), not failures", () => {
    const result = evaluateChecks({
      args: { apply: false, confirm: undefined, listSha256Prefix: undefined, expectCount: undefined },
      listSha256: "a".repeat(64),
      listRowCount: 1,
      scope: scope(),
      role: "web_app",
    });
    expect(result.failures).toEqual([]);
    expect(result.checks).toMatchObject({
      confirmPhraseMatches: null,
      listSha256PrefixMatches: null,
      expectCountEqualsListCount: null,
      expectCountEqualsQueryCount: null,
    });
  });
});

describe("classifyError", () => {
  it("maps business, Prisma and unknown errors to stable categories", () => {
    expect(classifyError(new OpsError("novel_not_currently_published"))).toBe("novel_not_currently_published");
    expect(classifyError(Object.assign(new Error("x"), { code: "P2002" }))).toBe("unique_violation");
    expect(classifyError(Object.assign(new Error("x"), { code: "P1008" }))).toBe("transient_db");
    expect(classifyError(Object.assign(new Error("x"), { code: "P2034" }))).toBe("transient_db");
    expect(classifyError(Object.assign(new Error("x"), { code: "P2028" }))).toBe("prisma_P2028");
    expect(classifyError(new Error("Connection reset by peer"))).toBe("transient_db");
    expect(classifyError(new Error("boom"))).toBe("unexpected");
  });
});

describe("script scope guard (static)", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");
  // 去掉注释再扫：头部注释里要写「不碰章节、推广链接……」，不能让注释影响扫描。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("is self-contained: only node: built-ins and @prisma/client, never @/ or src", () => {
    const specifiers = [...code.matchAll(/(?:import|from)\s+(?:type\s+)?(?:[^"']*\sfrom\s+)?["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier === "@prisma/client" || specifier.startsWith("node:")).toBe(true);
    }
    expect(code).not.toMatch(/["']@\//);
    expect(code).not.toMatch(/\.\.\/src|\bsrc\//);
    // @prisma/client 的运行时引用只能经 createRequire，其余是 import type。
    expect(code).toMatch(/import type \{ PrismaClient \} from "@prisma\/client"/);
    expect(code).not.toMatch(/import \{[^}]*\} from "@prisma\/client"/);
  });

  it("touches only novel / article / operation_audit with writes, plus read-only admin_identity / novel_source_item", () => {
    const delegates = new Set([...code.matchAll(/\b(?:db|tx)\.([A-Za-z]\w*)\./g)].map((m) => m[1]!));
    expect([...delegates].sort()).toEqual(["adminIdentity", "article", "novel", "operationAudit"]);

    const writes = [...code.matchAll(/\b(?:db|tx)\.([A-Za-z]\w*)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)];
    expect([...new Set(writes.map((m) => m[1]))].sort()).toEqual(["article", "novel", "operationAudit"]);
    // 章节删除只属于 takedown：withdraw 脚本里不得出现任何删除。
    expect(writes.map((m) => m[2])).not.toContain("delete");
    expect(writes.map((m) => m[2])).not.toContain("deleteMany");

    expect(code).not.toMatch(/\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe/);
    for (const forbidden of [
      "promoLink", "promo_link", "novelChapter", "novel_chapter", "canonicalTag", "canonical_tag", "novelTagState",
      "genericTask", "generic_task", "channelSyncTask", "channel_sync_task", "indexNowOutbox", "indexnow", "sitemap",
      "sideEffectIntent", "side_effect_intent", "trackingEvent",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("only ever writes status \"unpublished\" (never \"published\") to novel / article", () => {
    const statusWrites = [...code.matchAll(/\b(?:db|tx)\.(novel|article)\.(update|updateMany)\(/g)];
    expect(statusWrites).toHaveLength(2);
    expect(code).toMatch(/novel\.update\(\{ where: \{ id: input\.novelId \}, data: \{ status: "unpublished" \} \}\)/);
    expect(code).toMatch(/data: \{ status: "unpublished" \},/);
    expect(code).not.toMatch(/data:\s*\{[^}]*status:\s*"published"/);
  });
});
