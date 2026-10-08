/**
 * B-38 `novel_effective_tag` 真实库用例共用的夹具与读取函数（不是用例文件，vitest 不会收集它）。
 *
 * 环境：`scripts/run-effective-tag-projection-postgres-verification.sh` 起一次性 postgres:16.14，
 * 跑真实 `roles.sql` + 全部迁移 + `grants.sql`，再把五个真实角色的连接串通过下列变量传进来：
 *   B38_DATABASE_TEST=1
 *   B38_OWNER_DATABASE_URL / B38_WEB_DATABASE_URL / B38_WORKER_DATABASE_URL /
 *   B38_SCHEDULER_DATABASE_URL / B38_ANALYST_DATABASE_URL
 * 数据库名必须以 `cps_novel_b38_` 开头（`assertIsolatedDatabase`），防止误连别的库。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

export const enabled = process.env.B38_DATABASE_TEST === "1";

export type Roles = Readonly<{
  owner: PrismaClient;
  web: PrismaClient;
  worker: PrismaClient;
  scheduler: PrismaClient;
  analyst: PrismaClient;
}>;

function client(role: string): PrismaClient {
  const datasourceUrl = process.env[`B38_${role}_DATABASE_URL`];
  if (enabled && !datasourceUrl) throw new Error(`missing explicit ${role} URL`);
  return new PrismaClient({ datasourceUrl });
}

export function connectRoles(): Roles {
  return {
    owner: client("OWNER"),
    web: client("WEB"),
    worker: client("WORKER"),
    scheduler: client("SCHEDULER"),
    analyst: client("ANALYST"),
  };
}

export async function disconnectRoles(roles: Roles): Promise<void> {
  await Promise.all(Object.values(roles).map((db) => db.$disconnect()));
}

export async function assertIsolatedDatabase(owner: PrismaClient): Promise<void> {
  const [row] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (!row.name.startsWith("cps_novel_b38_")) throw new Error(`isolated B-38 database required, got ${row.name}`);
}

export async function resetDatabase(owner: PrismaClient): Promise<void> {
  await assertIsolatedDatabase(owner);
  const tables = await owner.$queryRawUnsafe<Array<{ tablename: string }>>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  const names = tables.map(({ tablename }) => `"${tablename}"`).join(", ");
  await owner.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

/** 从迁移 SQL 里截取"首次建表"段（B38_FIRST_BUILD_BEGIN/END 之间），用来在测试里单独执行。 */
export function firstBuildSegment(): string {
  const root = path.resolve(import.meta.dirname, "../../..");
  const sql = readFileSync(path.join(root, "prisma/migrations/20261009120000_b38_novel_effective_tag/migration.sql"), "utf8");
  const begin = sql.indexOf("-- B38_FIRST_BUILD_BEGIN");
  const end = sql.indexOf("-- B38_FIRST_BUILD_END");
  if (begin < 0 || end < begin) throw new Error("B38_FIRST_BUILD markers missing from the migration");
  return sql.slice(begin + "-- B38_FIRST_BUILD_BEGIN".length, end).trim();
}

// ────────────────────────────────────────────────────────────────────────────
// 基础夹具：管理员、渠道、应用、分类、上游标签、映射边
// ────────────────────────────────────────────────────────────────────────────

export const HASH = "a".repeat(64);
export const SCOPE_EN = '["RAW_LANGUAGE_SCOPE_V1",["string","en"],["null"]]';
export const SCOPE_DE = '["RAW_LANGUAGE_SCOPE_V1",["string","de"],["null"]]';

type TagSpec = { key: string; stable: string; slug: string; sort: number; status: "active" | "inactive" };

/**
 * 分类（注意几处刻意的设计）：
 *   alpha / aaa-tie 同一个 sort_order=10：同序号时按 slug（aaa-tie 在 alpha 前）；
 *   aardvark / zebra：slug 顺序与 stable_id 顺序相反，用来区分"映射段按 slug"和"自动段按 stable_id"；
 *   zeta 停用：任何来源指向它都不应出现在投影里。
 */
