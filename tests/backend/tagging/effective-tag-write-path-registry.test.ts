/**
 * B-38 防漏登记：`novel_effective_tag` 是派生投影，唯一真源是 `src/server/tagging/effective-tag-projection.ts`
 * 里的规则 SQL。它的正确性取决于"每一个能改变分类归属的真源写入点，都在同一事务里重算了投影"。
 * CPS 自己的教训是"靠穷举写入路径来保证一致，这条路本身就是错的"——所以除了站点地图刷新前的兜底
 * 对账，这里再加一道静态闸：扫描 `src/`、`worker/`、`scheduler/`、`scripts/`（不含 tests）里**所有**
 * 对下列模型 / 表的写操作，每一处必须登记在 `REGISTRY` 里并标注一类。新出现的写入点没登记 → 用例变红；
 * 登记了但代码里已经没有（或数量不符）→ 也变红，登记表不会烂掉。
 *
 * 被监视的真源（Prisma 模型 ↔ 物理表）：
 *   novelCanonicalTag ↔ novel_canonical_tag      人工 / 自动标签行
 *   novelTagState     ↔ novel_tag_state          人工 / 自动模式、当前自动打标是哪一次
 *   sourceLabelMapping ↔ source_label_mapping    上游标签 → 分类 映射边
 *   novelSourceItemLabel ↔ novel_source_item_label  书目身上有哪些上游标签（及 active）
 *   sourceLabel       ↔ source_label             上游标签字典
 *   novelSourceItem   ↔ novel_source_item        上游书目（绑定的小说、状态、语言范围、软删除）
 *   canonicalTag      ↔ canonical_tag            分类本身（状态、排序号、slug、stable_id）
 *   channelApp        ↔ channel_app              渠道应用（状态）
 *   novelEffectiveTag ↔ novel_effective_tag      投影本身——只允许 effective-tag-projection.ts 写
 *
 * 五类（`category`）：
 *   inline_refresh                  同事务重算（单本或单页）：写完真源后调用 refreshEffectiveTagsForNovels
 *   full_reconcile                  同事务全量对账：调用 reconcileAllEffectiveTags
 *   not_membership_relevant         不影响归属，**必须写理由**（例如"只改章节数 / 封面"）
 *   ops_script_requires_reconcile   运维脚本：绕过了同事务重算，跑完必须执行一次对账命令
 *                                   （scripts/ops/effective-tag-projection.ts reconcile）
 *   projection_module               只用于 effective-tag-projection.ts 对 novel_effective_tag 的写入
 *
 * 覆盖面的诚实边界：扫描认的是 `<任意前缀>.<模型>.<写方法>(` 与 `INSERT INTO / UPDATE / DELETE FROM / TRUNCATE <表>`
 * 两种形态；经 Prisma 嵌套写入（`novel.update({ data: { tagState: { create } } })`）或把模型访问器解构到别的
 * 变量名再写的情形扫不到——所以仍保留站点地图刷新前的兜底全量对账和只读检查命令。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".sh", ".sql"]);
const PROJECTION_MODULE = "src/server/tagging/effective-tag-projection.ts";

const MODEL_TO_TABLE: Readonly<Record<string, string>> = {
  novelCanonicalTag: "novel_canonical_tag",
  novelTagState: "novel_tag_state",
  sourceLabelMapping: "source_label_mapping",
  novelSourceItemLabel: "novel_source_item_label",
  sourceLabel: "source_label",
  novelSourceItem: "novel_source_item",
  canonicalTag: "canonical_tag",
  channelApp: "channel_app",
  novelEffectiveTag: "novel_effective_tag",
};
const TABLES = Object.values(MODEL_TO_TABLE);
const PRISMA_WRITE_METHODS = ["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert", "delete", "deleteMany"];

type Category =
  | "inline_refresh"
  | "full_reconcile"
  | "not_membership_relevant"
  | "ops_script_requires_reconcile"
  | "projection_module";

type Site = Readonly<{ category: Category; contains: string; reason?: string }>;
type Entry = Readonly<{ file: string; table: string; op: string; sites: readonly Site[] }>;

/** op：Prisma 写方法名，或原生 SQL 的 INSERT / UPDATE / DELETE / TRUNCATE。sites 按文件内出现顺序一一对应。 */
const REGISTRY: readonly Entry[] = [
  // ───────────────────────── 同事务重算：人工 / 自动 / 新建小说 / 目录同步 ─────────────────────────
  {
    file: "src/server/tagging/service.ts", table: "novel_canonical_tag", op: "deleteMany",
    sites: [
      { category: "inline_refresh", contains: 'source: "manual"', reason: "replaceManualTagSnapshot：清掉旧人工快照，随后同事务 refreshEffectiveTagsForNovels" },
      { category: "inline_refresh", contains: 'source: "manual"', reason: "exitManualTagMode：退出人工模式时清掉人工快照，随后同事务 refreshEffectiveTagsForNovels" },
      { category: "inline_refresh", contains: 'source: "auto"', reason: "replaceAutoTagSnapshotInTransaction：替换自动快照，随后同事务 refreshEffectiveTagsForNovels" },
    ],
  },
  {
    file: "src/server/tagging/service.ts", table: "novel_canonical_tag", op: "createMany",
    sites: [
      { category: "inline_refresh", contains: 'source: "manual"', reason: "replaceManualTagSnapshot：写新的人工快照，随后同事务重算" },
      { category: "inline_refresh", contains: 'source: "auto"', reason: "replaceAutoTagSnapshotInTransaction：写新的自动快照，随后同事务重算" },
    ],
  },
  {
    file: "src/server/tagging/service.ts", table: "novel_tag_state", op: "update",
    sites: [
      { category: "inline_refresh", contains: 'mode: "manual"', reason: "replaceManualTagSnapshot：切到人工模式，随后同事务重算" },
      { category: "inline_refresh", contains: 'mode: "automatic"', reason: "exitManualTagMode：切回自动模式，随后同事务重算" },
      { category: "inline_refresh", contains: "currentAutoRunId: run.id", reason: "replaceAutoTagSnapshotInTransaction：登记'当前这次'自动打标，随后同事务重算" },
    ],
  },
  {
    file: "src/server/tagging/service.ts", table: "novel_tag_state", op: "INSERT",
    sites: [
      { category: "inline_refresh", contains: "VALUES (${novelId}::uuid, 'automatic', 0", reason: "lockNovelAndState：没有状态行时补一行默认的 automatic（'无行'与'automatic'语义相同）；它只被上面三个写入函数调用，调用方都在同事务重算" },
    ],
  },
  {
    file: "src/server/content-creation/service.ts", table: "novel_source_item", op: "updateMany",
    sites: [
      { category: "inline_refresh", contains: 'status: "linked"', reason: "新建小说并绑定上游书目：同事务 refreshEffectiveTagsForNovels(tx, [novel.id])（web_app 单本创建 + worker_app 批量任务共用）" },
    ],
  },
  {
    file: "worker/handlers/moboreader.ts", table: "source_label", op: "upsert",
    sites: [
      { category: "inline_refresh", contains: "channelAppId_labelKind_externalLabelValue", reason: "目录同步每页（persistCatalogPage → persistLabels）：本页末尾同事务重算本页所有已绑定小说" },
    ],
  },
  {
    file: "worker/handlers/moboreader.ts", table: "novel_source_item_label", op: "upsert",
    sites: [
      { category: "inline_refresh", contains: "novelSourceItemId_sourceLabelId", reason: "目录同步每页：同上，本页末尾同事务重算" },
    ],
  },
  {
    file: "worker/handlers/moboreader.ts", table: "novel_source_item", op: "createMany",
    sites: [
      { category: "inline_refresh", contains: "skipDuplicates: true", reason: "目录同步恢复页（recoveryOnly）：新建书目行；本页末尾同事务重算本页已绑定小说（新建行本身未绑定小说，不产生归属）" },
    ],
  },
  {
    file: "worker/handlers/moboreader.ts", table: "novel_source_item", op: "upsert",
    sites: [
      { category: "inline_refresh", contains: "channelAppId_externalBookId_sourceLanguageCode", reason: "目录同步每页：更新语言范围、撤销书目软删除等都会改变映射归属；本页末尾同事务重算本页已绑定小说" },
    ],
  },

  // ───────────────────────── 同事务全量对账：改映射 / 分类启停 ─────────────────────────
  {
    file: "src/server/tagging/admin-service.ts", table: "canonical_tag", op: "update",
    sites: [
      { category: "full_reconcile", contains: "status: mutation.status", reason: "mutateAdminCanonicalTag set_status：分类启用 / 停用，同事务 reconcileAllEffectiveTags(tx)" },
      { category: "not_membership_relevant", contains: "data: { aliases }", reason: "只改别名（分类器查词用），不改任何书属于哪些分类；改译名 / 别名 / 关键词不触发重算" },
      { category: "not_membership_relevant", contains: "updatedAt: deps.now", reason: "每次分类变更后统一刷新 updated_at 乐观锁时间戳，不改 status / slug / 排序号（排序号只在 bootstrap 脚本里写）" },
    ],
  },
  {
    file: "src/server/tagging/admin-service.ts", table: "canonical_tag", op: "UPDATE",
    sites: [
      { category: "not_membership_relevant", contains: "SET is_homepage_visible", reason: "v0.5.15 replaceHomepageNavSelection：只更新 is_homepage_visible（首页题材导航是否显示该分类），不改 status / slug / 排序号 / updated_at，不改任何书属于哪些分类，所以不重算归属表、不拿投影锁" },
    ],
  },
  {
    file: "src/server/tagging/admin-service.ts", table: "source_label_mapping", op: "update",
    sites: [
      { category: "full_reconcile", contains: "active: true", reason: "mutateAdminSourceLabelMapping approve_edge（已有边改版 / 重新启用）：同事务 reconcileAllEffectiveTags(tx)" },
      { category: "full_reconcile", contains: "active: false", reason: "mutateAdminSourceLabelMapping deactivate_edge：同事务 reconcileAllEffectiveTags(tx)" },
    ],
  },
  {
    file: "src/server/tagging/admin-service.ts", table: "source_label_mapping", op: "create",
    sites: [
      { category: "full_reconcile", contains: "mappingVersion: value.mappingVersion", reason: "mutateAdminSourceLabelMapping approve_edge（新边）：同事务 reconcileAllEffectiveTags(tx)" },
    ],
  },

  // ───────────────────────── 运维脚本：绕过同事务重算，跑完必须对账 ─────────────────────────
  {
    file: "scripts/p2-06-5-production/tagging-bootstrap.ts", table: "canonical_tag", op: "upsert",
    sites: [
      { category: "ops_script_requires_reconcile", contains: "stableId", reason: "CanonicalTag v1 一次性引导脚本：直接写分类（含 status / sortOrder）。跑完必须执行 scripts/ops/effective-tag-projection.ts reconcile --apply --confirm RECONCILE-EFFECTIVE-TAGS" },
    ],
  },
  {
    file: "scripts/p2-06-5-production/tagging-bootstrap.ts", table: "source_label_mapping", op: "upsert",
    sites: [
      { category: "ops_script_requires_reconcile", contains: "channelAppId_rawLanguageScope_rawToken_canonicalTagId", reason: "同上：直接写 196 条映射边。跑完必须执行 scripts/ops/effective-tag-projection.ts reconcile --apply --confirm RECONCILE-EFFECTIVE-TAGS" },
    ],
  },
  {
    file: "scripts/l10n/backfill-source-item-locale.ts", table: "novel_source_item", op: "updateMany",
    sites: [
      { category: "not_membership_relevant", contains: "data: { sourceLocale: nextLocale }", reason: "只回填书目的映射语种 source_locale；归属规则只看 status / deleted_at / novel_id / raw_language_scope / channel_app，不读 source_locale" },
    ],
  },
  {
    file: "src/lib/preview/changdu-materialization.ts", table: "novel_source_item", op: "update",
    sites: [
      { category: "not_membership_relevant", contains: "totalChapterCount: totalChapterCountForUpdate", reason: "试读物化只更新章节数 / 付费起始章 / last_seen_at，不动 status / deleted_at / novel_id / raw_language_scope" },
    ],
  },
  {
    file: "scripts/register-moboreader-foundation.ts", table: "channel_app", op: "create",
    sites: [
      { category: "not_membership_relevant", contains: "channelApp = await tx.channelApp.create", reason: "新建渠道应用（status 初值 active）：此时它名下没有任何书目，不存在归属；之后随书目进来的归属由目录同步每页重算覆盖" },
    ],
  },
  {
    file: "scripts/one-book-promo-claim-smoke.ts", table: "novel_source_item", op: "upsert",
    sites: [
      { category: "not_membership_relevant", contains: "prisma.novelSourceItem.upsert", reason: "单本领推广冒烟脚本：新建 pending 的未绑定书目；后续绑定小说走 createContentFromSourceItem，在那里同事务重算" },
    ],
  },

  // ───────────────────────── 测量 / 夹具 / 运行器：只写一次性测试库，不触碰生产数据 ─────────────────────────
  {
    file: "scripts/measure-tagging-task-creation-memory.ts", table: "channel_app", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "db.channelApp.create", reason: "内存测量脚本：只对一次性隔离库造数据（脚本自己要求 isolated 库名），不接触生产" }],
  },
  {
    file: "scripts/measure-tagging-task-creation-memory.ts", table: "novel_source_item", op: "createMany",
    sites: [{ category: "not_membership_relevant", contains: "createMany({ data: sources })", reason: "同上，一次性隔离库造数据" }],
  },
  {
    file: "scripts/measure-tagging-task-creation-memory.ts", table: "novel_tag_state", op: "createMany",
    sites: [{ category: "not_membership_relevant", contains: "createMany({ data: states })", reason: "同上，一次性隔离库造数据" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "canonical_tag", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "prisma.canonicalTag.create", reason: "自动标签预览的夹具脚本：只对一次性隔离库造数据" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "channel_app", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "prisma.channelApp.create", reason: "同上，一次性隔离库夹具" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "source_label", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "prisma.sourceLabel.create", reason: "同上，一次性隔离库夹具" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "source_label_mapping", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "prisma.sourceLabelMapping.create", reason: "同上，一次性隔离库夹具" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "novel_source_item", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "prisma.novelSourceItem.create", reason: "同上，一次性隔离库夹具" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "novel_source_item_label", op: "create",
    sites: [{ category: "not_membership_relevant", contains: "prisma.novelSourceItemLabel.create", reason: "同上，一次性隔离库夹具" }],
  },
  {
    file: "scripts/tagging-auto-preview-fixtures.ts", table: "novel_tag_state", op: "create",
    sites: [
      { category: "not_membership_relevant", contains: 'mode: "automatic"', reason: "同上，一次性隔离库夹具" },
      { category: "not_membership_relevant", contains: 'mode: "automatic"', reason: "同上，一次性隔离库夹具" },
      { category: "not_membership_relevant", contains: 'mode: "manual"', reason: "同上，一次性隔离库夹具" },
      { category: "not_membership_relevant", contains: "data: { novelId: novel.id, mode }", reason: "同上，一次性隔离库夹具" },
    ],
  },
  {
    file: "scripts/run-tagging-auto-preview-postgres-verification.sh", table: "canonical_tag", op: "updateMany",
    sites: [
      { category: "not_membership_relevant", contains: "mutation-check-must-be-rejected", reason: "运行器里的变异自检：往一份临时拷贝里注入写入，断言被只读事务 / 角色拒绝；不是运行期写入" },
      { category: "not_membership_relevant", contains: "mutation-check-must-be-rejected", reason: "同上，第二处变异自检" },
    ],
  },
  {
    file: "scripts/p1-13-restore-smoke.sh", table: "channel_app", op: "INSERT",
    sites: [{ category: "not_membership_relevant", contains: "INSERT INTO channel_app", reason: "恢复演练脚本：往一次性演练库里插夹具行，用来验证备份恢复；不接触生产" }],
  },

  // ───────────────────────── 投影本身 ─────────────────────────
  {
    file: PROJECTION_MODULE, table: "novel_effective_tag", op: "INSERT",
    sites: [
      { category: "projection_module", contains: "INSERT INTO novel_effective_tag (novel_id", reason: "首次建表快照函数 buildEffectiveTagFirstBuildSql（迁移里的 B38_FIRST_BUILD 段由它生成）" },
      { category: "projection_module", contains: "INSERT INTO novel_effective_tag (novel_id", reason: "buildApplySql 的 ins CTE：只插缺失行" },
    ],
  },
  {
    file: PROJECTION_MODULE, table: "novel_effective_tag", op: "UPDATE",
    sites: [{ category: "projection_module", contains: "UPDATE novel_effective_tag target", reason: "buildApplySql 的 upd CTE：只改内容变了的行" }],
  },
  {
    file: PROJECTION_MODULE, table: "novel_effective_tag", op: "DELETE",
    sites: [{ category: "projection_module", contains: "DELETE FROM novel_effective_tag target", reason: "buildApplySql 的 del CTE：只删多余行" }],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// 扫描
// ────────────────────────────────────────────────────────────────────────────

type Occurrence = { file: string; table: string; op: string; context: string; line: number };

function listFiles(dir: string): string[] {
  const absolute = path.join(root, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) out.push(path.relative(root, target).split(path.sep).join("/"));
    }
  };
  walk(absolute);
  return out;
}

/** 去掉 `/* … *\/` 与 `// …`（不动 `://` 这种 URL），保持换行以便行号不变。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

function balancedCall(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return source.slice(openParenIndex);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

const PRISMA_WRITE = new RegExp(
  `\\.(${Object.keys(MODEL_TO_TABLE).join("|")})\\.(${PRISMA_WRITE_METHODS.join("|")})\\s*\\(`,
  "g",
);
const SQL_WRITE = new RegExp(
  `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+(?:ONLY\\s+)?"?(?:public"?\\.)?"?(${TABLES.join("|")})"?(?![\\w])`,
  "gi",
);

function scan(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const dir of SCAN_ROOTS) {
    for (const file of listFiles(dir)) {
      const raw = readFileSync(path.join(root, file), "utf8");
      const source = file.endsWith(".sql") || file.endsWith(".sh") ? raw : stripComments(raw);
      const text = file.endsWith(".sql") ? source.replace(/--[^\n]*/g, (m) => " ".repeat(m.length)) : source;
      for (const match of text.matchAll(PRISMA_WRITE)) {
        const start = match.index ?? 0;
        const lineStart = text.lastIndexOf("\n", start) + 1;
        found.push({
          file, table: MODEL_TO_TABLE[match[1]!]!, op: match[2]!, line: lineOf(text, start),
          // 从该行行首（含 `const x = await tx.` 这类前缀）一直到调用的右括号
          context: text.slice(lineStart, start) + match[0] + balancedCall(text, start + match[0].length - 1).slice(1),
        });
      }
      for (const match of text.matchAll(SQL_WRITE)) {
        const start = match.index ?? 0;
        const verb = match[1]!.toUpperCase().replace(/\s+.*/, "");
        found.push({
          file, table: match[2]!.toLowerCase(), op: verb, line: lineOf(text, start),
          context: text.slice(start, start + 400),
        });
      }
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const groupKey = (entry: { file: string; table: string; op: string }) => `${entry.file} :: ${entry.table} :: ${entry.op}`;

