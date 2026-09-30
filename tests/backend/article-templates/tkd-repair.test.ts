import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseRepairTemplateTkdArgs } from "../../../scripts/l10n/repair-template-tkd";
import {
  TEMPLATE_TKD_AUTO_EXCLUSION_REASON_MARKER,
  TEMPLATE_TKD_MAX_BATCH_LIMIT,
  activeTemplateTkdFields,
  assertTemplateTkdApplyGuard,
  assertTemplateTkdDbRole,
  assertTemplateTkdScopeArgs,
  buildTemplateTkdExclusionFile,
  buildTemplateTkdExecutionManifest,
  computeTemplateContentHashes,
  hasTemplateTkdChange,
  hashExcludedEntries,
  mergeTemplateTkdIntoSeoMetadata,
  parseTemplateTkdBackup,
  parseTemplateTkdCursor,
  parseTemplateTkdExclusionFile,
  parseTemplateTkdExecutionManifest,
  readTemplateTkdValues,
  validateExecutionManifestAgainstPlan,
  validateExecutionManifestExclusionScope,
  validateTemplateTkdCursor,
  validateTemplateTkdExclusionEntriesReviewed,
  validateTemplateTkdExclusionFileHash,
  validateTemplateTkdExecutionManifestIntegrity,
  writeExclusiveJsonFile,
  type ExcludedArticleEntry,
  type TemplateTkdBackup,
  type TemplateTkdRepairPlan,
} from "@/server/article-templates/tkd-repair";