export const TAG_SPECS: readonly TagSpec[] = [
  { key: "alpha", stable: "ct-v1-aa", slug: "alpha", sort: 10, status: "active" },
  { key: "beta", stable: "ct-v1-bb", slug: "beta", sort: 20, status: "active" },
  { key: "gamma", stable: "ct-v1-cc", slug: "gamma", sort: 30, status: "active" },
  { key: "delta", stable: "ct-v1-dd", slug: "delta", sort: 40, status: "active" },
  { key: "epsilon", stable: "ct-v1-ee", slug: "epsilon", sort: 50, status: "active" },
  { key: "zeta", stable: "ct-v1-ff", slug: "zeta", sort: 60, status: "inactive" },
  { key: "eta", stable: "ct-v1-gg", slug: "eta", sort: 70, status: "active" },
  { key: "theta", stable: "ct-v1-hh", slug: "theta", sort: 80, status: "active" },
  { key: "tie", stable: "ct-v1-ab", slug: "aaa-tie", sort: 10, status: "active" },
  { key: "omega", stable: "ct-v1-zz", slug: "omega", sort: 90, status: "active" },
  { key: "aardvark", stable: "ct-v1-zy", slug: "aardvark", sort: 100, status: "active" },
  { key: "zebra", stable: "ct-v1-aa2", slug: "zebra", sort: 110, status: "active" },
];
export type TagKey = (typeof TAG_SPECS)[number]["key"];

export type Foundation = Readonly<{
  admin: string;
  channel: string;
  sourceApp: string;
  appActive: string;
  appInactive: string;
  appDisabled: string;
  tags: Readonly<Record<string, string>>;
  /** `${appKey}:${kind}:${value}` -> source_label.id */
  labels: ReadonlyMap<string, string>;
}>;

export async function seedFoundation(owner: PrismaClient): Promise<Foundation> {
  const admin = randomUUID();
  const channel = randomUUID();
  const sourceApp = randomUUID();
  const appActive = randomUUID();
  const appInactive = randomUUID();
  const appDisabled = randomUUID();
  await owner.adminIdentity.create({ data: { id: admin, username: `b38-${admin}`, passwordHash: "scrypt$v1$test-only", role: "super_admin" } });
  await owner.channel.create({ data: { id: channel, code: "b38", name: "b38" } });
  await owner.sourceApp.create({ data: { id: sourceApp, code: "b38", name: "b38" } });
  await owner.channelApp.createMany({
    data: [
      { id: appActive, channelId: channel, sourceAppId: sourceApp, externalAppId: "b38-active", projectType: 1, status: "active" },
      { id: appInactive, channelId: channel, sourceAppId: sourceApp, externalAppId: "b38-inactive", projectType: 1, status: "inactive" },
      { id: appDisabled, channelId: channel, sourceAppId: sourceApp, externalAppId: "b38-disabled", projectType: 1, status: "registered_disabled" },
    ],
  });

  const tags: Record<string, string> = {};
  for (const spec of TAG_SPECS) {
    tags[spec.key] = randomUUID();
    await owner.canonicalTag.create({
      data: {
        id: tags[spec.key], stableId: spec.stable, slug: spec.slug, canonicalDefinition: "fixture",
        aliases: [], sortOrder: spec.sort, taxonomyVersion: "v1", status: spec.status,
      },
    });
  }
  // 译名：前台标签文案（本用例不比较，只是让 LEFT JOIN canonical_tag_translation 有行可连）
  await owner.canonicalTagTranslation.createMany({
    data: [
      { canonicalTagId: tags.alpha!, locale: "en", displayName: "Alpha" },
      { canonicalTagId: tags.alpha!, locale: "zh", displayName: "阿尔法" },
      { canonicalTagId: tags.beta!, locale: "zh", displayName: "贝塔" },
    ],
  });

  const labels = new Map<string, string>();
  const labelSpecs: Array<[string, string, string, string]> = [
    // [appKey, appId, kind, value]
    ["A", appActive, "series_type", "romance"],
    ["A", appActive, "series_type", "fantasy"],
    ["A", appActive, "series_type", "dup"],
    ["A", appActive, "series_type", "old"],
    ["A", appActive, "series_type", "zeta-token"],
    ["A", appActive, "series_type", "Romance"],
    ["A", appActive, "series_type", "unmapped"],
    ["A", appActive, "recommend", "romance"],
    ["B", appInactive, "series_type", "romance"],
    ["C", appDisabled, "series_type", "romance"],
  ];
  for (const [appKey, appId, kind, value] of labelSpecs) {
    const row = await owner.sourceLabel.create({ data: { channelAppId: appId, labelKind: kind, externalLabelValue: value } });
    labels.set(`${appKey}:${kind}:${value}`, row.id);
  }

  const mapping = (app: string, scope: string, token: string, tag: string, active = true) => ({
    channelAppId: app, rawLanguageScope: scope, rawToken: token, canonicalTagId: tags[tag]!,
    mappingVersion: "fixture", approvedBy: admin, active,
  });
  await owner.sourceLabelMapping.createMany({
    data: [
      mapping(appActive, SCOPE_EN, "romance", "alpha"),
      mapping(appActive, SCOPE_EN, "romance", "beta"),
      mapping(appActive, SCOPE_EN, "romance", "tie"),
      mapping(appActive, SCOPE_EN, "fantasy", "gamma"),
      mapping(appActive, SCOPE_EN, "dup", "gamma"),
      mapping(appActive, SCOPE_EN, "old", "delta", false),
      mapping(appActive, SCOPE_EN, "zeta-token", "zeta"),
      mapping(appActive, SCOPE_DE, "romance", "eta"),
      mapping(appInactive, SCOPE_EN, "romance", "epsilon"),
      mapping(appDisabled, SCOPE_EN, "romance", "theta"),
    ],
  });
  return { admin, channel, sourceApp, appActive, appInactive, appDisabled, tags, labels };
}

