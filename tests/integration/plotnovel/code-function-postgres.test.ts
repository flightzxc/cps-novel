/**
 * v0.6.0 数据库层收紧（Owner 2026-10-14）：web_app 不能读 promo_link.upstream_code，口令码只能经
 * SECURITY DEFINER 函数 `public.code_mode_upstream_code(站内码)` 取——真实库、真实角色、真实迁移、真实 grants。
 *
 * 钉住的事：
 *   1. web_app 直接读 upstream_code → permission denied（任何形态）；
 *   2. 函数：口令码模式 + 就绪 → 返回口令码；link 模式（MoboReader）→ NULL；口令码模式但语种不在白名单 / 状态不是 fetched /
 *      口令码空白 / 已软删除 / 站内码不存在 → NULL；规则与 JS `isPromoReady` 的口令码分支逐项一致（矩阵对照）；
 *   3. 函数的形状与授权：属主 migration_owner、SECURITY DEFINER、固定 search_path、标量（不可枚举）、EXECUTE 只有 web_app；
 *   4. 触发器维护的布尔列 upstream_code_present：写入方改不了它；
 *   5. worker_app / scheduler_app 的行为不变；
 *   6. 中间页取数（loadCodeModePageData）端到端仍然可用。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadCodeModePageData } from "@/app/go/_lib/code-mode-page-data";
import { isPromoReady } from "@/server/publication/visibility";

import {
  MOBO_AGENCY,
  PLOT_AGENCY,
  PLOT_CONFIG,
  analyst,
  assertDisposableDatabase,
  enabled,
  ids,
  owner,
  scheduler,
  seedBook,
  seedPromo,
  seedPublished,
  seedTheaters,
  truncateDatabase,
  web,
  worker,
} from "./support";

type Role = typeof web;

async function permissionDenied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return /permission denied/i.test(String((error as Error).message));
  }
}

async function codeFor(role: Role, publicRedirectCode: string | null): Promise<string | null> {
  const [row] = await role.$queryRaw<Array<{ code: string | null }>>`SELECT public.code_mode_upstream_code(${publicRedirectCode}) AS code`;
  return row?.code ?? null;
}

describe.skipIf(!enabled).sequential("v0.6.0 数据库层收紧：code_mode_upstream_code() 与 upstream_code 列授权（真实库）", () => {
  beforeAll(assertDisposableDatabase);
  beforeEach(async () => { await truncateDatabase(); await seedTheaters(); });
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect(), scheduler.$disconnect(), analyst.$disconnect()]);
  });

  describe("web_app 直接读 upstream_code → permission denied", () => {
    it("任何形态的读取都被拒：裸 SELECT、Prisma select、函数包裹、WHERE/ORDER BY 里引用、子查询、CTE、视图式别名", async () => {
      await seedPublished({ appId: ids.plotApp, externalBookId: "p", title: "P", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      await seedPublished({ appId: ids.moboApp, externalBookId: "m", title: "M", agencyId: MOBO_AGENCY, promo: { upstreamCode: "M1", webUrl: "https://example.test/read" } });
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ["裸 SELECT", () => web.$queryRaw`SELECT upstream_code FROM promo_link`],
        ["带表别名", () => web.$queryRaw`SELECT p.upstream_code FROM promo_link p`],
        ["Prisma select", () => web.promoLink.findMany({ select: { upstreamCode: true } })],
        ["Prisma where 里引用", () => web.promoLink.findFirst({ where: { upstreamCode: "960031" }, select: { id: true } })],
        ["函数包裹", () => web.$queryRaw`SELECT md5(upstream_code) FROM promo_link`],
        ["WHERE 里引用（探测口令码前缀）", () => web.$queryRaw`SELECT id FROM promo_link WHERE upstream_code LIKE '96%'`],
        ["ORDER BY 里引用", () => web.$queryRaw`SELECT id FROM promo_link ORDER BY upstream_code`],
        ["子查询", () => web.$queryRaw`SELECT (SELECT upstream_code FROM promo_link LIMIT 1)`],
        ["CTE", () => web.$queryRaw`WITH x AS (SELECT upstream_code FROM promo_link) SELECT * FROM x`],
        ["SELECT *", () => web.$queryRaw`SELECT * FROM promo_link`],
        ["整行引用", () => web.$queryRaw`SELECT promo_link FROM promo_link`],
        ["to_jsonb 整行", () => web.$queryRaw`SELECT to_jsonb(p) FROM promo_link p`],
        ["JOIN 里引用", () => web.$queryRaw`SELECT 1 FROM promo_link a JOIN promo_link b ON a.upstream_code = b.upstream_code`],
      ];
      for (const [name, attempt] of attempts) expect(await permissionDenied(attempt), name).toBe(true);
    });

    it("web_app 的其它既有授权不变（状态、剧场、小说、站内码、网址、派生布尔列照常可读；raw_links 仍是 worker 专属）", async () => {
      await seedPublished({ appId: ids.plotApp, externalBookId: "p", title: "P", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      expect(await permissionDenied(() => web.$queryRaw`
        SELECT id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type, public_redirect_code, idempotency_key,
               origin, status, web_url, app_url, upstream_code_present, deleted_at, fetched_at FROM promo_link`)).toBe(false);
      expect(await permissionDenied(() => web.$queryRaw`SELECT raw_links FROM promo_link`)).toBe(true);
      expect(await permissionDenied(() => web.$queryRaw`SELECT config FROM channel_app`)).toBe(false);
    });

    it("EXECUTE 之外，web_app 也不能靠改 search_path / 建对象绕开：不能建表、不能建函数、不能建 schema", async () => {
      expect(await permissionDenied(() => web.$executeRawUnsafe("CREATE TABLE public.evil_probe (a int)"))).toBe(true);
      expect(await permissionDenied(() => web.$executeRawUnsafe("CREATE FUNCTION public.evil_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'"))).toBe(true);
      expect(await permissionDenied(() => web.$executeRawUnsafe("CREATE SCHEMA evil_probe"))).toBe(true);
    });
  });

  describe("code_mode_upstream_code(站内码)：返回与不返回", () => {
    async function world() {
      const plotReady = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-ready", title: "Plot Ready", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      const moboFull = await seedPublished({ appId: ids.moboApp, externalBookId: "mobo-full", title: "Mobo Full", agencyId: MOBO_AGENCY, promo: { upstreamCode: "M-CODE-1", webUrl: "https://example.test/read" } });
      const moboCodeOnly = await seedPublished({ appId: ids.moboApp, externalBookId: "mobo-code", title: "Mobo Code Only", agencyId: MOBO_AGENCY, promo: { upstreamCode: "M-CODE-2" } });
      const plotFr = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-fr", title: "Plot French", locale: "fr", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960032" } });
      const plotPending = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-pending", title: "Plot Pending", agencyId: PLOT_AGENCY, promo: { status: "pending", upstreamCode: "960033" } });
      const plotFailed = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-failed", title: "Plot Failed", agencyId: PLOT_AGENCY, promo: { status: "failed", upstreamCode: "960034" } });
      const plotBlank = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-blank", title: "Plot Blank", agencyId: PLOT_AGENCY, promo: { upstreamCode: "   " } });
      const plotEmpty = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-empty", title: "Plot Empty", agencyId: PLOT_AGENCY, promo: { upstreamCode: "" } });
      const plotNull = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-null", title: "Plot Null", agencyId: PLOT_AGENCY, promo: { upstreamCode: null } });
      const plotUnicodeBlank = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-uni", title: "Plot Unicode Blank", agencyId: PLOT_AGENCY, promo: { upstreamCode: "　 ﻿\t\n" } });
      const plotDeleted = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-deleted", title: "Plot Deleted", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960035" } });
      await owner.promoLink.update({ where: { id: plotDeleted.promo.id }, data: { deletedAt: new Date() } });
      return { plotReady, moboFull, moboCodeOnly, plotFr, plotPending, plotFailed, plotBlank, plotEmpty, plotNull, plotUnicodeBlank, plotDeleted };
    }

    it("口令码模式 + 就绪 → 返回口令码（原样，含首尾内容的口令码也原样）", async () => {
      const w = await world();
      expect(await codeFor(web, w.plotReady.promo.publicRedirectCode)).toBe("960031");
      const padded = await seedPublished({ appId: ids.plotApp, externalBookId: "plot-pad", title: "Plot Pad", agencyId: PLOT_AGENCY, promo: { upstreamCode: " ZX 96  " } });
      expect(await codeFor(web, padded.promo.publicRedirectCode)).toBe(" ZX 96  "); // 函数返回原值，修剪交给调用方
    });

    it("link 模式（MoboReader）的推广一律 NULL——有网址的、只有口令码的都一样（防误伤：不能借函数读 MoboReader 的码）", async () => {
      const w = await world();
      expect(await codeFor(web, w.moboFull.promo.publicRedirectCode)).toBeNull();
      expect(await codeFor(web, w.moboCodeOnly.promo.publicRedirectCode)).toBeNull();
      // 旧记录 config = {} / 缺 promoMode / 拼错，同样按 link 处理
      for (const config of [{}, { agencyIds: ["3366"] }, { promoMode: "Code" }, { promoMode: "codes" }, { promoMode: true }, { promoMode: null }, { promoMode: ["code"] }]) {
        await owner.channelApp.update({ where: { id: ids.moboApp }, data: { config } });
        expect(await codeFor(web, w.moboCodeOnly.promo.publicRedirectCode), JSON.stringify(config)).toBeNull();
      }
    });

    it("口令码模式但：语种不在白名单 / 状态不是 fetched / 口令码空白（空串、空格、Unicode 空白、NULL）/ 已软删除 → NULL", async () => {
      const w = await world();
      for (const [name, promo] of [
        ["语种 fr 不在白名单", w.plotFr.promo],
        ["status = pending", w.plotPending.promo],
        ["status = failed", w.plotFailed.promo],
        ["口令码是空格", w.plotBlank.promo],
        ["口令码是空串", w.plotEmpty.promo],
        ["口令码是 NULL", w.plotNull.promo],
        ["口令码是 Unicode 空白", w.plotUnicodeBlank.promo],
        ["已软删除", w.plotDeleted.promo],
      ] as const) {
        expect(await codeFor(web, promo.publicRedirectCode), name).toBeNull();
      }
    });

    it("白名单改动立刻生效：放开 fr → 返回；清空 / 缺键 / 非数组 / 改成 link 模式 → NULL", async () => {
      const w = await world();
      const frCode = w.plotFr.promo.publicRedirectCode;
      expect(await codeFor(web, frCode)).toBeNull();
      await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { ...PLOT_CONFIG, codeModeLocales: ["en", "fr"] } } });
      expect(await codeFor(web, frCode)).toBe("960032");
      for (const config of [
        { ...PLOT_CONFIG, codeModeLocales: [] },
        { promoMode: "code" },
        { promoMode: "code", codeModeLocales: "en" },
        { promoMode: "code", codeModeLocales: { 0: "en" } },
        { promoMode: "code", codeModeLocales: [" en"] },
        { promoMode: "code", codeModeLocales: ["EN"] },
        { ...PLOT_CONFIG, promoMode: "link" },
      ]) {
        await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config } });
        expect(await codeFor(web, w.plotReady.promo.publicRedirectCode), JSON.stringify(config)).toBeNull();
      }
    });

    it("不存在的站内码 / NULL / 空串 / 通配符 / 大小写与首尾空格不同的站内码 → NULL（只做精确匹配，不可枚举）", async () => {
      const w = await world();
      const real = w.plotReady.promo.publicRedirectCode;
      // 大小写翻转的变体：站内码恰好全是数字（随机码偶尔会）时翻转后与原码相同，那就不是"不同的站内码"，不能当反例
      const swappedCase = [...real].map((char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase())).join("");
      const probes: Array<string | null> = ["nope", "", null, "%", "_", `${real}%`, `%${real.slice(1)}`, ` ${real}`, `${real} `, `${real}\n`];
      if (swappedCase !== real) probes.push(swappedCase);
      for (const probe of probes) {
        expect(await codeFor(web, probe), JSON.stringify(probe)).toBeNull();
      }
      expect(await codeFor(web, real)).toBe("960031");
    });

    it("规则与 JS isPromoReady 的口令码分支逐项一致（配置 × 语种 × 口令码 × 状态 矩阵：函数返回非 NULL ⟺ 口令码模式剧场下 isPromoReady）", async () => {
      const locales = ["en", "fr", "zh-Hant"];
      const novels = new Map<string, { novelId: string; sourceId: string }>();
      for (const locale of locales) {
        const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: `matrix-${locale}`, title: `Matrix ${locale}`, locale, agencyId: PLOT_AGENCY });
        novels.set(locale, { novelId: novel!.id, sourceId: source.id });
      }
      const codes: Array<string | null> = [null, "", " ", "960031", "　", " 1 ", "᠎"]; // U+180E 不在 JS trim 集合里 → 非空
      const statuses = ["fetched", "pending", "failed"];
      const rows: Array<{ locale: string; code: string | null; status: string; publicRedirectCode: string }> = [];
      for (const locale of locales) {
        for (const status of statuses) {
          for (const [index, code] of codes.entries()) {
            const promo = await seedPromo({
              appId: ids.plotApp, novelId: novels.get(locale)!.novelId, sourceId: novels.get(locale)!.sourceId,
              status, upstreamCode: code, offerType: `${status}-${index}`,
            });
            rows.push({ locale, code, status, publicRedirectCode: promo.publicRedirectCode });
          }
        }
      }
      const configs: unknown[] = [
        PLOT_CONFIG,
        { promoMode: "code", codeModeLocales: ["en", "fr"] },
        { promoMode: "code", codeModeLocales: [""] },
        { promoMode: "code", codeModeLocales: ["", "en"] },
        { promoMode: "code", codeModeLocales: [" en"] },
        { promoMode: "code", codeModeLocales: ["EN"] },
        { promoMode: "code", codeModeLocales: [null, 5, "fr"] },
        { promoMode: "code", codeModeLocales: "en" },
        { promoMode: "code" },
        { promoMode: "link", codeModeLocales: ["en"] },
      ];
      let returned = 0;
      let withheld = 0;
      for (const config of configs) {
        await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: config as never } });
        for (const row of rows) {
          const fromDb = await codeFor(web, row.publicRedirectCode);
          const jsReady = (config as { promoMode?: unknown }).promoMode === "code" && isPromoReady({
            status: row.status, webUrl: null, appUrl: null, upstreamCode: row.code, channelApp: { config }, novel: { locale: row.locale },
          });
          const label = `${JSON.stringify(config)} locale=${row.locale} status=${row.status} code=${JSON.stringify(row.code)}`;
          expect(fromDb !== null, label).toBe(jsReady);
          if (fromDb !== null) {
            expect(fromDb, label).toBe(row.code);
            returned += 1;
          } else {
            withheld += 1;
          }
        }
      }
      // 返回的组合：en 白名单 3 个非空口令码，en+fr 6 个，["", "en"] 3 个，[null, 5, "fr"] 3 个 = 15；其余全部必须是 NULL
      expect(returned).toBe(15);
      expect(withheld).toBeGreaterThan(100);
    }, 120_000);
  });

  describe("函数的形状与授权", () => {
    it("属主 migration_owner、SECURITY DEFINER、固定 search_path、标量 text → text、STABLE；不是集合返回函数", async () => {
      const [fn] = await owner.$queryRaw<Array<{
        owner: string; secdef: boolean; retset: boolean; rettype: string; args: string; volatility: string; config: string[] | null; kind: string;
      }>>`
        SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proretset AS retset,
               format_type(p.prorettype, NULL) AS rettype, pg_get_function_identity_arguments(p.oid) AS args,
               p.provolatile::text AS volatility, p.proconfig AS config, p.prokind::text AS kind
        FROM pg_proc p WHERE p.oid = 'public.code_mode_upstream_code(text)'::regprocedure`;
      expect(fn).toMatchObject({
        owner: "migration_owner", secdef: true, retset: false, rettype: "text", args: "p_public_redirect_code text", volatility: "s", kind: "f",
      });
      expect(fn!.config).toEqual(["search_path=pg_catalog, public"]);
    });

    it("EXECUTE 只有 web_app：worker_app / scheduler_app / analyst_ro / backup_role / PUBLIC 都没有，调用被拒", async () => {
      const [grants] = await owner.$queryRaw<Array<Record<string, boolean>>>`
        SELECT has_function_privilege('web_app', 'public.code_mode_upstream_code(text)', 'EXECUTE') AS web_app,
               has_function_privilege('worker_app', 'public.code_mode_upstream_code(text)', 'EXECUTE') AS worker_app,
               has_function_privilege('scheduler_app', 'public.code_mode_upstream_code(text)', 'EXECUTE') AS scheduler_app,
               has_function_privilege('analyst_ro', 'public.code_mode_upstream_code(text)', 'EXECUTE') AS analyst_ro,
               has_function_privilege('backup_role', 'public.code_mode_upstream_code(text)', 'EXECUTE') AS backup_role`;
      expect(grants).toEqual({ web_app: true, worker_app: false, scheduler_app: false, analyst_ro: false, backup_role: false });
      const [acl] = await owner.$queryRaw<Array<{ acl: string }>>`
        SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.code_mode_upstream_code(text)'::regprocedure`;
      expect(acl!.acl).not.toMatch(/(^|[{,])=X/); // 没有授给 PUBLIC（grantee 为空）
      expect(acl!.acl).toContain("web_app=X/migration_owner");
      for (const role of [worker, scheduler, analyst]) {
        expect(await permissionDenied(() => role.$queryRaw`SELECT public.code_mode_upstream_code('x')`)).toBe(true);
      }
      expect(await permissionDenied(() => web.$queryRaw`SELECT public.code_mode_upstream_code('x')`)).toBe(false);
    });

    it("授权在 grants.sql 重放（运行器已重放两次）后仍然成立：web_app 的列授权恰好是约定的集合——没有 upstream_code，有 upstream_code_present", async () => {
      const columns = await owner.$queryRaw<Array<{ name: string }>>`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid = 'public.promo_link'::regclass AND attnum > 0 AND NOT attisdropped
          AND has_column_privilege('web_app', attrelid, attnum, 'SELECT') ORDER BY attname`;
      const names = columns.map((row) => row.name);
      expect(names).not.toContain("upstream_code");
      expect(names).not.toContain("raw_links");
      expect(names).toContain("upstream_code_present");
      expect(names).toEqual(expect.arrayContaining(["web_url", "app_url", "status", "channel_app_id", "novel_id", "public_redirect_code", "deleted_at"]));
      for (const role of ["analyst_ro", "scheduler_app"]) {
        const [row] = await owner.$queryRawUnsafe<Array<{ code: boolean; present: boolean }>>(
          `SELECT has_column_privilege('${role}', 'public.promo_link', 'upstream_code', 'SELECT') AS code,
                  has_column_privilege('${role}', 'public.promo_link', 'upstream_code_present', 'SELECT') AS present`);
        expect(row, role).toEqual({ code: false, present: false });
      }
      const [worker_] = await owner.$queryRaw<Array<{ code: boolean; present: boolean }>>`
        SELECT has_column_privilege('worker_app', 'public.promo_link', 'upstream_code', 'SELECT') AS code,
               has_column_privilege('worker_app', 'public.promo_link', 'upstream_code_present', 'SELECT') AS present`;
      expect(worker_).toEqual({ code: true, present: true });
    });

    it("会话里改 search_path 绕不开函数：函数自带固定 search_path，用的仍是 public 里的真表", async () => {
      const real = await seedPublished({ appId: ids.plotApp, externalBookId: "p", title: "P", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      // 在另一个 schema 里放一份同名同结构、但数据不同的表（owner 建）——如果函数没固定 search_path，就会被带偏
      await owner.$executeRawUnsafe("DROP SCHEMA IF EXISTS evil CASCADE");
      await owner.$executeRawUnsafe("CREATE SCHEMA evil");
      await owner.$executeRawUnsafe("CREATE TABLE evil.promo_link AS SELECT * FROM public.promo_link WHERE false");
      await owner.$executeRawUnsafe("GRANT USAGE ON SCHEMA evil TO web_app");
      await owner.$executeRawUnsafe("GRANT SELECT ON evil.promo_link TO web_app");
      try {
        const rows = await web.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL search_path = evil, public");
          return tx.$queryRaw<Array<{ code: string | null }>>`SELECT public.code_mode_upstream_code(${real.promo.publicRedirectCode}) AS code`;
        });
        expect(rows[0]?.code).toBe("960031");
      } finally {
        await owner.$executeRawUnsafe("DROP SCHEMA IF EXISTS evil CASCADE");
      }
    });
  });

  describe("运维手册步骤 0 的发版读回 SQL（照手册原文执行，期望值就是手册写的）", () => {
    it("迁移数 / 列授权 / 函数形状与授权 / 触发器 / 回填一致，逐条与手册写的期望值相符", async () => {
      const runbook = readFileSync(path.resolve(import.meta.dirname, "../../../docs/operations/PLOTNOVEL_THEATER_OPENING_2026-10-14.md"), "utf8");
      const section = runbook.slice(runbook.indexOf("## 步骤 0"), runbook.indexOf("## 步骤 1"));
      const block = section.match(/```sql\n([\s\S]*?)```/)?.[1];
      expect(block).toBeTruthy();
      const statements = block!.split(/;\s*\n/).map((chunk) => chunk.trim()).filter((chunk) => /^(--[^\n]*\n\s*)*(SELECT|WITH)/i.test(chunk));
      expect(statements).toHaveLength(6); // 0) 迁移数 1) 列授权 2) 函数 3) 触发器 4) 回填一致 5) 基线

      // 手册里的 SQL 以 `owner` 身份执行；这些读回都不返回口令码
      const [migrations] = await owner.$queryRawUnsafe<Array<{ applied: bigint; latest: string }>>(statements[0]!);
      const migrationDirs = readdirSync(path.resolve(import.meta.dirname, "../../../prisma/migrations"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
      expect(Number(migrations!.applied)).toBe(migrationDirs.length);
      expect(migrations!.latest).toBe("20261014120000_code_mode_upstream_code_guard");

      const [columns] = await owner.$queryRawUnsafe<Array<Record<string, boolean>>>(statements[1]!);
      expect(columns).toEqual({
        web_reads_code: false, scheduler_reads_code: false, analyst_reads_code: false,
        web_reads_present: true, scheduler_reads_present: false, analyst_reads_present: false,
        scheduler_reads_theater_config: true, scheduler_reads_promo_app: true,
      });

      const [fn] = await owner.$queryRawUnsafe<Array<{
        owner: string; security_definer: boolean; config: string[]; web_exec: boolean; worker_exec: boolean; scheduler_exec: boolean;
        analyst_exec: boolean; backup_exec: boolean; acl: string;
      }>>(statements[2]!);
      expect(fn).toMatchObject({
        owner: "migration_owner", security_definer: true, config: ["search_path=pg_catalog, public"],
        web_exec: true, worker_exec: false, scheduler_exec: false, analyst_exec: false, backup_exec: false,
      });
      expect(fn!.acl).not.toMatch(/(^|[{,])=X/);

      expect(await owner.$queryRawUnsafe(statements[3]!)).toEqual([{ tgenabled: "O" }]);

      // 回填一致：先造一点有口令码 / 空白口令码（含只有制表符、NBSP 这类 btrim 默认不去的字符）/ 没口令码的行，读回的三个计数必须是 0
      const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: "readback", title: "Readback", agencyId: PLOT_AGENCY });
      const codes: Array<string | null> = ["960031", "  ", null, " x ", "\t", "\u00a0", "\u3000\ufeff\u2028", "\u180e"];
      for (const [index, code] of codes.entries()) {
        await seedPromo({ appId: ids.plotApp, novelId: novel!.id, sourceId: source.id, upstreamCode: code, offerType: `rb-${index}` });
      }
      const [consistency] = await owner.$queryRawUnsafe<Array<{ nonblank_but_flag_false: bigint; blank_but_flag_true: bigint; null_but_flag_true: bigint }>>(statements[4]!);
      expect(Number(consistency!.nonblank_but_flag_false)).toBe(0);
      expect(Number(consistency!.blank_but_flag_true)).toBe(0);
      expect(Number(consistency!.null_but_flag_true)).toBe(0);
      // 证明手册里用 25 字符集不是多余：如果写成默认 btrim(upstream_code)，只含制表符 / NBSP / U+3000 U+FEFF U+2028 的口令码会被误报成"非空但标记为 false"
      const [naive] = await owner.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM promo_link WHERE upstream_code IS NOT NULL AND btrim(upstream_code) <> '' AND NOT upstream_code_present`;
      expect(Number(naive!.n)).toBe(3); // "\t"、NBSP、"\u3000\ufeff\u2028"
      // 反过来：U+180E 不在 JS trim 集合里 → 非空 → 标记为 true（触发器与 JS 一致）
      const [mongolian] = await owner.$queryRaw<Array<{ upstream_code_present: boolean }>>`
        SELECT upstream_code_present FROM promo_link WHERE upstream_code = ${"\u180e"}`;
      expect(mongolian!.upstream_code_present).toBe(true);

      // 基线 SQL 能跑：刚才造的那本机构 1351 的书挂在 plotnovel 名下，1 本书目、codes.length 条推广链接
      const baseline = await owner.$queryRawUnsafe<Array<{ theater: string; items: bigint; promo_links: bigint }>>(statements[5]!);
      expect(baseline.map((row) => ({ theater: row.theater, items: Number(row.items), promo_links: Number(row.promo_links) }))).toEqual([
        { theater: "plotnovel", items: 1, promo_links: codes.length },
      ]);
    });
  });

  describe("触发器维护的布尔列 upstream_code_present：写入方改不了它", () => {
    async function presentOf(promoId: string): Promise<boolean> {
      const [row] = await owner.$queryRaw<Array<{ upstream_code_present: boolean }>>`SELECT upstream_code_present FROM promo_link WHERE id = ${promoId}::uuid`;
      return row!.upstream_code_present;
    }

    it("插入 / 更新时按 upstream_code 重算，与 JS 的非空判断一致（含 25 个 trim 字符与不在集合里的 U+180E）", async () => {
      const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: "trg", title: "Trigger", agencyId: PLOT_AGENCY });
      const cases: Array<[string | null, boolean]> = [
        [null, false], ["", false], [" ", false], ["\t\n\v\f\r", false], ["        　﻿", false],
        ["960031", true], [" 960031 ", true], ["᠎", true], ["x", true],
      ];
      for (const [index, [code, expected]] of cases.entries()) {
        const promo = await seedPromo({ appId: ids.plotApp, novelId: novel!.id, sourceId: source.id, upstreamCode: code, offerType: `t-${index}` });
        expect(await presentOf(promo.id), JSON.stringify(code)).toBe(expected);
        expect(expected, JSON.stringify(code)).toBe(code !== null && code.trim().length > 0);
      }
    });

    it("写入方想伪造也没用：插入时给 true 但没有口令码仍是 false；更新别的列不能翻它；直接 SET 它会被触发器改回；改口令码才会翻", async () => {
      const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: "forge", title: "Forge", agencyId: PLOT_AGENCY });
      const blank = await seedPromo({ appId: ids.plotApp, novelId: novel!.id, sourceId: source.id, upstreamCode: null, offerType: "forge-blank" });
      expect(await presentOf(blank.id)).toBe(false);
      // worker_app（有整表 UPDATE）想把它直接改成 true
      await worker.$executeRaw`UPDATE promo_link SET upstream_code_present = true WHERE id = ${blank.id}::uuid`;
      expect(await presentOf(blank.id)).toBe(false);
      // 插入时显式给 true
      await worker.$executeRaw`
        INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type, origin, upstream_code,
          public_redirect_code, idempotency_key, status, upstream_code_present, updated_at)
        VALUES (gen_random_uuid(), ${novel!.id}::uuid, ${source.id}::uuid, ${ids.plotApp}::uuid, ${ids.account}::uuid, 'forged', 'claimed', NULL,
          'forgedcode1', ${"f".repeat(64)}, 'pending', true, now())`;
      const [forged] = await owner.$queryRaw<Array<{ upstream_code_present: boolean }>>`SELECT upstream_code_present FROM promo_link WHERE public_redirect_code = 'forgedcode1'`;
      expect(forged!.upstream_code_present).toBe(false);
      // 更新别的列不影响；改口令码才翻
      await worker.$executeRaw`UPDATE promo_link SET status = 'fetched' WHERE id = ${blank.id}::uuid`;
      expect(await presentOf(blank.id)).toBe(false);
      await worker.$executeRaw`UPDATE promo_link SET upstream_code = '960031' WHERE id = ${blank.id}::uuid`;
      expect(await presentOf(blank.id)).toBe(true);
      await worker.$executeRaw`UPDATE promo_link SET upstream_code = '  ' WHERE id = ${blank.id}::uuid`;
      expect(await presentOf(blank.id)).toBe(false);
    });

    it("web_app 没有 promo_link 的写权限，更改不了这一列", async () => {
      const { novel, source } = await seedBook({ appId: ids.plotApp, externalBookId: "webw", title: "Web write", agencyId: PLOT_AGENCY });
      const promo = await seedPromo({ appId: ids.plotApp, novelId: novel!.id, sourceId: source.id, upstreamCode: "960031" });
      expect(await permissionDenied(() => web.$executeRaw`UPDATE promo_link SET upstream_code_present = false WHERE id = ${promo.id}::uuid`)).toBe(true);
      expect(await presentOf(promo.id)).toBe(true);
    });
  });

  describe("worker_app / scheduler_app 的行为不变", () => {
    it("worker_app 照旧整表读写口令码（目录同步 / 领取 / 站点地图都靠它）；scheduler_app 仍只有约定的那几列", async () => {
      const w = await seedPublished({ appId: ids.plotApp, externalBookId: "w", title: "W", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      const [read] = await worker.$queryRaw<Array<{ upstream_code: string | null; raw_links: unknown }>>`SELECT upstream_code, raw_links FROM promo_link WHERE id = ${w.promo.id}::uuid`;
      expect(read?.upstream_code).toBe("960031");
      await worker.$executeRaw`UPDATE promo_link SET upstream_code = '960099' WHERE id = ${w.promo.id}::uuid`;
      expect(await codeFor(web, w.promo.publicRedirectCode)).toBe("960099"); // 函数读到的是最新值
      // scheduler_app：仍能读剧场 id/config 与 promo_link 的约定列（queryActiveLocales），读不到别的
      expect(await permissionDenied(() => scheduler.$queryRaw`SELECT id, novel_id, status, deleted_at, web_url, app_url, channel_app_id FROM promo_link LIMIT 1`)).toBe(false);
      expect(await permissionDenied(() => scheduler.$queryRaw`SELECT id, config FROM channel_app LIMIT 1`)).toBe(false);
      expect(await permissionDenied(() => scheduler.$queryRaw`SELECT upstream_code FROM promo_link LIMIT 1`)).toBe(true);
      expect(await permissionDenied(() => scheduler.$queryRaw`SELECT upstream_code_present FROM promo_link LIMIT 1`)).toBe(true);
    });
  });

  describe("中间页取数端到端（loadCodeModePageData，真实 web_app）", () => {
    it("就绪的口令码模式推广 → 经函数取到口令码、App 名、商店链接、书名；其余一律 null（页面 404）", async () => {
      const ready = await seedPublished({ appId: ids.plotApp, externalBookId: "e2e-ready", title: "E2E Ready", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      const moboCodeOnly = await seedPublished({ appId: ids.moboApp, externalBookId: "e2e-mobo", title: "E2E Mobo", agencyId: MOBO_AGENCY, promo: { upstreamCode: "ABC123" } });
      const blank = await seedPublished({ appId: ids.plotApp, externalBookId: "e2e-blank", title: "E2E Blank", agencyId: PLOT_AGENCY, promo: { upstreamCode: "  " } });
      const pending = await seedPublished({ appId: ids.plotApp, externalBookId: "e2e-pending", title: "E2E Pending", agencyId: PLOT_AGENCY, promo: { status: "pending", upstreamCode: "960033" } });
      const french = await seedPublished({ appId: ids.plotApp, externalBookId: "e2e-fr", title: "E2E French", locale: "fr", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960032" } });

      const page = await loadCodeModePageData(web, ready.promo.publicRedirectCode);
      expect(page).toMatchObject({
        code: "960031", appName: "PlotNovel", title: "E2E Ready",
        appStoreUrl: "https://apps.apple.com/app/plotnovel/id123", googlePlayUrl: "https://play.google.com/store/apps/details?id=com.plotnovel",
      });
      expect(page?.backHref).toMatch(/^\/novel\//);
      for (const other of [moboCodeOnly, blank, pending, french]) {
        expect(await loadCodeModePageData(web, other.promo.publicRedirectCode), other.promo.publicRedirectCode).toBeNull();
      }
      expect(await loadCodeModePageData(web, "does-not-exist")).toBeNull();
    });

    it("数据库层不放行时页面也不放行：JS 侧看起来就绪、但函数返回 NULL（例如剧场语种白名单在读取之间被收紧）→ null", async () => {
      const ready = await seedPublished({ appId: ids.plotApp, externalBookId: "race", title: "Race", agencyId: PLOT_AGENCY, promo: { upstreamCode: "960031" } });
      // 用一个"先读剧场配置、后收紧白名单"的 web 代理复现竞态：findUnique 之后、函数调用之前把白名单清空
      const racing = new Proxy(web, {
        get(target, prop, receiver) {
          if (prop === "$queryRaw") {
            return async (...args: unknown[]) => {
              await owner.channelApp.update({ where: { id: ids.plotApp }, data: { config: { ...PLOT_CONFIG, codeModeLocales: [] } } });
              return (target.$queryRaw as (...a: unknown[]) => Promise<unknown>)(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof web;
      expect(await loadCodeModePageData(racing, ready.promo.publicRedirectCode)).toBeNull();
    });
  });
});