/**
 * TKD 回写工具的纯逻辑用例（闸门、清单、哈希、合并、游标、备份解析、静态守卫）。
 * 涉及数据库的行为（按模板取文章、跳过 manual、只改两个键、预期篇数不符即停、备份内容、CAS、审计、
 * 角色）在 `tests/integration/article-templates/tkd-repair-postgres.test.ts`，由
 * `scripts/run-tkd-repair-postgres-verification.sh` 在真实 PostgreSQL 上跑。
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("批范围闸门 assertTemplateTkdScopeArgs", () => {
  const base = { allLinked: false, apply: false };

  it("必须恰好选一种范围", () => {
    expect(() => assertTemplateTkdScopeArgs({ ...base })).toThrow(/exactly one scope/);
    expect(() => assertTemplateTkdScopeArgs({ ...base, allLinked: true, limit: 10 })).toThrow(/mutually exclusive/);
    expect(() => assertTemplateTkdScopeArgs({ ...base, limit: 10, articleIds: [A] })).toThrow(/mutually exclusive/);
  });

  it("--all-linked 只能预演，不能与 --apply 同用（一次不能写无限多篇）", () => {
    expect(() => assertTemplateTkdScopeArgs({ allLinked: true, apply: false })).not.toThrow();
    expect(() => assertTemplateTkdScopeArgs({ allLinked: true, apply: true })).toThrow(/cannot be combined with --apply/);
  });

  it("批模式必须显式 --limit，且 1..200；--after-id 必须是 UUID", () => {
    expect(() => assertTemplateTkdScopeArgs({ ...base, afterId: A })).toThrow(/requires --limit/);
    for (const limit of [0, -1, 1.5, TEMPLATE_TKD_MAX_BATCH_LIMIT + 1]) {
      expect(() => assertTemplateTkdScopeArgs({ ...base, limit })).toThrow(/--limit must be an integer between 1 and 200/);
    }
    expect(() => assertTemplateTkdScopeArgs({ ...base, limit: 1 })).not.toThrow();
    expect(() => assertTemplateTkdScopeArgs({ ...base, limit: 200, afterId: A })).not.toThrow();
    expect(() => assertTemplateTkdScopeArgs({ ...base, limit: 10, afterId: "1000" })).toThrow(/must be an article UUID/);
  });

  it("--article-ids 至多 200 个、必须是 UUID", () => {
    const many = Array.from({ length: TEMPLATE_TKD_MAX_BATCH_LIMIT + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(() => assertTemplateTkdScopeArgs({ ...base, articleIds: many })).toThrow(/must not list more than 200/);
    expect(() => assertTemplateTkdScopeArgs({ ...base, articleIds: many.slice(0, 200) })).not.toThrow();
    expect(() => assertTemplateTkdScopeArgs({ ...base, articleIds: ["101"] })).toThrow(/must be UUIDs/);
  });
});

describe("--apply 闸门 assertTemplateTkdApplyGuard", () => {
  const ok = {
    apply: true,
    locale: "de",
    expectedCount: 3,
    actualCount: 3,
    backupPath: "/abs/backup.json",
    operator: "codex-1",
    reason: "L2 approved 2026-10-01",
  };

  it("预演（apply=false）不检查任何东西", () => {
    expect(() => assertTemplateTkdApplyGuard({ apply: false, actualCount: 999 })).not.toThrow();
  });

  it("全部齐备才放行", () => {
    expect(() => assertTemplateTkdApplyGuard(ok)).not.toThrow();
  });

  it("缺 --locale / 缺预期篇数 / 预期篇数不符 都停", () => {
    expect(() => assertTemplateTkdApplyGuard({ ...ok, locale: undefined })).toThrow(/exactly one --locale/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, expectedCount: undefined })).toThrow(/--expected-count/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, expectedCount: -1 })).toThrow(/--expected-count/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, expectedCount: 2 })).toThrow(/Expected 2 changed articles, but current dry-run found 3/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, expectedCount: 4 })).toThrow(/Expected 4 changed articles, but current dry-run found 3/);
  });

  it("单批超过 200 篇就停（即使预期篇数写对了）", () => {
    expect(() => assertTemplateTkdApplyGuard({ ...ok, expectedCount: 201, actualCount: 201 })).toThrow(/cannot write more than 200/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, expectedCount: 200, actualCount: 200 })).not.toThrow();
  });

  it("备份路径必须是绝对路径；必须有操作人与理由", () => {
    expect(() => assertTemplateTkdApplyGuard({ ...ok, backupPath: undefined })).toThrow(/--backup=<absolute JSON path>/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, backupPath: "relative/backup.json" })).toThrow(/--backup=<absolute JSON path>/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, operator: " " })).toThrow(/--operator/);
    expect(() => assertTemplateTkdApplyGuard({ ...ok, reason: undefined })).toThrow(/--reason/);
  });
});

describe("数据库角色闸门 assertTemplateTkdDbRole", () => {
  it("前台应用角色 web_app 一律拒绝（即使它有权限）", () => {
    expect(() => assertTemplateTkdDbRole({ currentUser: "web_app", canUpdateArticle: true, canInsertAudit: true })).toThrow(/front-end application role/);
  });

  it("没有 article UPDATE 或 operation_audit INSERT 权限就拒绝", () => {
    expect(() => assertTemplateTkdDbRole({ currentUser: "analyst_ro", canUpdateArticle: false, canInsertAudit: false })).toThrow(/no UPDATE privilege on article/);
    expect(() => assertTemplateTkdDbRole({ currentUser: "x", canUpdateArticle: true, canInsertAudit: false })).toThrow(/no INSERT privilege on operation_audit/);
  });

  it("worker_app（有两项权限）放行", () => {
    expect(() => assertTemplateTkdDbRole({ currentUser: "worker_app", canUpdateArticle: true, canInsertAudit: true })).not.toThrow();
  });
});

describe("只写两个键：mergeTemplateTkdIntoSeoMetadata / readTemplateTkdValues", () => {
  it("只改 metaTitle/metaDescription，其它键（coverUrl、metaKeywords、未知键）原样保留，且不改入参", () => {
    const before = { coverUrl: "https://example.test/c.jpg", metaKeywords: "a,b", metaTitle: "Old", metaDescription: "Old desc", extra: { nested: [1, 2] } };
    const snapshot = structuredClone(before);
    const merged = mergeTemplateTkdIntoSeoMetadata(before, { metaTitle: "New title", metaDescription: "New desc" });
    expect(merged).toEqual({ ...before, metaTitle: "New title", metaDescription: "New desc" });
    expect(before).toEqual(snapshot);
  });

  it("值为 null 表示'原本没有这个键'：回滚时删除该键", () => {
    expect(mergeTemplateTkdIntoSeoMetadata({ coverUrl: "x", metaTitle: "T" }, { metaTitle: null, metaDescription: "D" })).toEqual({ coverUrl: "x", metaDescription: "D" });
  });

  it("readTemplateTkdValues：缺失或非字符串都读成 null；空字符串保持空字符串", () => {
    expect(readTemplateTkdValues({})).toEqual({ metaTitle: null, metaDescription: null });
    expect(readTemplateTkdValues({ metaTitle: 5, metaDescription: "" })).toEqual({ metaTitle: null, metaDescription: "" });
    expect(readTemplateTkdValues(null)).toEqual({ metaTitle: null, metaDescription: null });
    expect(readTemplateTkdValues([])).toEqual({ metaTitle: null, metaDescription: null });
  });

  it("hasTemplateTkdChange 只看这两个键", () => {
    expect(hasTemplateTkdChange({ metaTitle: "a", metaDescription: "b" }, { metaTitle: "a", metaDescription: "b" })).toBe(false);
    expect(hasTemplateTkdChange({ metaTitle: "a", metaDescription: "b" }, { metaTitle: "a2", metaDescription: "b" })).toBe(true);
    expect(hasTemplateTkdChange({ metaTitle: null, metaDescription: "b" }, { metaTitle: "", metaDescription: "b" })).toBe(true);
  });

  it("activeTemplateTkdFields：模板没写的槽位不算（不写、不渲染）", () => {
    expect(activeTemplateTkdFields({ title: "t", body: "b", metaTitle: "x", metaDescription: "y" })).toEqual(["metaTitle", "metaDescription"]);
    expect(activeTemplateTkdFields({ title: "t", body: "b", metaTitle: "x" })).toEqual(["metaTitle"]);
    expect(activeTemplateTkdFields({ title: "t", body: "b" })).toEqual([]);
  });
});

describe("排除清单：生成 -> 签字 -> 生效", () => {
  const entries: ExcludedArticleEntry[] = [
    { articleId: A, kind: "manual", locale: "de", reason: `manual: ${TEMPLATE_TKD_AUTO_EXCLUSION_REASON_MARKER}, review` },
    { articleId: B, kind: "locale_mismatch", locale: "fr", reason: "运营确认：串了语种的孤儿文章，不回写" },
  ];

  it("哈希与条目顺序无关；手改条目不重算哈希会被发现", () => {
    const file = buildTemplateTkdExclusionFile({ templateKey: "system-default-de-v1", templateVersion: 1, entries });
    expect(file.sha256).toBe(hashExcludedEntries([...entries].reverse()));
    expect(validateTemplateTkdExclusionFileHash(file)).toEqual([]);
    const tampered = { ...file, entries: [{ ...file.entries[0]!, reason: "signed by nobody" }, file.entries[1]!] };
    expect(validateTemplateTkdExclusionFileHash(tampered)).toHaveLength(1);
  });

  it("parse 往返；拒绝重复 id、非 UUID、未知 kind", () => {
    const file = buildTemplateTkdExclusionFile({ templateKey: "k", templateVersion: 1, entries });
    expect(parseTemplateTkdExclusionFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(() => parseTemplateTkdExclusionFile({ ...file, entries: [entries[0], entries[0]] })).toThrow(/duplicate/);
    expect(() => parseTemplateTkdExclusionFile({ ...file, entries: [{ ...entries[0], articleId: "12" }] })).toThrow(/Invalid exclusion file entry/);
    expect(() => parseTemplateTkdExclusionFile({ ...file, entries: [{ ...entries[0], kind: "other" }] })).toThrow(/Invalid exclusion file entry/);
    expect(() => parseTemplateTkdExclusionFile({ version: 9 })).toThrow(/Invalid exclusion file header/);
  });

  it("还带着 auto-generated 占位理由 = 没签字，拒绝使用（签字后的条目放行）", () => {
    const issues = validateTemplateTkdExclusionEntriesReviewed(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(A);
    expect(issues[0]).toContain("sign-off");
    expect(validateTemplateTkdExclusionEntriesReviewed([entries[1]!])).toEqual([]);
  });
});

describe("执行清单：冻结整轮范围 + 每批对账", () => {
  const template = {
    id: TEMPLATE_ID,
    templateKey: "system-default-de-v1",
    version: 1,
    locale: "de",
    updatedAt: new Date("2026-09-30T00:00:00.000Z"),
    bodyTemplate: "<article><h1>{novel_title}</h1></article>",
    seoTemplate: { title: "{novel_title}", metaTitle: "{novel_title} Roman: Kapitel online gratis lesen", metaDescription: "{novel_description}" },
    slugTemplate: "",
    metaKeywordsTemplate: "",
  };
  const build = (overrides: Partial<Parameters<typeof buildTemplateTkdExecutionManifest>[0]> = {}) =>
    buildTemplateTkdExecutionManifest({
      template,
      activeFields: ["metaTitle", "metaDescription"],
      createdAtCutoff: "2026-09-30T01:00:00.000Z",
      targetArticleIds: [C, A, B, A],
      excludedEntries: [{ articleId: B, kind: "manual", locale: "de", reason: "签字：手改过" }],
      generatedAt: "2026-09-30T01:00:00.000Z",
      ...overrides,
    });
  const planOf = (overrides: Partial<Pick<TemplateTkdRepairPlan, "template" | "activeFields" | "fetchedArticleIds">> = {}) => ({
    template: {
      id: template.id,
      templateKey: template.templateKey,
      version: template.version,
      templateName: "x",
      locale: "de",
      status: "active",
      updatedAt: template.updatedAt.toISOString(),
      contentHashes: computeTemplateContentHashes(template),
    },
    activeFields: ["metaTitle", "metaDescription"] as TemplateTkdRepairPlan["activeFields"],
    fetchedArticleIds: [A, C],
    ...overrides,
  });

  it("目标 id 去重排序并带哈希；parse 往返；完整性校验通过", () => {
    const manifest = build();
    expect(manifest.targetArticleIds.ids).toEqual([A, B, C]);
    expect(manifest.targetArticleIds.count).toBe(3);
    expect(parseTemplateTkdExecutionManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(validateTemplateTkdExecutionManifestIntegrity(manifest)).toEqual([]);
  });

  it("被篡改（多加一个目标 id / 改了排除理由）而没重算哈希 -> 完整性校验红", () => {
    const manifest = build();
    const extraTarget = { ...manifest, targetArticleIds: { ...manifest.targetArticleIds, ids: [...manifest.targetArticleIds.ids, "44444444-4444-4444-8444-444444444444"] } };
    expect(validateTemplateTkdExecutionManifestIntegrity(extraTarget).join("\n")).toContain("targetArticleIds");
    const editedReason = {
      ...manifest,
      excludedArticleIds: { ...manifest.excludedArticleIds, entries: [{ ...manifest.excludedArticleIds.entries[0]!, reason: "改了" }] },
    };
    expect(validateTemplateTkdExecutionManifestIntegrity(editedReason).join("\n")).toContain("excludedArticleIds");
  });

  it("对账：模板与清单冻结时一致 -> 无问题", () => {
    expect(validateExecutionManifestAgainstPlan(build(), planOf())).toEqual([]);
  });

  it("对账：模板中途被改（SEO 标题模板 / 更新时间 / 槽位）-> 各自报出来", () => {
    const manifest = build();
    const changedTitle = planOf();
    changedTitle.template.contentHashes = { ...changedTitle.template.contentHashes, metaTitleTemplate: "0".repeat(64) };
    expect(validateExecutionManifestAgainstPlan(manifest, changedTitle).join("\n")).toContain("template.metaTitleTemplate content changed");

    const changedAt = planOf();
    changedAt.template.updatedAt = "2026-10-01T00:00:00.000Z";
    expect(validateExecutionManifestAgainstPlan(manifest, changedAt).join("\n")).toContain("template.updatedAt changed");

    const changedSlots = planOf({ activeFields: ["metaTitle"] });
    expect(validateExecutionManifestAgainstPlan(manifest, changedSlots).join("\n")).toContain("template SEO slots now write");
  });

  it("对账：不是冻结的那个模板 / 这批里有冻结目标集之外的文章 -> 停", () => {
    const manifest = build();
    const otherTemplate = planOf();
    otherTemplate.template.id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(validateExecutionManifestAgainstPlan(manifest, otherTemplate).join("\n")).toContain("identity mismatch");
    const outOfScope = planOf({ fetchedArticleIds: [A, "44444444-4444-4444-8444-444444444444"] });
    expect(validateExecutionManifestAgainstPlan(manifest, outOfScope).join("\n")).toContain("not in the recorded target set");
  });

  it("独立传入的排除清单必须与清单冻结的那份一致", () => {
    const manifest = build();
    const same = buildTemplateTkdExclusionFile({ templateKey: template.templateKey, templateVersion: 1, entries: manifest.excludedArticleIds.entries });
    expect(validateExecutionManifestExclusionScope(manifest, same)).toEqual([]);
    expect(validateExecutionManifestExclusionScope(manifest, undefined)).toEqual([]);
    const other = buildTemplateTkdExclusionFile({ templateKey: template.templateKey, templateVersion: 1, entries: [] });
    expect(validateExecutionManifestExclusionScope(manifest, other).join("\n")).toContain("exclusion file drift");
  });
});

describe("续跑游标：不漏批、不重批、不串轮次", () => {
  const cursor = parseTemplateTkdCursor({
    version: 1,
    templateKey: "system-default-de-v1",
    templateVersion: 1,
    executionManifestSha256: "a".repeat(64),
    lastAfterId: B,
    appliedTotal: 200,
    batchesApplied: 1,
    updatedAt: "2026-09-30T00:00:00.000Z",
  });
  const same = { templateKey: "system-default-de-v1", templateVersion: 1, executionManifestSha256: "a".repeat(64) };

  it("首批（游标文件不存在）不能带 --after-id", () => {
    expect(validateTemplateTkdCursor({ cursor: null, ...same })).toEqual([]);
    expect(validateTemplateTkdCursor({ cursor: null, afterId: A, ...same }).join("\n")).toContain("first batch must not pass --after-id");
  });

  it("续批的 --after-id 必须恰好等于游标的上次终点", () => {
    expect(validateTemplateTkdCursor({ cursor, afterId: B, ...same })).toEqual([]);
    expect(validateTemplateTkdCursor({ cursor, afterId: C, ...same }).join("\n")).toContain("refusing to skip or repeat a batch");
    expect(validateTemplateTkdCursor({ cursor, ...same }).join("\n")).toContain("refusing to skip or repeat a batch");
  });

  it("游标属于另一份执行清单（另一轮）/ 另一个模板 -> 停", () => {
    expect(validateTemplateTkdCursor({ cursor, afterId: B, ...same, executionManifestSha256: "b".repeat(64) }).join("\n")).toContain("different execution manifest");
    expect(validateTemplateTkdCursor({ cursor, afterId: B, ...same, templateKey: "system-default-fr-v1" }).join("\n")).toContain("belongs to template");
  });

  it("游标文件格式校验", () => {
    expect(() => parseTemplateTkdCursor({ version: 1 })).toThrow(/Invalid cursor file/);
  });
});

describe("备份文件解析 parseTemplateTkdBackup", () => {
  const change = {
    articleId: A,
    locale: "de",
    slug: "das-verlorene-koenigreich",
    status: "published",
    before: { metaTitle: "Das verlorene Königreich", metaDescription: "d" },
    after: { metaTitle: "Das verlorene Königreich Roman: Kapitel online gratis lesen", metaDescription: "d" },
    readUpdatedAt: "2026-09-30T00:00:00.000Z",
    beforeSeoMetadata: { metaTitle: "Das verlorene Königreich", metaDescription: "d", coverUrl: "x" },
  };
  const backup: TemplateTkdBackup = {
    version: 1,
    generatedAt: "2026-09-30T00:00:00.000Z",
    template: { id: TEMPLATE_ID, templateKey: "system-default-de-v1", version: 1, locale: "de" },
    changes: [change],
  };

  it("往返", () => {
    expect(parseTemplateTkdBackup(JSON.parse(JSON.stringify(backup)))).toEqual(backup);
  });

  it("拒绝：重复文章、语种与模板不符、缺少 beforeSeoMetadata、值类型不对", () => {
    expect(() => parseTemplateTkdBackup({ ...backup, changes: [change, change] })).toThrow(/duplicate/);
    expect(() => parseTemplateTkdBackup({ ...backup, changes: [{ ...change, locale: "fr" }] })).toThrow(/locale does not match/);
    const { beforeSeoMetadata: _omitted, ...withoutSnapshot } = change;
    void _omitted;
    expect(() => parseTemplateTkdBackup({ ...backup, changes: [withoutSnapshot] })).toThrow(/Invalid TKD backup change/);
    expect(() => parseTemplateTkdBackup({ ...backup, changes: [{ ...change, after: { metaTitle: 1, metaDescription: null } }] })).toThrow(/Invalid TKD backup change/);
    expect(() => parseTemplateTkdBackup({ version: 2 })).toThrow(/Invalid TKD backup header/);
  });
});

describe("写文件一律独占创建、且必须绝对路径", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("写入内容与返回的哈希一致；第二次写同一路径报错，绝不覆盖上一批的备份", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tkd-repair-file-"));
    const target = path.join(dir, "backup.json");
    const sha = await writeExclusiveJsonFile(target, { a: 1 });
    const text = await readFile(target, "utf8");
    expect(JSON.parse(text)).toEqual({ a: 1 });
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    await expect(writeExclusiveJsonFile(target, { a: 2 })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ a: 1 });
  });

  it("相对路径直接拒绝", async () => {
    await expect(writeExclusiveJsonFile("relative.json", {})).rejects.toThrow(/absolute path/);
  });
});

describe("CLI 参数解析 parseRepairTemplateTkdArgs", () => {
  it("默认是预演，没有 --apply", () => {
    const parsed = parseRepairTemplateTkdArgs(["--template-key=system-default-de-v1", "--all-linked"]);
    expect(parsed).toMatchObject({ kind: "repair", options: { templateKey: "system-default-de-v1", templateVersion: 1, apply: false, scope: { allLinked: true } } });
  });

  it("批模式：--limit/--after-id/--expected-count/--backup/--operator/--reason/--apply 全部解析", () => {
    const parsed = parseRepairTemplateTkdArgs([
      "--template-key=system-default-de-v1",
      "--locale=de",
      `--after-id=${A.toUpperCase()}`,
      "--limit=200",
      "--expected-count=57",
      "--backup=/abs/b.json",
      "--operator=codex-1",
      "--reason=L2 approved",
      "--execution-manifest=/abs/e.json",
      "--cursor-file=/abs/c.json",
      "--apply",
    ]);
    expect(parsed).toMatchObject({
      kind: "repair",
      options: {
        apply: true,
        locale: "de",
        expectedCount: 57,
        backupPath: "/abs/b.json",
        operator: "codex-1",
        reason: "L2 approved",
        executionManifestPath: "/abs/e.json",
        cursorFilePath: "/abs/c.json",
        scope: { allLinked: false, afterId: A, limit: 200 },
      },
    });
  });

  it("其它子命令与错误输入", () => {
    expect(parseRepairTemplateTkdArgs([])).toEqual({ kind: "help" });
    expect(parseRepairTemplateTkdArgs(["--list", "--locales=en,ja"])).toEqual({ kind: "list", locales: ["en", "ja"] });
    expect(() => parseRepairTemplateTkdArgs(["--list", "--locales=xx"])).toThrow(/Unsupported locales/);
    expect(() => parseRepairTemplateTkdArgs(["--all-linked"])).toThrow(/Missing --template-key/);
    expect(parseRepairTemplateTkdArgs(["--restore-from=/abs/b.json", "--expected-count=3"])).toMatchObject({ kind: "restore", apply: false, expectedCount: 3 });
    expect(parseRepairTemplateTkdArgs(["--template-key=k", "--generate-exclusion-file=/abs/x.json"])).toMatchObject({ kind: "generate-exclusion-file", outPath: "/abs/x.json" });
    expect(() => parseRepairTemplateTkdArgs(["--template-key=k", "--generate-execution-manifest"])).toThrow(/--execution-manifest/);
  });
});

describe("静态守卫：渲染只走文章创建时的同一个函数；写库只写 seoMetadata", () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

  it("回写工具与 generate.ts 都从 render-novel-article 取渲染函数，工具里没有自己的一套渲染/兜底", () => {
    const repair = read("src/server/article-templates/tkd-repair.ts");
    const generate = read("src/server/content-creation/generate.ts");
    expect(repair).toMatch(/import \{[^}]*renderNovelArticleDraft[^}]*\} from "@\/server\/content-creation\/render-novel-article"/);
    expect(generate).toMatch(/import \{[^}]*renderNovelArticleDraft[^}]*\} from "\.\/render-novel-article"/);
    // 工具里不得直接调用引擎渲染或自己拼取值表——那就是"另写一套"。
    const code = repair.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\brenderArticleDraft\s*\(/);
    expect(code).not.toMatch(/\bbuildNovelTemplateValues\s*\(/);
    // 创建路径同样不再自己调用引擎（统一由 render-novel-article 承载）。
    const generateCode = generate.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(generateCode).not.toMatch(/\brenderArticleDraft\s*\(/);
    expect(generateCode).not.toMatch(/\bbuildNovelTemplateValues\s*\(/);
  });

  it("回写工具对 article 的写入只有两处 updateMany，且 data 里只有 seoMetadata（不碰 title/body/slug/contentMode/templateId）", () => {
    const repair = read("src/server/article-templates/tkd-repair.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const writes = [...repair.matchAll(/\.article\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/g)].map((m) => m[1]);
    expect(writes).toEqual(["updateMany", "updateMany"]);
    const calls = [...repair.matchAll(/\.article\.updateMany\(\{[\s\S]*?\n {6}\}\)/g)];
    expect(calls).toHaveLength(2);
    for (const match of calls) {
      const data = /data:\s*\{([\s\S]*?)\}\s*(?:,|\n)/.exec(match[0])?.[1] ?? "";
      expect(data).toContain("seoMetadata");
      expect(data).not.toMatch(/\b(title|body|slug|contentMode|templateId|status|summary)\s*:/);
    }
  });

  it("CLI 是薄壳：不直接写 article，不自己渲染", () => {
    const cli = read("scripts/l10n/repair-template-tkd.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(cli).not.toMatch(/\.article\.(update|updateMany|create|upsert|delete)/);
    expect(cli).not.toMatch(/renderArticleDraft|renderNovelArticleDraft/);
  });
});