// ────────────────────────────────────────────────────────────────────────────
// 造小说 / 书目 / 标签状态
// ────────────────────────────────────────────────────────────────────────────

let novelCounter = 0;

export async function createNovel(owner: PrismaClient, options: { deleted?: boolean; title?: string } = {}): Promise<string> {
  const id = randomUUID();
  novelCounter += 1;
  await owner.novel.create({
    data: {
      id, businessId: id, title: options.title ?? `B38 novel ${novelCounter}`, description: "", locale: "en",
      slug: `b38-${novelCounter}-${id.slice(0, 8)}`, status: "published", deletedAt: options.deleted ? new Date() : null,
    },
  });
  return id;
}

export type SourceItemSpec = Readonly<{
  app: string;
  scope: string | null;
  /** 书目标签：`${appKey}:${kind}:${value}`，附 active 标志；默认 active */
  labels?: ReadonlyArray<{ key: string; active?: boolean }>;
  status?: "linked" | "pending" | "ignored" | "stale";
  deleted?: boolean;
  /** 不绑定小说（novel_id 为空） */
  unbound?: boolean;
}>;

export async function addSourceItem(owner: PrismaClient, foundation: Foundation, novelId: string, spec: SourceItemSpec): Promise<string> {
  const id = randomUUID();
  await owner.novelSourceItem.create({
    data: {
      id, channelAppId: spec.app, novelId: spec.unbound ? null : novelId, externalBookId: id, sourceLocale: "en",
      sourceLanguageCode: "en", rawLanguageScope: spec.scope, title: "b38 source", description: "",
      status: spec.status ?? "linked", rawPayload: {}, deletedAt: spec.deleted ? new Date() : null,
    },
  });
  for (const label of spec.labels ?? []) {
    const labelId = foundation.labels.get(label.key);
    if (!labelId) throw new Error(`unknown fixture label ${label.key}`);
    await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: id, sourceLabelId: labelId, active: label.active ?? true } });
  }
  return id;
}

