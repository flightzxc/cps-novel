/**
 * B-38 第二段·真实库用例 1/7：推广链接"可用"——数据库片段 `promoReadySql` 与程序 `isPromoReady` 完全等价。
 *
 * 方案 4.2：数据库侧用与程序 `String.prototype.trim` 完全相同的 25 个空白字符做 `btrim`（字符集作为绑定参数），
 * 所以"读取端完全等价、不回填、不改存量数据"才成立。这里把 Unicode 基本平面的**每一个字符**（U+0001–U+FFFF，
 * 跳过代理区；U+0000 数据库存不了）单独作为 web_url、再单独作为 app_url，配合 status / 另一个地址的各种取值，
 * 分别在 PostgreSQL（真实的 `promoReadySql`）和 JS（真实的 `isPromoReady`）里判一次，要求逐行一致。
 * 不必真的插入 6.3 万行 promo_link：对 `unnest(...)` 构造的虚拟表套同一个片段（片段只认列名 status / web_url / app_url）。
 * 另加组合样例与几个非基本平面字符。将来 Node 升级让 `trim` 的空白集变了，或 PostgreSQL 对某个字符的 btrim 行为不同，
 * 这条用例立刻变红。
 *
 * 运行：`bash scripts/run-public-list-postgres-verification.sh`（一次性 postgres:16.14，真实角色）。
 */
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPromoReady, JS_TRIM_WHITESPACE_CHARACTERS, promoReadySql } from "@/server/publication/visibility";

import { assertIsolatedDatabase, connectRoles, disconnectRoles, enabled } from "../tagging/effective-tag-fixtures";

const roles = connectRoles();
const { web } = roles;

/** 数据库里没有 NULL 数组元素的可靠往返方式，用一个不可能与测试字符串相撞的哨兵表示 NULL。 */
const NULL_SENTINEL = "__B38_NULL__";

type Sample = Readonly<{ status: string; webUrl: string | null; appUrl: string | null }>;

async function judgeInDatabase(samples: readonly Sample[]): Promise<boolean[]> {
  const encode = (value: string | null) => (value === null ? NULL_SENTINEL : value);
  const rows = await web.$queryRaw<Array<{ idx: number; ready: boolean }>>(Prisma.sql`
    SELECT p.idx::int AS idx, (${promoReadySql("p")}) AS ready
    FROM (
      SELECT t.status,
             NULLIF(t.web_url, ${NULL_SENTINEL}) AS web_url,
             NULLIF(t.app_url, ${NULL_SENTINEL}) AS app_url,
             t.idx
      FROM unnest(${samples.map((s) => s.status)}::text[], ${samples.map((s) => encode(s.webUrl))}::text[], ${samples.map((s) => encode(s.appUrl))}::text[])
        WITH ORDINALITY AS t(status, web_url, app_url, idx)
    ) p
    ORDER BY p.idx
  `);
  expect(rows).toHaveLength(samples.length);
  return rows.map((row) => row.ready);
}

function judgeInJs(samples: readonly Sample[]): boolean[] {
  return samples.map((s) => isPromoReady({ status: s.status, webUrl: s.webUrl, appUrl: s.appUrl }));
}

function describeSample(sample: Sample): string {
  const show = (value: string | null) => value === null ? "NULL" : [...value].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ") || "''";
  return `status=${sample.status} web=${show(sample.webUrl)} app=${show(sample.appUrl)}`;
}

async function expectIdentical(samples: readonly Sample[]): Promise<{ ready: number; notReady: number }> {
  const database = await judgeInDatabase(samples);
  const program = judgeInJs(samples);
  const disagreements: string[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    if (database[index] !== program[index]) {
      disagreements.push(`${describeSample(samples[index]!)} database=${database[index]} program=${program[index]}`);
    }
  }
  expect(disagreements.slice(0, 20)).toEqual([]);
  return { ready: program.filter(Boolean).length, notReady: program.filter((v) => !v).length };
}

/** U+0001–U+FFFF，跳过代理区。 */
function bmpCharacters(): string[] {
  const chars: string[] = [];
  for (let codePoint = 1; codePoint <= 0xffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    chars.push(String.fromCodePoint(codePoint));
  }
  return chars;
}

