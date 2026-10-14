/**
 * v0.6.0 数据库层收紧（复核 MAJOR-1）：字典漂移检查必须看得见"没登记的函数"，尤其是 SECURITY DEFINER 函数。
 *
 * 此前活库检查只查 `public` 里 `prokind = 'f'` 的函数，而且只做"字典 → 活库"的单向核对：以后某个迁移新建了
 * SECURITY DEFINER 函数却没登记字典，静态检查和活库检查都会是 drift = 0，"新增 DEFINER 函数必须改白名单"就成了空话。
 * 现在：
 *   1. 活库里任何 `prosecdef = true` 的函数（非系统 schema、非扩展自带），只要不在白名单就失败——与是否登记无关；
 *   2. 活库里每个函数 / 存储过程（非系统 schema、非扩展自带）必须在字典里有 active 记录（schema + 名字 + 参数一致），
 *      对不上就失败——与约束 / 索引 / 触发器的反向核对同一纪律；
 *   3. 白名单是脚本里的模块级常量，静态检查和活库检查共用。
 *
 * 真实库：用 migration_owner 在一次性库里建各种"没登记 / 登记了但不在白名单 / 登记且在白名单"的函数，
 * 直接调用脚本导出的检查函数，并把整支 CLI 当子进程跑一遍看退出码。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ALLOWED_DEFINER_FUNCTIONS,
  assertCatalogConsistency,
  assertStaticConsistency,
  loadRepoDictionary,
} from "../../../scripts/check-database-dictionary-drift.mjs";

import { analyst, assertDisposableDatabase, enabled, owner, scheduler, web, worker } from "./support";

const root = path.resolve(import.meta.dirname, "../../..");

type DictionaryRecord = Record<string, unknown>;

async function problemsOf(run: () => Promise<unknown> | unknown): Promise<string[] | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const message = String((error as Error).message);
    return message.split("\n- ").slice(1);
  }
}

/** 照真实的取码函数记录复制出一条字典记录（只改函数名 / 参数 / 安全属性）。 */
function functionRecord(base: DictionaryRecord, overrides: DictionaryRecord): DictionaryRecord {
  return { ...base, ...overrides, stable_key: `db:public:promo_link:${String(overrides.physical_name)}` };
}