export async function createRun(owner: PrismaClient, novelId: string): Promise<string> {
  const run = await owner.tagClassificationRun.create({
    data: {
      novelId, method: "deterministic_text", taxonomyVersion: "v1", taxonomySha256: HASH, keywordLexiconVersion: "v1",
      keywordFingerprint: HASH, classifierConfigVersion: "v1", classifierConfigFingerprint: HASH, contentSha256: HASH,
      requestId: randomUUID(), resultSummary: {}, resultSchemaVersion: 1,
    },
  });
  return run.id;
}

export type TagStateSpec = Readonly<{
  mode: "automatic" | "manual";
  /** 人工快照（mode 无论是什么都可以写，用来造"自动模式里残留人工行"） */
  manual?: readonly string[];
  /** 属于"登记的那一次"自动打标的结果（run A） */
  auto?: ReadonlyArray<{ tag: string; score: number | null }>;
  /** 属于"另一次"自动打标的结果（run B） */
  oldAuto?: ReadonlyArray<{ tag: string; score: number | null }>;
  /** current_auto_run_id 指向哪一次：默认 run A（"current"）；"old" 指向 run B；"none" 为空 */
  pointer?: "current" | "old" | "none";
}>;

export async function setTagState(owner: PrismaClient, foundation: Foundation, novelId: string, spec: TagStateSpec): Promise<void> {
  const runA = (spec.auto ?? []).length > 0 ? await createRun(owner, novelId) : null;
  const runB = (spec.oldAuto ?? []).length > 0 ? await createRun(owner, novelId) : null;
  const pointer = spec.pointer ?? "current";
  const currentAutoRunId = pointer === "none" ? null : pointer === "old" ? runB : runA;
  await owner.novelTagState.create({ data: { novelId, mode: spec.mode, currentAutoRunId } });
  for (const tag of spec.manual ?? []) {
    await owner.novelCanonicalTag.create({
      data: { novelId, canonicalTagId: foundation.tags[tag]!, source: "manual", decidedBy: foundation.admin, evidence: {}, evidenceSchemaVersion: 1 },
    });
  }
  for (const row of spec.auto ?? []) {
    await owner.novelCanonicalTag.create({
      data: { novelId, canonicalTagId: foundation.tags[row.tag]!, source: "auto", score: row.score, classificationRunId: runA!, evidence: {}, evidenceSchemaVersion: 1 },
    });
  }
  for (const row of spec.oldAuto ?? []) {
    await owner.novelCanonicalTag.create({
      data: { novelId, canonicalTagId: foundation.tags[row.tag]!, source: "auto", score: row.score, classificationRunId: runB!, evidence: {}, evidenceSchemaVersion: 1 },
    });
  }
}

/**
 * 覆盖三套规则每个分支的小说矩阵。返回 名字 -> 小说 id，用例里按名字做定向断言。
 * 夹具里每一本的预期（用 alpha/beta/tie… 表示）写在注释里，真正的权威仍是冻结的现场计算参照。
 */