describe.skipIf(!enabled).sequential("B-38 promoReadySql 与 isPromoReady 完全等价（真实 web_app 连接、真实 PostgreSQL 16）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(roles.owner);
  });
  afterAll(async () => { await disconnectRoles(roles); });

  it("用的是真实 web_app 角色，PostgreSQL 主版本 16", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
    const [{ v }] = await web.$queryRaw<Array<{ v: string }>>`SELECT current_setting('server_version') AS v`;
    expect(v.startsWith("16.")).toBe(true);
  });

  it("U+0001–U+FFFF 每个字符单独作为 web_url：app_url ∈ {NULL, '', 正常值} × status ∈ {fetched, pending}", async () => {
    const chars = bmpCharacters();
    expect(chars).toHaveLength(0x10000 - 1 - (0xdfff - 0xd800 + 1));
    let readyTotal = 0;
    let notReadyTotal = 0;
    for (const status of ["fetched", "pending"]) {
      for (const appUrl of [null, "", "https://app.example/x"]) {
        const result = await expectIdentical(chars.map((c) => ({ status, webUrl: c, appUrl })));
        readyTotal += result.ready;
        notReadyTotal += result.notReady;
      }
    }
    // 夹具不是空壳：两种判定结果都大量出现（25 个空白字符 + 'fetched' 以外的 status 才是不可用）。
    expect(readyTotal).toBeGreaterThan(100_000);
    expect(notReadyTotal).toBeGreaterThan(100_000);
  }, 300_000);

  it("U+0001–U+FFFF 每个字符单独作为 app_url：web_url ∈ {NULL, '', 正常值}（status = fetched）", async () => {
    const chars = bmpCharacters();
    for (const webUrl of [null, "", "https://web.example/x"]) {
      await expectIdentical(chars.map((c) => ({ status: "fetched", webUrl, appUrl: c })));
    }
  }, 300_000);

  it("全部 25 个空白字符各自单独、两两相邻、夹在 x 两侧——与 JS trim 一致", async () => {
    const ws = [...JS_TRIM_WHITESPACE_CHARACTERS];
    const samples: Sample[] = [];
    for (const a of ws) {
      samples.push({ status: "fetched", webUrl: a, appUrl: null });
      samples.push({ status: "fetched", webUrl: `${a}x${a}`, appUrl: null });
      samples.push({ status: "fetched", webUrl: `x${a}x`, appUrl: null });
      samples.push({ status: "fetched", webUrl: null, appUrl: `${a}${a}` });
      for (const b of ws) samples.push({ status: "fetched", webUrl: `${a}${b}`, appUrl: `${b}${a}` });
    }
    const result = await expectIdentical(samples);
    expect(result.ready).toBeGreaterThan(0);
    expect(result.notReady).toBeGreaterThan(0);
  });

  it("组合样例：' x '、只有全角空格、开头是 U+FEFF、U+180E、NULL、''、混合空白、空 + 空白", async () => {
    const samples: Sample[] = [
      { status: "fetched", webUrl: " x ", appUrl: null },
      { status: "fetched", webUrl: "　", appUrl: null },
      { status: "fetched", webUrl: "　　　", appUrl: "" },
      { status: "fetched", webUrl: "﻿https://bom.example/x", appUrl: null },
      { status: "fetched", webUrl: "﻿", appUrl: null },
      { status: "fetched", webUrl: "᠎", appUrl: null },
      { status: "fetched", webUrl: "᠎᠎", appUrl: "  " },
      { status: "fetched", webUrl: " ᠎ ", appUrl: null },
      { status: "fetched", webUrl: null, appUrl: null },
      { status: "fetched", webUrl: "", appUrl: "" },
      { status: "fetched", webUrl: "", appUrl: null },
      { status: "fetched", webUrl: null, appUrl: "" },
      { status: "fetched", webUrl: JS_TRIM_WHITESPACE_CHARACTERS, appUrl: null },
      { status: "fetched", webUrl: JS_TRIM_WHITESPACE_CHARACTERS, appUrl: JS_TRIM_WHITESPACE_CHARACTERS },
      { status: "fetched", webUrl: `${JS_TRIM_WHITESPACE_CHARACTERS}x${JS_TRIM_WHITESPACE_CHARACTERS}`, appUrl: null },
      { status: "fetched", webUrl: "  ", appUrl: "https://app.example/x" },
      { status: "fetched", webUrl: "\t\r\n https://t.example  ", appUrl: null },
      { status: "pending", webUrl: "https://ok.example", appUrl: "https://ok.example" },
      { status: "failed", webUrl: "https://ok.example", appUrl: null },
      { status: "registered_disabled", webUrl: "https://ok.example", appUrl: null },
      { status: "FETCHED", webUrl: "https://ok.example", appUrl: null },
      { status: "", webUrl: "https://ok.example", appUrl: null },
    ];
    const expected = [
      true, false, false, true, false, true, true, true, false, false, false, false,
      false, false, true, true, true, false, false, false, false, false,
    ];
    expect(await expectIdentical(samples)).toEqual({ ready: expected.filter(Boolean).length, notReady: expected.filter((v) => !v).length });
    expect(await judgeInDatabase(samples)).toEqual(expected);
  });

  it("几个非基本平面字符（emoji、平面 2 汉字）既不被 btrim 也不被 trim 当空白", async () => {
    const astral = ["\u{1F600}", "\u{20000}", "\u{10FFFF}", "\u{1D11E}", "\u{E0020}"];
    const result = await expectIdentical(astral.flatMap((c) => [
      { status: "fetched", webUrl: c, appUrl: null },
      { status: "fetched", webUrl: `${c}${c}`, appUrl: "" },
      { status: "fetched", webUrl: ` ${c} `, appUrl: null },
    ]));
    expect(result.notReady).toBe(0);
  });
});