describe.skipIf(!enabled).sequential("v0.6.0 字典漂移检查：看得见没登记的函数（真实库）", () => {
  let repo: Awaited<ReturnType<typeof loadRepoDictionary>>;
  let definerRecord: DictionaryRecord;

  beforeAll(async () => {
    await assertDisposableDatabase();
    repo = await loadRepoDictionary();
    definerRecord = repo.records.find((record: DictionaryRecord) => record.physical_name === "code_mode_upstream_code")!;
    expect(definerRecord).toBeTruthy();
  });

  afterEach(async () => {
    // 每个用例造的东西一律清掉，免得影响后面的用例和运行器收尾的活库漂移检查
    await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS public.zz_unregistered_definer()");
    await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS public.zz_unregistered_plain(int)");
    await owner.$executeRawUnsafe("DROP PROCEDURE IF EXISTS public.zz_unregistered_proc()");
    await owner.$executeRawUnsafe("DROP FUNCTION IF EXISTS public.zz_registered_definer(text)");
    await owner.$executeRawUnsafe("DROP SCHEMA IF EXISTS zz_other_schema CASCADE");
    await owner.$executeRawUnsafe("DROP EXTENSION IF EXISTS pgcrypto");
  });

  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect(), analyst.$disconnect()]);
  });

  const check = (records = repo.records, options: Record<string, unknown> = {}) =>
    assertCatalogConsistency(records, { prisma: owner, ...options });

  it("基线：仓库字典 + 干净的库 → 通过（取码函数是登记且在白名单内的唯一 DEFINER 函数）", async () => {
    expect([...ALLOWED_DEFINER_FUNCTIONS.keys()]).toEqual(["code_mode_upstream_code"]);
    expect(assertStaticConsistency(repo.schemaTables, repo.records)).toMatchObject({ recordCount: repo.records.length });
    expect(await check()).toMatchObject({ tableCount: 58, triggerCount: 4 });
    const definers = await owner.$queryRaw<Array<{ name: string }>>`
      SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`;
    expect(definers.map((row) => row.name)).toEqual(["code_mode_upstream_code"]);
  });

  it("新建一个没登记的 SECURITY DEFINER 函数 → 检查失败（既不在白名单，也没登记字典），静态检查仍通过（它看不见活库）", async () => {
    await owner.$executeRawUnsafe(`CREATE FUNCTION public.zz_unregistered_definer() RETURNS int LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public AS 'SELECT 1'`);
    const problems = await problemsOf(() => check());
    expect(problems).toEqual(expect.arrayContaining([
      "SECURITY DEFINER function is not on the allow-list public.zz_unregistered_definer()",
      "database function missing from dictionary public.zz_unregistered_definer()",
    ]));
    // 静态检查只看字典文件，本来就看不见活库——所以活库检查才是这条纪律的牙齿
    expect(() => assertStaticConsistency(repo.schemaTables, repo.records)).not.toThrow();
  });

  it("新建一个没登记的普通函数（SECURITY INVOKER）→ 检查失败：活库里的每个函数都要有字典记录", async () => {
    await owner.$executeRawUnsafe("CREATE FUNCTION public.zz_unregistered_plain(a int) RETURNS int LANGUAGE sql AS 'SELECT a'");
    const problems = await problemsOf(() => check());
    expect(problems).toEqual(["database function missing from dictionary public.zz_unregistered_plain(a integer)"]);
  });

  it("新建一个没登记的 SECURITY DEFINER 存储过程（prokind = 'p'，旧检查只查 'f'）→ 检查失败", async () => {
    await owner.$executeRawUnsafe(`CREATE PROCEDURE public.zz_unregistered_proc() LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public AS 'SELECT 1'`);
    const problems = await problemsOf(() => check());
    expect(problems).toEqual(expect.arrayContaining([
      "SECURITY DEFINER function is not on the allow-list public.zz_unregistered_proc()",
      "database function missing from dictionary public.zz_unregistered_proc()",
    ]));
  });

  it("新建在 public 以外的 schema 里的 SECURITY DEFINER 函数 → 检查失败（硬规则不限 public）", async () => {
    await owner.$executeRawUnsafe("CREATE SCHEMA zz_other_schema");
    await owner.$executeRawUnsafe(`CREATE FUNCTION zz_other_schema.zz_elsewhere() RETURNS int LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog AS 'SELECT 1'`);
    const problems = await problemsOf(() => check());
    expect(problems).toEqual(expect.arrayContaining([
      "SECURITY DEFINER function is not on the allow-list zz_other_schema.zz_elsewhere()",
      "database function missing from dictionary zz_other_schema.zz_elsewhere()",
    ]));
  });

  it("硬规则与是否登记无关：字典里登记了、但不在白名单的 DEFINER 函数 → 静态检查和活库检查都失败", async () => {
    await owner.$executeRawUnsafe(`CREATE FUNCTION public.zz_registered_definer(p text) RETURNS text LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public AS 'SELECT p'`);
    const registered = functionRecord(definerRecord, {
      physical_name: "zz_registered_definer", function_identity_arguments: "p text", function_return_type: "text", function_security: "definer",
    });
    const records = [...repo.records, registered];
    // 静态：字典合同只放行白名单里的 DEFINER 函数
    expect(await problemsOf(() => assertStaticConsistency(repo.schemaTables, records))).toEqual([
      `invalid registered function contract ${String(registered.stable_key)}`,
    ]);
    // 活库：登记了也不行，不在白名单就是不行
    expect(await problemsOf(() => check(records))).toEqual([
      "SECURITY DEFINER function is not on the allow-list public.zz_registered_definer(p text)",
    ]);
  });

  it("登记 + 在白名单内（有意识地改了白名单）→ 静态检查和活库检查都通过；只登记不建函数 → 失败", async () => {
    const allowlist = new Map(ALLOWED_DEFINER_FUNCTIONS);
    allowlist.set("zz_registered_definer", { schema: "public", identityArguments: "p text", returnType: "text" });
    const registered = functionRecord(definerRecord, {
      physical_name: "zz_registered_definer", function_identity_arguments: "p text", function_return_type: "text", function_security: "definer",
    });
    const records = [...repo.records, registered];

    // 字典里登记了、库里还没有这个函数 → "字典 → 活库"方向失败
    expect(await problemsOf(() => check(records, { allowedDefinerFunctions: allowlist }))).toEqual([
      "dictionary function missing or incompatible zz_registered_definer",
    ]);

    await owner.$executeRawUnsafe(`CREATE FUNCTION public.zz_registered_definer(p text) RETURNS text LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public AS 'SELECT p'`);
    expect(() => assertStaticConsistency(repo.schemaTables, records, { allowedDefinerFunctions: allowlist })).not.toThrow();
    expect(await check(records, { allowedDefinerFunctions: allowlist })).toMatchObject({ tableCount: 58 });
    // 白名单条目与活库不一致（参数 / 返回类型对不上）也失败
    const wrongShape = new Map(allowlist);
    wrongShape.set("zz_registered_definer", { schema: "public", identityArguments: "p text", returnType: "integer" });
    expect(await problemsOf(() => check(records, { allowedDefinerFunctions: wrongShape }))).toEqual([
      "SECURITY DEFINER function is not on the allow-list public.zz_registered_definer(p text)",
    ]);
  });

  it("扩展自带的函数不算（pg_depend deptype = 'e'）：装上 pgcrypto 之后检查仍然通过", async () => {
    await owner.$executeRawUnsafe("CREATE EXTENSION pgcrypto WITH SCHEMA public");
    const extensionFunctions = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'digest'`;
    expect(Number(extensionFunctions[0]!.n)).toBeGreaterThan(0); // 确实在 public 里放了扩展函数
    expect(await check()).toMatchObject({ tableCount: 58 });
  });

  it("整支 CLI 当子进程跑：干净库退出 0；有没登记的 DEFINER 函数退出非 0 并在 stderr 点名", async () => {
    const run = () => spawnSync("node", ["scripts/check-database-dictionary-drift.mjs"], {
      cwd: root, env: { ...process.env, DATABASE_URL: process.env.PLOTNOVEL_OWNER_DATABASE_URL }, encoding: "utf8", timeout: 60_000,
    });
    const clean = run();
    expect(clean.status, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout.trim())).toMatchObject({ status: "ok", triggerCount: 4 });

    await owner.$executeRawUnsafe(`CREATE FUNCTION public.zz_unregistered_definer() RETURNS int LANGUAGE sql SECURITY DEFINER
      SET search_path = pg_catalog, public AS 'SELECT 1'`);
    const dirty = run();
    expect(dirty.status).not.toBe(0);
    expect(dirty.stderr).toContain("SECURITY DEFINER function is not on the allow-list public.zz_unregistered_definer()");
  });
});