export async function seedScenarioMatrix(owner: PrismaClient, f: Foundation): Promise<Readonly<Record<string, string>>> {
  const novels: Record<string, string> = {};
  const make = async (name: string, options: { deleted?: boolean } = {}) => (novels[name] = await createNovel(owner, options));
  const romanceA = { key: "A:series_type:romance" };

  // 人工有标签：只认人工，映射被忽略 → manual: beta(20), alpha(10)... 按 sort 排：alpha, beta
  await make("manual_with_tags");
  await addSourceItem(owner, f, novels.manual_with_tags!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:fantasy" }] });
  await setTagState(owner, f, novels.manual_with_tags!, { mode: "manual", manual: ["beta", "alpha"] });

  // 人工清空：人工模式但没有人工行 → 没有任何分类（映射与自动都被压住）
  await make("manual_cleared");
  await addSourceItem(owner, f, novels.manual_cleared!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA] });
  await setTagState(owner, f, novels.manual_cleared!, { mode: "manual", auto: [{ tag: "delta", score: 9 }] });

  // 只有映射（同 sort_order 的两个分类按 slug：aaa-tie 在 alpha 前）→ tie, alpha, beta
  await make("mapped_only");
  await addSourceItem(owner, f, novels.mapped_only!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA] });
  await setTagState(owner, f, novels.mapped_only!, { mode: "automatic" });

  // 只有自动：分数降序；分数相同按 stable_id（zebra 的 stable_id 小于 aardvark 的，尽管 slug 相反）
  await make("auto_only");
  await setTagState(owner, f, novels.auto_only!, {
    mode: "automatic",
    auto: [{ tag: "delta", score: 10 }, { tag: "aardvark", score: 40 }, { tag: "zebra", score: 40 }, { tag: "epsilon", score: 90 }],
  });

  // 映射与自动是同一分类：记 mapped（beta 同时有自动 90 分）；其余自动行排在映射之后
  await make("mapped_and_auto_same_tag");
  await addSourceItem(owner, f, novels.mapped_and_auto_same_tag!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA] });
  await setTagState(owner, f, novels.mapped_and_auto_same_tag!, {
    mode: "automatic", auto: [{ tag: "beta", score: 90 }, { tag: "eta", score: 20 }],
  });

  // 没有标签状态行：按"自动模式"处理，走映射
  await make("no_state_row");
  await addSourceItem(owner, f, novels.no_state_row!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA] });

  // 映射停用（old → delta，active=false）→ 没有
  await make("mapping_inactive");
  await addSourceItem(owner, f, novels.mapping_inactive!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:old" }] });
  await setTagState(owner, f, novels.mapping_inactive!, { mode: "automatic" });

  // 渠道停用 / 渠道 registered_disabled：映射存在但渠道不是 active → 没有
  await make("channel_inactive");
  await addSourceItem(owner, f, novels.channel_inactive!, { app: f.appInactive, scope: SCOPE_EN, labels: [{ key: "B:series_type:romance" }] });
  await make("channel_disabled");
  await addSourceItem(owner, f, novels.channel_disabled!, { app: f.appDisabled, scope: SCOPE_EN, labels: [{ key: "C:series_type:romance" }] });

  // 书目未绑定（novel_id 为空）：这本小说自己没有书目 → 没有
  await make("source_unbound");
  await addSourceItem(owner, f, novels.source_unbound!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA], unbound: true, status: "pending" });

  // 书目已软删除 → 没有
  await make("source_soft_deleted");
  await addSourceItem(owner, f, novels.source_soft_deleted!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA], deleted: true });

  // 书目状态不是 linked（pending / ignored / stale）→ 没有
  for (const status of ["pending", "ignored", "stale"] as const) {
    await make(`source_status_${status}`);
    await addSourceItem(owner, f, novels[`source_status_${status}`]!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA], status });
  }

  // 书目语言范围为空 → 没有
  await make("scope_null");
  await addSourceItem(owner, f, novels.scope_null!, { app: f.appActive, scope: null, labels: [romanceA] });

  // 语言范围不匹配：映射只有 EN 的 romance → alpha/beta/tie；这本是 DE 范围 → 走 DE 的 romance → eta
  await make("scope_de");
  await addSourceItem(owner, f, novels.scope_de!, { app: f.appActive, scope: SCOPE_DE, labels: [romanceA] });
  // 范围根本没有任何映射（"xx"）→ 没有
  await make("scope_unmapped");
  await addSourceItem(owner, f, novels.scope_unmapped!, { app: f.appActive, scope: '["RAW_LANGUAGE_SCOPE_V1",["string","xx"],["null"]]', labels: [romanceA] });

  // 书目标签 inactive → 没有
  await make("label_inactive");
  await addSourceItem(owner, f, novels.label_inactive!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:romance", active: false }] });

  // 标签类型不是 series_type（recommend 里恰好也叫 romance）→ 没有
  await make("label_kind_recommend");
  await addSourceItem(owner, f, novels.label_kind_recommend!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:recommend:romance" }] });

  // 分类停用：映射指向停用的 zeta；同时还有 romance（alpha/beta/tie 正常）→ zeta 不出现，rank 仍然连续
  await make("mapped_tag_inactive");
  await addSourceItem(owner, f, novels.mapped_tag_inactive!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:zeta-token" }, romanceA] });
  await setTagState(owner, f, novels.mapped_tag_inactive!, { mode: "automatic" });

  // 自动打标不是当前这次：另一次（旧）的自动行必须被忽略，只认 current_auto_run_id 那一次
  await make("auto_not_current_run");
  await setTagState(owner, f, novels.auto_not_current_run!, {
    mode: "automatic", auto: [{ tag: "gamma", score: 5 }], oldAuto: [{ tag: "omega", score: 99 }],
  });
  // current_auto_run_id 为空 → 自动行全部忽略
  await make("auto_no_current_pointer");
  await setTagState(owner, f, novels.auto_no_current_pointer!, {
    mode: "automatic", auto: [{ tag: "gamma", score: 5 }], pointer: "none",
  });
  // current_auto_run_id 指向"另一次"：登记的那次（omega）生效，rows 在 run A 的（gamma）被忽略
  await make("auto_pointer_to_other_run");
  await setTagState(owner, f, novels.auto_pointer_to_other_run!, {
    mode: "automatic", auto: [{ tag: "gamma", score: 5 }], oldAuto: [{ tag: "omega", score: 99 }], pointer: "old",
  });

  // 一本书多个书目（两个渠道应用/语言），并集 + 去重：A/EN romance → tie/alpha/beta；A/EN fantasy+dup → gamma（两条边同一分类）
  await make("multi_source_items");
  await addSourceItem(owner, f, novels.multi_source_items!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA] });
  await addSourceItem(owner, f, novels.multi_source_items!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:fantasy" }, { key: "A:series_type:dup" }] });
  await addSourceItem(owner, f, novels.multi_source_items!, { app: f.appActive, scope: SCOPE_DE, labels: [romanceA] });

  // auto 分数为空：NULLS FIRST（DESC 的默认）→ 分数为空的排在有分数的前面
  await make("auto_null_score");
  await setTagState(owner, f, novels.auto_null_score!, {
    mode: "automatic", auto: [{ tag: "gamma", score: 50 }, { tag: "delta", score: null }, { tag: "epsilon", score: 70 }, { tag: "eta", score: null }],
  });

  // 自动模式里残留的人工行：自动模式下人工行不算
  await make("automatic_with_leftover_manual");
  await addSourceItem(owner, f, novels.automatic_with_leftover_manual!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:fantasy" }] });
  await setTagState(owner, f, novels.automatic_with_leftover_manual!, { mode: "automatic", manual: ["omega"] });

  // 人工模式里残留的自动行（且指向当前这次）：人工模式下自动行不算
  await make("manual_with_leftover_auto");
  await setTagState(owner, f, novels.manual_with_leftover_auto!, { mode: "manual", manual: ["theta"], auto: [{ tag: "omega", score: 80 }] });

  // 自动行指向停用分类 → 不出现
  await make("auto_tag_inactive");
  await setTagState(owner, f, novels.auto_tag_inactive!, { mode: "automatic", auto: [{ tag: "zeta", score: 80 }, { tag: "delta", score: 10 }] });

  // 大小写变体：标签是 'Romance'，映射 token 是 'romance' → COLLATE "C" 逐字节比较，不匹配 → 没有
  await make("token_case_variant");
  await addSourceItem(owner, f, novels.token_case_variant!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:Romance" }] });

  // 标签没有映射 → 没有
  await make("label_unmapped");
  await addSourceItem(owner, f, novels.label_unmapped!, { app: f.appActive, scope: SCOPE_EN, labels: [{ key: "A:series_type:unmapped" }] });

  // 小说已软删除：归属规则不看 novel.deleted_at（表里收录全部小说），保持映射结果
  await make("novel_soft_deleted", { deleted: true });
  await addSourceItem(owner, f, novels.novel_soft_deleted!, { app: f.appActive, scope: SCOPE_EN, labels: [romanceA] });

  // 完全没有书目也没有状态 → 没有
  await make("bare");
  return novels;
}

/** 确定性伪随机（mulberry32），让随机批夹具在失败时可复现。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机批：组合爆炸式地覆盖各分支的交叉（模式 × 人工行 × 自动行/当前指针 × 书目 × 标签 × 状态）。 */
export async function seedRandomNovels(owner: PrismaClient, f: Foundation, count: number, seed: number): Promise<number> {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;
  const tagKeys = TAG_SPECS.map((spec) => spec.key);
  const subset = (items: readonly string[], p: number) => items.filter(() => chance(p));
  const labelKeys = [...f.labels.keys()];
  const apps = [f.appActive, f.appActive, f.appActive, f.appInactive, f.appDisabled];
  const scopes = [SCOPE_EN, SCOPE_EN, SCOPE_DE, null, '["RAW_LANGUAGE_SCOPE_V1",["string","xx"],["null"]]'];
  const statuses = ["linked", "linked", "linked", "linked", "pending", "ignored", "stale"] as const;
  for (let index = 0; index < count; index += 1) {
    const novelId = await createNovel(owner, { deleted: chance(0.05) });
    const itemCount = pick([0, 1, 1, 1, 2, 3]);
    for (let item = 0; item < itemCount; item += 1) {
      const app = pick(apps);
      const appKey = app === f.appActive ? "A" : app === f.appInactive ? "B" : "C";
      const keysForApp = labelKeys.filter((key) => key.startsWith(`${appKey}:`));
      await addSourceItem(owner, f, novelId, {
        app, scope: pick(scopes), status: pick(statuses), deleted: chance(0.08), unbound: chance(0.05),
        labels: subset(keysForApp, 0.45).map((key) => ({ key, active: chance(0.85) })),
      });
    }
    if (chance(0.8)) {
      const mode = chance(0.3) ? "manual" : "automatic";
      const manual = chance(0.7) ? subset(tagKeys, 0.25) : [];
      const autoTags = chance(0.75) ? subset(tagKeys, 0.3) : [];
      // novel_canonical_tag 在 (书, 分类, 来源) 上唯一，所以"另一次自动打标"的分类不能和当前这次重叠
      const oldAutoTags = chance(0.2) ? subset(tagKeys.filter((tag) => !autoTags.includes(tag)), 0.2) : [];
      await setTagState(owner, f, novelId, {
        mode,
        manual,
        auto: autoTags.map((tag) => ({ tag, score: chance(0.15) ? null : pick([10, 20, 20, 40, 40, 60, 80]) })),
        oldAuto: oldAutoTags.map((tag) => ({ tag, score: pick([10, 99]) })),
        pointer: chance(0.1) ? "none" : chance(0.15) ? "old" : "current",
      });
    }
  }
  return count;
}

// ────────────────────────────────────────────────────────────────────────────
// 读取投影 / 读取现场计算（冻结参照）
// ────────────────────────────────────────────────────────────────────────────

export type ProjectionRow = Readonly<{ novel_id: string; canonical_tag_id: string; provenance: string; score: number | null; rank: number }>;

export async function readProjectionRows(db: PrismaClient): Promise<ProjectionRow[]> {
  return db.$queryRaw<ProjectionRow[]>`
    SELECT novel_id, canonical_tag_id, provenance, score, rank
    FROM novel_effective_tag ORDER BY novel_id, canonical_tag_id
  `;
}

/** 读取侧语义：自动开关开 → 全部行；关 → 去掉 auto 行；按 rank 排。返回 小说 -> [分类 id…]。 */
export async function readProjectionSequences(db: PrismaClient, autoEnabled: boolean): Promise<Map<string, string[]>> {
  const rows = await db.$queryRaw<Array<{ novel_id: string; canonical_tag_id: string }>>`
    SELECT novel_id, canonical_tag_id
    FROM novel_effective_tag
    WHERE provenance <> 'auto' OR ${autoEnabled}
    ORDER BY novel_id, rank
  `;
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.novel_id) ?? [];
    list.push(row.canonical_tag_id);
    out.set(row.novel_id, list);
  }
  return out;
}

export async function allNovelIds(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM novel ORDER BY id`;
  return rows.map((row) => row.id);
}
