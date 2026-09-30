/**
 * 模板 SEO 字段回写工具（`src/server/article-templates/tkd-repair.ts`）的真实 PostgreSQL 验证
 * （TKD 对齐 CPS，Owner 2026-09-30，施工工单第五块："测试必须在真实库上跑，不能只 mock"）。
 *
 * 默认关闭。只在一次性数据库上用 `scripts/run-tkd-repair-postgres-verification.sh` 打开：
 *   TKD_REPAIR_DATABASE_TEST=1
 *   TKD_REPAIR_OWNER_DATABASE_URL   —— migration_owner，只造夹具与读回核对
 *   TKD_REPAIR_WORKER_DATABASE_URL  —— worker_app，工具真正运行的角色（有 article UPDATE / operation_audit INSERT）
 *   TKD_REPAIR_WEB_DATABASE_URL     —— web_app，前台应用角色：只用来证明工具拒绝它写库
 * 库名必须以 `cps_novel_tkd_repair_` 开头，否则整组用例拒绝运行（绝不碰共享库/预生产/生产）。
 *
 * 覆盖的行为（每条都读回数据库核对，不是看返回值）：
 *  - 按模板取关联文章，只取未删除的；`contentMode = manual` 自动跳过；别的模板的文章不在范围；
 *  - 只写 `seoMetadata` 的 metaTitle/metaDescription 两个键，`coverUrl`/`metaKeywords` 等其它键原样保留，
 *    `title`/`body`/`slug`/`contentMode`/`templateId` 一个字节不动；
 *  - 预期篇数不符就停（不写备份、不动库、不写审计）；单批上限；缺执行清单/游标/操作人就停；
 *  - 备份文件内容（写库前落盘、含每篇 before/after 与完整 seoMetadata 快照）与独占创建；
 *  - 每批一条 OperationAudit；CAS：读-写之间被改过的文章让整批回滚；
 *  - 排除清单必须签字、逐条校验未过期，未签字的清单让执行清单无法生成；
 *  - 执行清单漂移守卫（模板中途被改就停）；续跑游标；
 *  - 回滚只在当前值仍等于回写后的值时才做，其它键同样不动；
 *  - 渲染失败（`{novel_description}` 为空）是 blocker，不是静默跳过；
 *  - 拒绝前台应用角色 `web_app` 写库；
 *  - 15 个默认模板"原地更新"：生产形态的 15 行（旧裸变量标题）经引导脚本 dry-run 差异恰好是
 *    15 行的 seoTemplate.metaTitle，apply 后模板行数仍是 15、version 仍是 1。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loadArticleTemplateBootstrapArtifacts,
  runArticleTemplateBootstrapCli,
  type ArticleTemplateBootstrapDb,
} from "../../../scripts/l10n/article-template-bootstrap";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import {
  TEMPLATE_TKD_APPLY_AUDIT_ACTION,
  TEMPLATE_TKD_RESTORE_AUDIT_ACTION,
  applyTemplateTkdBatch,
  assertTemplateTkdDbRole,
  buildTemplateTkdExclusionFile,
  buildTemplateTkdRepairPlan,
  generateTemplateTkdExclusionFile,
  generateTemplateTkdExecutionManifest,
  loadTemplateForTkdRepair,
  loadTemplateTkdDbRole,
  parseTemplateTkdBackup,
  parseTemplateTkdCursor,
  runTemplateTkdRepair,
  runTemplateTkdRestore,
  type TemplateTkdDb,
  type TemplateTkdRepairOptions,
  type TemplateTkdRepairSummary,
} from "@/server/article-templates/tkd-repair";

const enabled = process.env.TKD_REPAIR_DATABASE_TEST === "1";

function requiredUrl(name: "TKD_REPAIR_OWNER_DATABASE_URL" | "TKD_REPAIR_WORKER_DATABASE_URL" | "TKD_REPAIR_WEB_DATABASE_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; refusing DATABASE_URL fallback`);
  return value;
}

const owner = enabled ? new PrismaClient({ datasourceUrl: requiredUrl("TKD_REPAIR_OWNER_DATABASE_URL") }) : null;
const worker = enabled ? new PrismaClient({ datasourceUrl: requiredUrl("TKD_REPAIR_WORKER_DATABASE_URL") }) : null;
const web = enabled ? new PrismaClient({ datasourceUrl: requiredUrl("TKD_REPAIR_WEB_DATABASE_URL") }) : null;

const workerDb = worker as unknown as TemplateTkdDb;
const webDb = web as unknown as TemplateTkdDb;

const DE_TEMPLATE_KEY = "system-default-de-v1";
const FR_TEMPLATE_KEY = "system-default-fr-v1";
const OLD_SEO_TEMPLATE = { title: "{novel_title}", metaTitle: "{novel_title}", metaDescription: "{novel_description}" };
const NEW_DE_TITLE_SUFFIX = " Roman - Kostenlose Kapitel online lesen";

type Fixture = {
  id: string;
  novelId: string;
  title: string;
  description: string;
};

describe.skipIf(!enabled).sequential("TKD 回写工具（真实 PostgreSQL，worker_app 角色运行）", () => {
  let dir: string;
  const tag = String(Date.now());
  let deTemplateId: string;
  let frTemplateId: string;
  let promoLinkId: string;

  // 夹具文章（全部挂在 de 默认模板下，除非另有说明）
  const fx = {
    /** 模板模式、旧标题、带 coverUrl/metaKeywords 两个必须保留的键。 */
    a1: null as unknown as Fixture,
    /** 模板模式、seoMetadata 为空对象（两个键都不存在）。 */
    a2: null as unknown as Fixture,
    /** 运营手改过（manual），SEO 标题是手写的——必须自动跳过。 */
    a3: null as unknown as Fixture,
    /** 已软删除——不在范围。 */
    a4: null as unknown as Fixture,
    /** 已经是新标题——不变。 */
    a5: null as unknown as Fixture,
    /** 语种是 fr 却挂在 de 模板上——blocker，除非签字排除。 */
    a6: null as unknown as Fixture,
    /** 挂在 fr 模板下——不在 de 的范围。 */
    a7: null as unknown as Fixture,
    /** 简介为空白 -> `{novel_description}` 渲染为空 -> 渲染失败 blocker。 */
    a8: null as unknown as Fixture,
  };

  async function seedNovel(label: string, description = `Beschreibung von ${label}.`): Promise<{ novelId: string; title: string; description: string }> {
    const novelId = randomUUID();
    const title = `Roman ${label}`;
    await owner!.novel.create({
      data: {
        id: novelId,
        businessId: `biz-${label}-${tag}`,
        title,
        description,
        locale: "en",
        slug: `roman-${label}-${tag}`,
        totalChapterCount: 12,
        status: "published",
      },
    });
    return { novelId, title, description };
  }

  async function seedArticle(input: {
    label: string;
    templateId: string | null;
    locale?: string;
    contentMode?: "template" | "manual";
    seoMetadata: Record<string, unknown>;
    status?: "draft" | "published";
    deletedAt?: Date | null;
    description?: string;
    withPromo?: boolean;
  }): Promise<Fixture> {
    const novel = await seedNovel(input.label, input.description);
    const id = randomUUID();
    await owner!.article.create({
      data: {
        id,
        novelId: novel.novelId,
        locale: input.locale ?? "de",
        slug: `roman-${input.label}-${tag}`,
        publicPageShortId: `${input.label}${tag}`.slice(0, 32).padEnd(12, "0"),
        title: novel.title,
        body: `<article><h1>${novel.title}</h1></article>`,
        seoMetadata: input.seoMetadata as Prisma.InputJsonValue,
        seoSchemaVersion: 2,
        status: input.status ?? "draft",
        contentMode: input.contentMode ?? "template",
        templateId: input.templateId,
        deletedAt: input.deletedAt ?? null,
        ...(input.withPromo ? { promoLinkId: promoLinkId, publishedAt: new Date() } : {}),
      },
    });
    return { id, novelId: novel.novelId, title: novel.title, description: novel.description };
  }

  async function articleRow(id: string) {
    return owner!.article.findUniqueOrThrow({ where: { id } });
  }

  async function auditRows(action: string) {
    return owner!.operationAudit.findMany({ where: { action }, orderBy: { id: "asc" } });
  }

  const baseOptions = (overrides: Partial<TemplateTkdRepairOptions> = {}): TemplateTkdRepairOptions => ({
    templateKey: DE_TEMPLATE_KEY,
    templateVersion: 1,
    scope: { allLinked: true },
    apply: false,
    ...overrides,
  });

  async function dryRun(overrides: Partial<TemplateTkdRepairOptions> = {}) {
    let captured: TemplateTkdRepairSummary | null = null;
    let error: Error | null = null;
    try {
      await runTemplateTkdRepair(workerDb, baseOptions(overrides), (summary) => {
        captured = summary;
      });
    } catch (caught) {
      error = caught as Error;
    }
    return { summary: captured as TemplateTkdRepairSummary | null, error };
  }

  beforeAll(async () => {
    if (!owner || !worker || !web) throw new Error("role clients were not created");
    for (const client of [owner, worker, web]) {
      const [row] = await client.$queryRaw<Array<{ db: string; version: string }>>`SELECT current_database() AS db, current_setting('server_version') AS version`;
      if (!row!.db.startsWith("cps_novel_tkd_repair_")) throw new Error(`refusing to run against database "${row!.db}" (name must start with cps_novel_tkd_repair_)`);
      if (!row!.version.startsWith("16.")) throw new Error(`PostgreSQL 16 required, got ${row!.version}`);
    }
    dir = await mkdtemp(path.join(tmpdir(), "tkd-repair-pg-"));

    // 生产形态：15 个默认模板，SEO 标题还是旧的裸变量 {novel_title}（本轮之前引导出来的样子）。
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    for (const locale of SITE_LOCALES) {
      const asset = artifacts.assetsByLocale.get(locale)!;
      const created = await owner.articleTemplate.create({
        data: {
          templateKey: asset.templateKey,
          templateName: asset.templateName,
          locale: asset.locale,
          version: asset.version,
          schemaVersion: asset.schemaVersion,
          status: asset.status,
          applicableArticleType: asset.applicableArticleType,
          bodyTemplate: asset.bodyTemplate,
          contentTemplate: asset.contentTemplate as unknown as Prisma.InputJsonValue,
          seoTemplate: OLD_SEO_TEMPLATE,
          slugTemplate: asset.slugTemplate,
          metaKeywordsTemplate: asset.metaKeywordsTemplate,
        },
      });
      if (asset.templateKey === DE_TEMPLATE_KEY) deTemplateId = created.id;
      if (asset.templateKey === FR_TEMPLATE_KEY) frTemplateId = created.id;
    }
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    await Promise.all([owner?.$disconnect(), worker?.$disconnect(), web?.$disconnect()]);
  });

  it("15 个默认模板原地更新：生产形态的 15 行经引导脚本预演，差异恰好是 15 行的 seoTemplate.metaTitle；apply 后仍 15 行、version 仍是 1（真实 jsonb 比较）", async () => {
    const artifacts = loadArticleTemplateBootstrapArtifacts();
    const admin = await owner!.adminIdentity.create({ data: { username: `tkd-approver-${tag}`, passwordHash: "scrypt$v1$fixture-only-not-a-real-hash", role: "super_admin" } });
    const bootstrapDb = owner as unknown as ArticleTemplateBootstrapDb;
    const plan = await runArticleTemplateBootstrapCli(bootstrapDb, { apply: false, approver: null }, artifacts);
    expect(plan.planned).toEqual({ create: 0, update: 15, unchanged: 0, softDeleted: 0 });
    expect(plan.changes).toHaveLength(15);
    for (const change of plan.changes) {
      expect(change.category).toBe("update");
      expect(change.changedFields, change.templateKey).toEqual(["seoTemplate.metaTitle"]);
    }
    expect(await owner!.articleTemplate.count()).toBe(15);

    const applied = await runArticleTemplateBootstrapCli(bootstrapDb, { apply: true, approver: admin.username }, artifacts);
    expect(applied.applied).toEqual({ created: 0, updated: 15, unchanged: 0, softDeleted: 0 });
    expect(await owner!.articleTemplate.count()).toBe(15);
    const rows = await owner!.articleTemplate.findMany();
    for (const row of rows) {
      expect(row.version).toBe(1);
      expect((row.seoTemplate as { metaTitle: string }).metaTitle).toBe(artifacts.assetsByLocale.get(row.locale as (typeof SITE_LOCALES)[number])!.seoTemplate.metaTitle);
    }
    const again = await runArticleTemplateBootstrapCli(bootstrapDb, { apply: false, approver: null }, artifacts);
    expect(again.planned).toEqual({ create: 0, update: 0, unchanged: 15, softDeleted: 0 });
  });

  it("夹具：de 模板下 8 类文章 + fr 模板下 1 篇", async () => {
    // 一条已发布文章需要推广链接（`article_published_promo_link_check`），顺带让预演走一遍 promoLink 关联。
    const channelId = randomUUID();
    const sourceAppId = randomUUID();
    const channelAppId = randomUUID();
    const channelAccountId = randomUUID();
    await owner!.$executeRawUnsafe(`INSERT INTO channel (id, code, name, created_at, updated_at) VALUES ($1::uuid,$2,'TKD Channel',NOW(),NOW())`, channelId, `tkd${tag}`);
    await owner!.$executeRawUnsafe(`INSERT INTO source_app (id, code, name, created_at, updated_at) VALUES ($1::uuid,$2,'TKD App',NOW(),NOW())`, sourceAppId, `tkdapp${tag}`);
    await owner!.$executeRawUnsafe(
      `INSERT INTO channel_app (id, channel_id, source_app_id, external_app_id, project_type, created_at, updated_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,2,NOW(),NOW())`,
      channelAppId, channelId, sourceAppId, `tkdext${tag}`,
    );
    await owner!.$executeRawUnsafe(
      `INSERT INTO channel_account (id, channel_id, business_id, account_name, created_at, updated_at) VALUES ($1::uuid,$2::uuid,$3,'TKD Account',NOW(),NOW())`,
      channelAccountId, channelId, `tkdacct${tag}`,
    );

    // a1 先建（要拿它的小说挂推广链接并置为已发布）。
    fx.a1 = await seedArticle({
      label: "a1",
      templateId: deTemplateId,
      seoMetadata: { metaTitle: "Roman a1", metaDescription: "alte Beschreibung", coverUrl: "https://cdn.example.test/a1.jpg", metaKeywords: "fantasy, reise" },
    });
    const itemId = randomUUID();
    promoLinkId = randomUUID();
    await owner!.$executeRawUnsafe(
      `INSERT INTO novel_source_item (id, channel_app_id, external_book_id, source_language_code, title, description, raw_payload, novel_id, status, created_at, updated_at)
       VALUES ($1::uuid,$2::uuid,$3,'3','Roman a1','d','{}'::jsonb,$4::uuid,'linked',NOW(),NOW())`,
      itemId, channelAppId, `tkdext-a1-${tag}`, fx.a1.novelId,
    );
    await owner!.$executeRawUnsafe(
      `INSERT INTO promo_link (id, novel_id, novel_source_item_id, channel_app_id, channel_account_id, offer_type, public_redirect_code, idempotency_key, status, web_url, created_at, updated_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'default',$6,$7,'fetched',$8,NOW(),NOW())`,
      promoLinkId, fx.a1.novelId, itemId, channelAppId, channelAccountId, `tk${tag.slice(-8).padStart(8, "0")}`, `tkd-${tag}`.padEnd(36, "0").slice(0, 36), `https://upstream.example.test/tkd`,
    );
    await owner!.article.update({ where: { id: fx.a1.id }, data: { promoLinkId, status: "published", publishedAt: new Date() } });

    fx.a2 = await seedArticle({ label: "a2", templateId: deTemplateId, seoMetadata: {} });
    fx.a3 = await seedArticle({ label: "a3", templateId: deTemplateId, contentMode: "manual", seoMetadata: { metaTitle: "Handgeschriebener Titel", metaDescription: "Handgeschrieben" } });
    fx.a4 = await seedArticle({ label: "a4", templateId: deTemplateId, deletedAt: new Date(), seoMetadata: { metaTitle: "Roman a4", metaDescription: "gelöscht" } });
    fx.a5 = await seedArticle({
      label: "a5",
      templateId: deTemplateId,
      seoMetadata: { metaTitle: `Roman a5${NEW_DE_TITLE_SUFFIX}`, metaDescription: "Beschreibung von a5.", coverUrl: "https://cdn.example.test/a5.jpg" },
    });
    fx.a6 = await seedArticle({ label: "a6", templateId: deTemplateId, locale: "fr", seoMetadata: { metaTitle: "Roman a6", metaDescription: "mismatch" } });
    fx.a7 = await seedArticle({ label: "a7", templateId: frTemplateId, locale: "fr", seoMetadata: { metaTitle: "Roman a7", metaDescription: "andere Vorlage" } });
    fx.a8 = await seedArticle({ label: "a8", templateId: deTemplateId, seoMetadata: { metaTitle: "Roman a8" }, description: "   " });

    expect(await owner!.article.count({ where: { templateId: deTemplateId } })).toBe(7);
  });

  it("角色闸门：worker_app 有 article UPDATE 与 operation_audit INSERT；web_app 也有权限，但工具拒绝用前台应用角色写库", async () => {
    const workerRole = await loadTemplateTkdDbRole(workerDb);
    expect(workerRole).toEqual({ currentUser: "worker_app", canUpdateArticle: true, canInsertAudit: true });
    expect(() => assertTemplateTkdDbRole(workerRole)).not.toThrow();

    const webRole = await loadTemplateTkdDbRole(webDb);
    expect(webRole.currentUser).toBe("web_app");
    expect(() => assertTemplateTkdDbRole(webRole)).toThrow(/front-end application role/);
  });

  it("预演（--all-linked）：只取 de 模板下未删除的关联文章；manual 自动跳过；不写库；语种不符与渲染失败是 blocker", async () => {
    const auditBefore = (await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length;
    const before = await Promise.all(Object.values(fx).map((f) => articleRow(f.id)));
    const { summary, error } = await dryRun();
    expect(error?.message).toMatch(/Repair blocked: 2 blocker/);
    expect(summary).not.toBeNull();
    expect(summary!.mode).toBe("DRY_RUN");
    expect(summary!.template).toMatchObject({ templateKey: DE_TEMPLATE_KEY, locale: "de" });
    expect(summary!.activeFields).toEqual(["metaTitle", "metaDescription"]);
    // de 模板下未删除：a1 a2 a3 a5 a6 a8（a4 已删除、a7 是 fr 模板）
    expect(summary!.targetCount).toBe(6);
    expect(summary!.manualSkippedArticleIds).toEqual([fx.a3.id]);
    expect(summary!.localeMismatchCount).toBe(1);
    expect(summary!.blockers.join("\n")).toContain(`article ${fx.a6.id} locale=fr does not match template locale=de`);
    expect(summary!.blockers.join("\n")).toContain(`article ${fx.a8.id} template render failed: ERR_TEMPLATE_VAR_EMPTY`);
    expect(summary!.changedCount).toBe(2); // a1 a2；a5 已是新标题不变
    expect(summary!.unchangedCount).toBe(1);
    expect(summary!.sampleChanges.map((c) => c.articleId).sort()).toEqual([fx.a1.id, fx.a2.id].sort());
    const a1 = summary!.sampleChanges.find((c) => c.articleId === fx.a1.id)!;
    expect(a1.after).toEqual({ metaTitle: `Roman a1${NEW_DE_TITLE_SUFFIX}`, metaDescription: fx.a1.description });
    // 不写库：所有夹具文章逐列不变，审计行不增加。
    const after = await Promise.all(Object.values(fx).map((f) => articleRow(f.id)));
    expect(after).toEqual(before);
    expect((await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length).toBe(auditBefore);
  });

  it("排除清单：工具生成（未签字）-> 未签字不能用于生成执行清单；签字后哈希钉死，语种不符文章被跳过、manual 列入", async () => {
    const generatedPath = path.join(dir, "exclude-generated.json");
    const { count } = await generateTemplateTkdExclusionFile(workerDb, { templateKey: DE_TEMPLATE_KEY, templateVersion: 1, outPath: generatedPath });
    expect(count).toBe(2);
    const generated = JSON.parse(await readFile(generatedPath, "utf8")) as { entries: Array<{ articleId: string; kind: string; reason: string }> };
    expect(generated.entries.map((e) => [e.articleId, e.kind]).sort()).toEqual([[fx.a3.id, "manual"], [fx.a6.id, "locale_mismatch"]].sort());
    expect(generated.entries.every((e) => e.reason.includes("auto-generated"))).toBe(true);

    // 未签字（reason 还带 auto-generated）：预演直接把它当 blocker。
    const unsigned = await dryRun({ excludeFilePath: generatedPath, scope: { allLinked: true } });
    expect(unsigned.summary!.blockers.join("\n")).toContain("exclusion list not reviewed");

    // 缺少执行清单要求的完整性：不带排除清单时，拒绝生成执行清单。
    await expect(
      generateTemplateTkdExecutionManifest(workerDb, { templateKey: DE_TEMPLATE_KEY, templateVersion: 1, outPath: path.join(dir, "exec-bad.json") }),
    ).rejects.toThrow(/exclusion list incomplete: 2/);

    // 签字：把每条 reason 改成真实理由，重算哈希。
    const signed = buildTemplateTkdExclusionFile({
      templateKey: DE_TEMPLATE_KEY,
      templateVersion: 1,
      entries: generated.entries.map((e) => ({
        articleId: e.articleId,
        kind: e.kind as "manual" | "locale_mismatch",
        locale: e.kind === "manual" ? "de" : "fr",
        reason: e.kind === "manual" ? "运营确认：手改过 SEO 标题，不回写" : "运营确认：串语种的孤儿文章，不回写",
      })),
    });
    await writeFile(path.join(dir, "exclude-signed.json"), JSON.stringify(signed, null, 2));
    const signedRun = await dryRun({ excludeFilePath: path.join(dir, "exclude-signed.json") });
    // 语种不符已被签字排除，只剩 a8 渲染失败这一个 blocker。
    expect(signedRun.summary!.excludedArticleIds).toEqual([fx.a6.id]);
    expect(signedRun.summary!.blockers).toHaveLength(1);
    expect(signedRun.summary!.blockers[0]).toContain("template render failed");

    // 被手改（不重算哈希）的清单被发现。
    const tampered = { ...signed, entries: signed.entries.map((e, i) => (i === 0 ? { ...e, reason: "偷偷改了理由" } : e)) };
    await writeFile(path.join(dir, "exclude-tampered.json"), JSON.stringify(tampered, null, 2));
    const tamperedRun = await dryRun({ excludeFilePath: path.join(dir, "exclude-tampered.json") });
    expect(tamperedRun.summary!.blockers.join("\n")).toContain("exclusion file hash mismatch");
  });

  it("渲染失败是 blocker：a8 的简介为空白，工具报出来而不是静默跳过或写空值", async () => {
    // 先把 a8 修好（补上简介），后面的批量用例才能没有 blocker；这里先证明修之前它确实拦住了。
    const blocked = await dryRun({ excludeFilePath: path.join(dir, "exclude-signed.json") });
    expect(blocked.error?.message).toMatch(/Repair blocked: 1 blocker/);
    await owner!.novel.update({ where: { id: fx.a8.novelId }, data: { description: "Beschreibung von a8." } });
    fx.a8.description = "Beschreibung von a8.";
    const fixed = await dryRun({ excludeFilePath: path.join(dir, "exclude-signed.json") });
    expect(fixed.error).toBeNull();
    expect(fixed.summary!.blockers).toEqual([]);
    expect(fixed.summary!.changedCount).toBe(3); // a1 a2 a8
  });

  let executionManifestPath: string;
  let cursorFilePath: string;
  /** CAS 用例造的三篇（c1 旧标题、c2 被"运营"改成 manual、c3 被别的脚本改了标题），最后一个用例会用到。 */
  const cFixtures = { c1: "", c2: "", c3: "" };

  it("执行清单：冻结模板内容哈希/目标篇数/签字排除集", async () => {
    executionManifestPath = path.join(dir, "exec.json");
    const { manifest } = await generateTemplateTkdExecutionManifest(workerDb, {
      templateKey: DE_TEMPLATE_KEY,
      templateVersion: 1,
      excludeFilePath: path.join(dir, "exclude-signed.json"),
      outPath: executionManifestPath,
    });
    expect(manifest.targetArticleIds.count).toBe(6);
    expect(manifest.excludedArticleIds.count).toBe(2);
    expect(manifest.activeFields).toEqual(["metaTitle", "metaDescription"]);
    expect(manifest.template.templateKey).toBe(DE_TEMPLATE_KEY);
    // 独占创建：不会覆盖已有文件。
    await expect(
      generateTemplateTkdExecutionManifest(workerDb, { templateKey: DE_TEMPLATE_KEY, templateVersion: 1, excludeFilePath: path.join(dir, "exclude-signed.json"), outPath: executionManifestPath }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  const applyOptions = (overrides: Partial<TemplateTkdRepairOptions> = {}): TemplateTkdRepairOptions =>
    baseOptions({
      scope: { allLinked: false, limit: 200 },
      apply: true,
      locale: "de",
      expectedCount: 3,
      backupPath: path.join(dir, "backup-batch1.json"),
      operator: "codex-tkd-1",
      reason: "L2 approved 2026-10-01 (test)",
      executionManifestPath,
      cursorFilePath,
      ...overrides,
    });

  it("执行前的闸门：预期篇数不符 / 缺执行清单 / 缺游标 / 缺操作人 / 前台角色，都停在写备份与写库之前", async () => {
    cursorFilePath = path.join(dir, "cursor-round1.json");
    const before = await Promise.all([fx.a1, fx.a2, fx.a5, fx.a8].map((f) => articleRow(f.id)));
    const auditBefore = (await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length;

    // 闸门直接抛错的一类。
    const attempts: Array<[string, Partial<TemplateTkdRepairOptions>, RegExp]> = [
      ["预期篇数少写", { expectedCount: 2 }, /Expected 2 changed articles, but current dry-run found 3/],
      ["预期篇数多写", { expectedCount: 4 }, /Expected 4 changed articles, but current dry-run found 3/],
      ["缺预期篇数", { expectedCount: undefined }, /--expected-count/],
      ["缺操作人", { operator: undefined }, /--operator/],
      ["缺理由", { reason: " " }, /--reason/],
      ["备份路径是相对路径", { backupPath: "backup.json" }, /--backup=<absolute JSON path>/],
      ["语种与模板不符", { locale: "fr" }, /does not match template locale=de/],
      ["--all-linked 不能 apply", { scope: { allLinked: true } }, /cannot be combined with --apply/],
      ["单批 limit 超过 200", { scope: { allLinked: false, limit: 201 } }, /--limit must be an integer between 1 and 200/],
    ];
    for (const [label, overrides, pattern] of attempts) {
      await expect(runTemplateTkdRepair(workerDb, applyOptions(overrides)), label).rejects.toThrow(pattern);
    }
    // 以 blocker 形式拦住的一类：错误信息是 "Repair blocked"，具体原因在摘要的 blockers[] 里。
    const blockerAttempts: Array<[string, Partial<TemplateTkdRepairOptions>, RegExp]> = [
      ["缺执行清单", { executionManifestPath: undefined }, /--apply requires --execution-manifest/],
      ["缺游标文件", { cursorFilePath: undefined }, /requires --cursor-file/],
      ["首批不能带 --after-id", { scope: { allLinked: false, limit: 200, afterId: fx.a1.id } }, /first batch must not pass --after-id/],
    ];
    for (const [label, overrides, pattern] of blockerAttempts) {
      let captured: TemplateTkdRepairSummary | null = null;
      await expect(
        runTemplateTkdRepair(workerDb, applyOptions(overrides), (summary) => {
          captured = summary;
        }),
        label,
      ).rejects.toThrow(/Repair blocked/);
      expect((captured as TemplateTkdRepairSummary | null)?.blockers.join("\n"), label).toMatch(pattern);
    }

    // 前台应用角色：闸门都过了，最后一道角色闸门拒绝。
    await expect(runTemplateTkdRepair(webDb, applyOptions())).rejects.toThrow(/front-end application role/);

    expect(existsSync(path.join(dir, "backup-batch1.json"))).toBe(false);
    expect(existsSync(cursorFilePath)).toBe(false);
    expect(await Promise.all([fx.a1, fx.a2, fx.a5, fx.a8].map((f) => articleRow(f.id)))).toEqual(before);
    expect((await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length).toBe(auditBefore);
  });

  it("执行第 1 批：只写 metaTitle/metaDescription 两个键；其它键与其它列原样；备份/审计/游标齐全", async () => {
    const snapshotBefore = new Map(await Promise.all(Object.values(fx).map(async (f) => [f.id, await articleRow(f.id)] as const)));
    const result = await runTemplateTkdRepair(workerDb, applyOptions());
    expect(result.mode).toBe("APPLIED");
    expect(result.applied).toMatchObject({ appliedCount: 3, backupPath: path.join(dir, "backup-batch1.json"), cursorFilePath });

    const a1 = await articleRow(fx.a1.id);
    expect(a1.seoMetadata).toEqual({
      metaTitle: `Roman a1${NEW_DE_TITLE_SUFFIX}`,
      metaDescription: fx.a1.description,
      coverUrl: "https://cdn.example.test/a1.jpg",
      metaKeywords: "fantasy, reise",
    });
    const a2 = await articleRow(fx.a2.id);
    expect(a2.seoMetadata).toEqual({ metaTitle: `Roman a2${NEW_DE_TITLE_SUFFIX}`, metaDescription: fx.a2.description });
    const a8 = await articleRow(fx.a8.id);
    expect(a8.seoMetadata).toEqual({ metaTitle: `Roman a8${NEW_DE_TITLE_SUFFIX}`, metaDescription: "Beschreibung von a8." });

    // 被改的三篇：除 seoMetadata 与 updatedAt 外，其余列逐列不变。
    for (const f of [fx.a1, fx.a2, fx.a8]) {
      const before = snapshotBefore.get(f.id)!;
      const after = await articleRow(f.id);
      const { seoMetadata: _s1, updatedAt: _u1, ...restBefore } = before;
      const { seoMetadata: _s2, updatedAt: _u2, ...restAfter } = after;
      void [_s1, _u1, _s2, _u2];
      expect(restAfter).toEqual(restBefore);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      // 明确点名：title/body/slug/contentMode/templateId 一个字节不动。
      expect([after.title, after.body, after.slug, after.contentMode, after.templateId]).toEqual([before.title, before.body, before.slug, before.contentMode, before.templateId]);
    }
    // 没被选中的文章完全不动（含 updatedAt）：manual、已删除、已是新标题、fr 模板下的、语种不符的。
    for (const f of [fx.a3, fx.a4, fx.a5, fx.a6, fx.a7]) {
      expect(await articleRow(f.id), f.id).toEqual(snapshotBefore.get(f.id));
    }

    // 备份：写库前落盘，含每篇 before/after 与完整 seoMetadata 快照。
    const backup = parseTemplateTkdBackup(JSON.parse(await readFile(path.join(dir, "backup-batch1.json"), "utf8")));
    expect(backup.template).toMatchObject({ id: deTemplateId, templateKey: DE_TEMPLATE_KEY, version: 1, locale: "de" });
    expect(backup.changes.map((c) => c.articleId).sort()).toEqual([fx.a1.id, fx.a2.id, fx.a8.id].sort());
    const backupA1 = backup.changes.find((c) => c.articleId === fx.a1.id)!;
    expect(backupA1.before).toEqual({ metaTitle: "Roman a1", metaDescription: "alte Beschreibung" });
    expect(backupA1.after).toEqual({ metaTitle: `Roman a1${NEW_DE_TITLE_SUFFIX}`, metaDescription: fx.a1.description });
    expect(backupA1.beforeSeoMetadata).toEqual({ metaTitle: "Roman a1", metaDescription: "alte Beschreibung", coverUrl: "https://cdn.example.test/a1.jpg", metaKeywords: "fantasy, reise" });
    expect(backup.changes.find((c) => c.articleId === fx.a2.id)!.before).toEqual({ metaTitle: null, metaDescription: null });

    // 审计：每批一条，同事务。
    const audits = await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", actorId: "codex-tkd-1", entityType: "ArticleTemplate", entityId: deTemplateId, reason: "L2 approved 2026-10-01 (test)" });
    const snap = audits[0]!.afterSnapshot as Record<string, unknown>;
    expect(snap).toMatchObject({ mode: "APPLY", changedCount: 3, changedByField: { metaTitle: 3, metaDescription: 3 }, backupPath: path.join(dir, "backup-batch1.json"), operator: "codex-tkd-1" });
    expect((snap.articleIds as string[]).sort()).toEqual([fx.a1.id, fx.a2.id, fx.a8.id].sort());
    expect(snap.backupSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.executionManifestSha256).toMatch(/^[0-9a-f]{64}$/);

    // 游标落盘，指向本批终点。
    const cursor = parseTemplateTkdCursor(JSON.parse(await readFile(cursorFilePath, "utf8")));
    expect(cursor).toMatchObject({ templateKey: DE_TEMPLATE_KEY, appliedTotal: 3, batchesApplied: 1 });
    expect(cursor.lastAfterId).toBe(result.nextAfterId);
  });

  it("备份文件独占创建：同一个备份路径再写一次直接报错，不覆盖上一批", async () => {
    const backupBefore = await readFile(path.join(dir, "backup-batch1.json"), "utf8");
    // 再做一个会变化的批（把 a2 的标题改回去）复用同一备份路径。
    await owner!.article.update({ where: { id: fx.a2.id }, data: { seoMetadata: { metaTitle: "zurück", metaDescription: "zurück" } } });
    const rows = await articleRow(fx.a2.id);
    void rows;
    await expect(
      runTemplateTkdRepair(
        workerDb,
        applyOptions({
          scope: { allLinked: false, articleIds: [fx.a2.id] },
          expectedCount: 1,
          cursorFilePath: undefined,
        }),
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path.join(dir, "backup-batch1.json"), "utf8")).toBe(backupBefore);
    // 备份写不出去就没动库：a2 仍是我们刚改回去的样子。
    expect((await articleRow(fx.a2.id)).seoMetadata).toEqual({ metaTitle: "zurück", metaDescription: "zurück" });
    // 复原，供后面的用例使用。
    await owner!.article.update({ where: { id: fx.a2.id }, data: { seoMetadata: { metaTitle: `Roman a2${NEW_DE_TITLE_SUFFIX}`, metaDescription: fx.a2.description } } });
  });

  it("幂等：同一范围再预演，变化篇数为 0；执行 0 篇不写备份、不写审计、不动库（游标照样推进到本批终点）", async () => {
    const auditsBefore = (await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length;
    const cursorBefore = parseTemplateTkdCursor(JSON.parse(await readFile(cursorFilePath, "utf8")));
    const dry = await dryRun({ scope: { allLinked: true }, excludeFilePath: path.join(dir, "exclude-signed.json") });
    expect(dry.error).toBeNull();
    expect(dry.summary!.changedCount).toBe(0);
    expect(dry.summary!.unchangedCount).toBe(4);
    const rowsBefore = await Promise.all(Object.values(fx).map((f) => articleRow(f.id)));
    const noop = await runTemplateTkdRepair(
      workerDb,
      applyOptions({
        scope: { allLinked: false, limit: 200, afterId: cursorBefore.lastAfterId ?? undefined },
        expectedCount: 0,
        backupPath: path.join(dir, "backup-noop.json"),
      }),
    );
    expect(noop.applied).toBeNull();
    expect(existsSync(path.join(dir, "backup-noop.json"))).toBe(false);
    expect((await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length).toBe(auditsBefore);
    expect(await Promise.all(Object.values(fx).map((f) => articleRow(f.id)))).toEqual(rowsBefore);
    const cursorAfter = parseTemplateTkdCursor(JSON.parse(await readFile(cursorFilePath, "utf8")));
    expect(cursorAfter).toMatchObject({ appliedTotal: cursorBefore.appliedTotal, batchesApplied: cursorBefore.batchesApplied, lastAfterId: noop.nextAfterId });
  });

  it("续跑游标：续批的 --after-id 必须等于游标里的上次终点；跳批/重批被拒", async () => {
    const cursor = parseTemplateTkdCursor(JSON.parse(await readFile(cursorFilePath, "utf8")));
    for (const [label, afterId] of [["跳批（after-id 不是上次终点）", fx.a1.id], ["重批（不带 after-id 从头再来）", undefined]] as const) {
      let captured: TemplateTkdRepairSummary | null = null;
      await expect(
        runTemplateTkdRepair(
          workerDb,
          applyOptions({ scope: { allLinked: false, limit: 200, afterId }, expectedCount: 0, backupPath: path.join(dir, `backup-${label.slice(0, 2)}.json`) }),
          (summary) => {
            captured = summary;
          },
        ),
        label,
      ).rejects.toThrow(/Repair blocked/);
      expect((captured as TemplateTkdRepairSummary | null)!.blockers.join("\n"), label).toContain("refusing to skip or repeat a batch");
    }
    // 游标属于本轮的执行清单：换一份新的执行清单（另一轮）不认这个游标——见最后一个用例。
    expect(cursor.lastAfterId).not.toBeNull();
  });

  it("CAS：读到之后、写入之前文章被改过 -> 整批回滚，备份已写但一篇没动，也没有审计（两种竞争都拦住）", async () => {
    // 造待回写文章（旧标题），用库函数直接走"取计划 -> 改 -> 写"，模拟读-写之间的竞争。
    const c1 = await seedArticle({ label: "c1", templateId: deTemplateId, seoMetadata: { metaTitle: "Roman c1", metaDescription: "alt" } });
    const c2 = await seedArticle({ label: "c2", templateId: deTemplateId, seoMetadata: { metaTitle: "Roman c2", metaDescription: "alt" } });
    const c3 = await seedArticle({ label: "c3", templateId: deTemplateId, seoMetadata: { metaTitle: "Roman c3", metaDescription: "alt" } });
    cFixtures.c1 = c1.id;
    cFixtures.c2 = c2.id;
    cFixtures.c3 = c3.id;
    const template = await loadTemplateForTkdRepair(workerDb, { templateKey: DE_TEMPLATE_KEY, templateVersion: 1 });

    const attempt = async (label: string, concurrentEdit: () => Promise<void>, racedId: string) => {
      const plan = await buildTemplateTkdRepairPlan(workerDb, template, { articleIds: [c1.id, racedId] });
      expect(plan.blockers).toEqual([]);
      expect(plan.changes).toHaveLength(2);
      await concurrentEdit();
      const beforeC1 = await articleRow(c1.id);
      const racedBefore = await articleRow(racedId);
      const auditsBefore = (await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length;
      const backupPath = path.join(dir, `backup-cas-${label}.json`);
      await expect(
        applyTemplateTkdBatch(workerDb, {
          plan,
          operator: "codex-tkd-1",
          reason: `cas ${label}`,
          requestId: `cas-${label}`,
          backupPath,
          executionManifestSha256: null,
          scope: { articleIds: [c1.id, racedId] },
        }),
        label,
      ).rejects.toThrow(new RegExp(`article ${racedId} changed since it was read`));
      // 整批回滚：c1 自己没被改过，也没有被写；被抢先改的那篇保持对方写入的样子。
      expect(await articleRow(c1.id), label).toEqual(beforeC1);
      expect(await articleRow(racedId), label).toEqual(racedBefore);
      expect((await auditRows(TEMPLATE_TKD_APPLY_AUDIT_ACTION)).length, label).toBe(auditsBefore);
      // 备份是写库前落的，所以文件在——但库里什么都没变，它只是一份"想改而没改"的记录。
      expect(existsSync(backupPath), label).toBe(true);
    };

    // (i) 后台编辑保存：标 manual、换标题、updatedAt 前进。
    await attempt(
      "admin-edit",
      async () => {
        await owner!.article.update({ where: { id: c2.id }, data: { contentMode: "manual", seoMetadata: { metaTitle: "运营刚改的标题", metaDescription: "x" } } });
      },
      c2.id,
    );
    // (ii) 不经后台（contentMode 仍是 template）只改了 SEO 字段：只有 updatedAt 这道 CAS 拦得住它
    // （去掉 CAS 里的 updatedAt 条件，这一支就会让写入悄悄覆盖对方的改动）。
    await attempt(
      "silent-update",
      async () => {
        await owner!.article.update({ where: { id: c3.id }, data: { seoMetadata: { metaTitle: "别的脚本刚写的标题", metaDescription: "y" } } });
      },
      c3.id,
    );
  });

  it("执行清单漂移守卫：模板的 SEO 标题在冻结之后被改了 -> 这一批停，不写库", async () => {
    const before = await articleRow(fx.a2.id);
    await owner!.articleTemplate.update({
      where: { id: deTemplateId },
      data: { seoTemplate: { title: "{novel_title}", metaTitle: "{novel_title} - 被改过的标题", metaDescription: "{novel_description}" } },
    });
    const { summary, error } = await dryRun({ scope: { allLinked: false, limit: 200 }, executionManifestPath });
    expect(error?.message).toMatch(/Repair blocked/);
    expect(summary!.blockers.join("\n")).toContain("execution manifest stale: template.metaTitleTemplate content changed");
    expect(summary!.blockers.join("\n")).toContain("template.updatedAt changed");
    expect(await articleRow(fx.a2.id)).toEqual(before);
    // 复原模板。
    await owner!.articleTemplate.update({
      where: { id: deTemplateId },
      data: { seoTemplate: { title: "{novel_title}", metaTitle: `{novel_title}${NEW_DE_TITLE_SUFFIX}`, metaDescription: "{novel_description}" } },
    });
  });

  it("排除清单过期：签字后文章又变了（a6 的语种改回 de、a3 被切回模板模式）-> blocker，不会悄悄照旧执行", async () => {
    await owner!.article.update({ where: { id: fx.a6.id }, data: { locale: "de" } });
    await owner!.article.update({ where: { id: fx.a3.id }, data: { contentMode: "template" } });
    const { summary } = await dryRun({ excludeFilePath: path.join(dir, "exclude-signed.json") });
    const blockers = summary!.blockers.join("\n");
    expect(blockers).toContain(`article ${fx.a6.id} locale now matches the template locale`);
    expect(blockers).toContain(`article ${fx.a3.id} is no longer manual-mode`);
    // 复原。
    await owner!.article.update({ where: { id: fx.a6.id }, data: { locale: "fr" } });
    await owner!.article.update({ where: { id: fx.a3.id }, data: { contentMode: "manual" } });
  });

  it("回滚：用备份把第 1 批回到回写前（原本没有的键被删除，其它键不动）；回滚有审计", async () => {
    const backupPath = path.join(dir, "backup-batch1.json");
    // 运营中途改过其中一篇 -> 拒绝覆盖，整批不回滚。
    const a8Before = await articleRow(fx.a8.id);
    await owner!.article.update({ where: { id: fx.a8.id }, data: { seoMetadata: { metaTitle: "运营在回写之后又改了", metaDescription: "x" } } });
    await expect(
      runTemplateTkdRestore(workerDb, { backupPath, expectedCount: 3, apply: true, operator: "codex-tkd-2", reason: "rollback test" }),
    ).rejects.toThrow(new RegExp(`article ${fx.a8.id} TKD changed after repair; refusing to overwrite`));
    expect((await articleRow(fx.a1.id)).seoMetadata).toMatchObject({ metaTitle: `Roman a1${NEW_DE_TITLE_SUFFIX}` });
    // 恢复到回写后的样子，再回滚。
    await owner!.article.update({ where: { id: fx.a8.id }, data: { seoMetadata: a8Before.seoMetadata as Prisma.InputJsonValue } });

    await expect(runTemplateTkdRestore(workerDb, { backupPath, expectedCount: 2, apply: true, operator: "x", reason: "y" })).rejects.toThrow(/does not match backup count 3/);
    const dry = await runTemplateTkdRestore(workerDb, { backupPath, apply: false });
    expect(dry).toEqual({ mode: "RESTORE_DRY_RUN", restoreCount: 3, auditId: null });
    await expect(runTemplateTkdRestore(webDb, { backupPath, expectedCount: 3, apply: true, operator: "x", reason: "y" })).rejects.toThrow(/front-end application role/);

    const restored = await runTemplateTkdRestore(workerDb, { backupPath, expectedCount: 3, apply: true, operator: "codex-tkd-2", reason: "rollback test" });
    expect(restored.mode).toBe("RESTORED");
    expect((await articleRow(fx.a1.id)).seoMetadata).toEqual({
      metaTitle: "Roman a1",
      metaDescription: "alte Beschreibung",
      coverUrl: "https://cdn.example.test/a1.jpg",
      metaKeywords: "fantasy, reise",
    });
    expect((await articleRow(fx.a2.id)).seoMetadata).toEqual({});
    expect((await articleRow(fx.a8.id)).seoMetadata).toEqual({ metaTitle: "Roman a8" });
    const restoreAudits = await auditRows(TEMPLATE_TKD_RESTORE_AUDIT_ACTION);
    expect(restoreAudits).toHaveLength(1);
    expect(restoreAudits[0]).toMatchObject({ actorId: "codex-tkd-2", entityId: deTemplateId, reason: "rollback test" });
  });

  it("新的一轮（新执行清单 + 新游标）：limit=1 逐批键集分页（UUID 顺序），批批对得上游标，全部处理完为止", async () => {
    const round2Cursor = path.join(dir, "cursor-round2.json");
    const round2Exec = path.join(dir, "exec-round2.json");
    // 这一轮多了 c2（CAS 用例里被"运营"改成 manual）：新的手改文章必须重新走"生成 -> 签字"，
    // 否则执行清单生成不出来（"排除清单不完整"闸门，见排除清单用例）。
    const round2Generated = await generateTemplateTkdExclusionFile(workerDb, { templateKey: DE_TEMPLATE_KEY, templateVersion: 1, outPath: path.join(dir, "exclude-generated-2.json") });
    expect(round2Generated.file.entries.map((e) => e.articleId).sort()).toEqual([fx.a3.id, fx.a6.id, cFixtures.c2].sort());
    const round2Signed = buildTemplateTkdExclusionFile({
      templateKey: DE_TEMPLATE_KEY,
      templateVersion: 1,
      entries: round2Generated.file.entries.map((e) => ({ ...e, reason: "运营确认（第二轮）：不回写" })),
    });
    await writeFile(path.join(dir, "exclude-signed-2.json"), JSON.stringify(round2Signed, null, 2));
    await generateTemplateTkdExecutionManifest(workerDb, {
      templateKey: DE_TEMPLATE_KEY,
      templateVersion: 1,
      excludeFilePath: path.join(dir, "exclude-signed-2.json"),
      outPath: round2Exec,
    });
    // 上一轮的游标不能带进这一轮：round1 的游标文件配 round2 的执行清单会被拒。
    let staleSummary: TemplateTkdRepairSummary | null = null;
    await expect(
      runTemplateTkdRepair(
        workerDb,
        baseOptions({ scope: { allLinked: false, limit: 1, afterId: undefined }, apply: true, locale: "de", expectedCount: 0, backupPath: path.join(dir, "backup-stale.json"), operator: "o", reason: "r", executionManifestPath: round2Exec, cursorFilePath }),
        (summary) => {
          staleSummary = summary;
        },
      ),
    ).rejects.toThrow(/Repair blocked/);
    expect((staleSummary as TemplateTkdRepairSummary | null)!.blockers.join("\n")).toContain("different execution manifest");

    const changedIds: string[] = [];
    const scannedIds: string[] = [];
    let afterId: string | undefined;
    for (let batch = 1; batch <= 20; batch += 1) {
      const common = { scope: { allLinked: false, limit: 1, afterId }, executionManifestPath: round2Exec, cursorFilePath: round2Cursor };
      const preview: TemplateTkdRepairSummary[] = [];
      await runTemplateTkdRepair(workerDb, baseOptions(common), (summary) => preview.push(summary));
      const dry = preview[0]!;
      if (dry.targetCount === 0) break; // 范围走到头
      scannedIds.push(...dry.sampleChanges.map((c) => c.articleId));
      const result = await runTemplateTkdRepair(
        workerDb,
        baseOptions({
          ...common,
          apply: true,
          locale: "de",
          expectedCount: dry.changedCount,
          backupPath: path.join(dir, `backup-round2-${batch}.json`),
          operator: "codex-tkd-3",
          reason: "round 2",
        }),
      );
      changedIds.push(...dry.sampleChanges.map((c) => c.articleId));
      afterId = result.nextAfterId ?? undefined;
      const cursor = parseTemplateTkdCursor(JSON.parse(await readFile(round2Cursor, "utf8")));
      expect(cursor.lastAfterId, `batch ${batch}`).toBe(afterId);
    }
    // 上一步回滚过的 a1 a2 a8 在这一轮被重新回写；a3(manual) a5(已是新标题) a6(排除) 都不在。CAS 用例造的三篇也属于该模板：c1、c3 被回写，c2 是 manual 被跳过。
    expect(changedIds.sort()).toEqual([fx.a1.id, fx.a2.id, fx.a8.id, cFixtures.c1, cFixtures.c3].sort());
    expect(scannedIds.length).toBe(changedIds.length);
    expect((await articleRow(fx.a1.id)).seoMetadata).toMatchObject({ metaTitle: `Roman a1${NEW_DE_TITLE_SUFFIX}`, coverUrl: "https://cdn.example.test/a1.jpg" });
    expect((await articleRow(fx.a3.id)).seoMetadata).toEqual({ metaTitle: "Handgeschriebener Titel", metaDescription: "Handgeschrieben" });
    expect((await articleRow(cFixtures.c2)).seoMetadata).toEqual({ metaTitle: "运营刚改的标题", metaDescription: "x" });
    expect((await articleRow(cFixtures.c3)).seoMetadata).toEqual({ metaTitle: `Roman c3${NEW_DE_TITLE_SUFFIX}`, metaDescription: "Beschreibung von c3." });
    const cursor = parseTemplateTkdCursor(JSON.parse(await readFile(round2Cursor, "utf8")));
    expect(cursor.appliedTotal).toBe(5);
  });
});