describe("B-38 novel_effective_tag 写入点登记", () => {
  const occurrences = scan();
  const grouped = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const bucket = grouped.get(groupKey(occurrence)) ?? [];
    bucket.push(occurrence);
    grouped.set(groupKey(occurrence), bucket);
  }
  const registered = new Map<string, Entry>();
  for (const entry of REGISTRY) {
    if (registered.has(groupKey(entry))) throw new Error(`duplicate registry entry ${groupKey(entry)}`);
    registered.set(groupKey(entry), entry);
  }

  if (process.env.B38_REGISTRY_DUMP === "1") {
    it("dump", () => {
      for (const occurrence of occurrences) console.log(`${occurrence.file}:${occurrence.line} ${occurrence.table} ${occurrence.op}`);
    });
  }

  it("扫描本身是有效的：能在已知文件里找到已知的写入点（防止扫描器空转而假绿）", () => {
    const keys = new Set(occurrences.map(groupKey));
    expect(keys.has("src/server/tagging/service.ts :: novel_canonical_tag :: deleteMany")).toBe(true);
    expect(keys.has("src/server/tagging/admin-service.ts :: source_label_mapping :: create")).toBe(true);
    expect(keys.has("worker/handlers/moboreader.ts :: novel_source_item :: upsert")).toBe(true);
    expect(keys.has(`${PROJECTION_MODULE} :: novel_effective_tag :: INSERT`)).toBe(true);
    expect(occurrences.length).toBeGreaterThanOrEqual(30);
  });

  it("每一处写入点都已登记（新增写入点不登记 → 红）", () => {
    const unregistered = [...grouped.entries()]
      .filter(([key]) => !registered.has(key))
      .map(([key, list]) => `${key}  (行 ${list.map((o) => o.line).join(", ")})`);
    expect(unregistered, "这些写入点没有登记在 REGISTRY 里：先判断它会不会改变分类归属，再决定登记哪一类").toEqual([]);
  });

  it("登记里没有已经不存在的写入点，每组数量与代码一致，且每条登记都对得上它在代码里的那一处", () => {
    const problems: string[] = [];
    for (const [key, entry] of registered) {
      const list = grouped.get(key) ?? [];
      if (list.length !== entry.sites.length) {
        problems.push(`${key}: 登记 ${entry.sites.length} 处，代码里有 ${list.length} 处`);
        continue;
      }
      entry.sites.forEach((site, index) => {
        if (!list[index]!.context.includes(site.contains)) {
          problems.push(`${key} #${index + 1}: 代码 ${list[index]!.line} 行附近找不到登记的标识 ${JSON.stringify(site.contains)}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("not_membership_relevant 必须写理由；ops 脚本必须写明跑完要对账", () => {
    const problems: string[] = [];
    for (const entry of REGISTRY) {
      for (const site of entry.sites) {
        if (site.category === "not_membership_relevant" && (site.reason ?? "").trim().length < 10) {
          problems.push(`${groupKey(entry)}: not_membership_relevant 没有写理由`);
        }
        if (site.category === "ops_script_requires_reconcile" && !(site.reason ?? "").includes("RECONCILE-EFFECTIVE-TAGS")) {
          problems.push(`${groupKey(entry)}: ops 脚本登记必须写出对账命令`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("inline_refresh / full_reconcile 的文件，真的包含对应数量的重算调用（登记不是空头支票；少调一处立刻红）", () => {
    // 每个文件里重算调用的确切个数：
    //   tagging/service.ts           5 = 人工保存 1 + 退出人工 1 + 自动打标（重放分支、人工跳过分支、正常写入）3
    //   content-creation/service.ts  1 = 绑定书目后重算新书
    //   worker/handlers/moboreader.ts 1 = 目录同步每页末尾重算本页已绑定小说
    //   tagging/admin-service.ts     2 = 分类启停 1 + 改映射 1（全量对账）
    const needs: Record<string, { pattern: RegExp; count: number }> = {
      "src/server/tagging/service.ts": { pattern: /await refreshEffectiveTagsForNovels\(tx, \[input\.novelId\]\)/g, count: 5 },
      "src/server/content-creation/service.ts": { pattern: /await refreshEffectiveTagsForNovels\(tx as unknown as Prisma\.TransactionClient, \[novel\.id\]\)/g, count: 1 },
      "worker/handlers/moboreader.ts": { pattern: /await refreshEffectiveTagsForNovels\(tx, boundNovelIds\)/g, count: 1 },
      "src/server/tagging/admin-service.ts": { pattern: /await reconcileAllEffectiveTags\(tx\)/g, count: 2 },
    };
    const problems: string[] = [];
    for (const entry of REGISTRY) {
      if (!entry.sites.some((site) => site.category === "inline_refresh" || site.category === "full_reconcile")) continue;
      if (!needs[entry.file]) problems.push(`${entry.file}: 没有在 needs 里声明它的重算调用形态`);
    }
    for (const [file, { pattern, count }] of Object.entries(needs)) {
      const found = (readFileSync(path.join(root, file), "utf8").match(pattern) ?? []).length;
      if (found !== count) problems.push(`${file}: 重算调用应有 ${count} 处，实际 ${found} 处`);
    }
    expect(problems).toEqual([]);
  });

  it("novel_effective_tag 的写入只允许出现在 effective-tag-projection.ts（迁移 SQL 不在扫描范围内）", () => {
    const outside = occurrences.filter((occurrence) => occurrence.table === "novel_effective_tag" && occurrence.file !== PROJECTION_MODULE);
    expect(outside.map((occurrence) => `${occurrence.file}:${occurrence.line} ${occurrence.op}`)).toEqual([]);
    const inside = occurrences.filter((occurrence) => occurrence.table === "novel_effective_tag" && occurrence.file === PROJECTION_MODULE);
    expect(inside.map((occurrence) => occurrence.op).sort()).toEqual(["DELETE", "INSERT", "INSERT", "UPDATE"]);
    // 反过来：projection_module 这一类也只能用在这个文件、只能用于这张表
    for (const entry of REGISTRY) {
      if (entry.sites.some((site) => site.category === "projection_module")) {
        expect(entry.file).toBe(PROJECTION_MODULE);
        expect(entry.table).toBe("novel_effective_tag");
      }
    }
  });

  it("没有任何文件通过 Prisma 访问器写 novelEffectiveTag（该模型只能经规则 SQL 的差异写入）", () => {
    const prismaWrites = occurrences.filter((occurrence) => occurrence.table === "novel_effective_tag" && PRISMA_WRITE_METHODS.includes(occurrence.op));
    expect(prismaWrites).toEqual([]);
  });
});
