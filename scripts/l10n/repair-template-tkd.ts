/**
 * 模板 SEO 字段回写 CLI（TKD 对齐 CPS，Owner 2026-09-30，施工工单第五块）——薄壳：只做参数解析、连库、
 * 打印摘要；全部逻辑与安全闸都在 `src/server/article-templates/tkd-repair.ts`（头注释有完整清单）。
 *
 * 照 CPS `scripts/repair-template-tkd.ts` 的形状。**默认只预演**；写库必须 `--apply`，且需要：
 * `--locale`、`--expected-count`（等于本批预演出的"会变化的篇数"）、`--backup`（绝对路径，独占创建）、
 * `--operator`、`--reason`、`--execution-manifest`（冻结整轮范围）、`--cursor-file`（每轮一个，每批落盘）。
 *
 * 连接：读 `DATABASE_URL`（与 `scripts/l10n/article-template-bootstrap.ts` 同一种连接方式，
 * `new PrismaClient()`）。**写库不要用前台应用角色 `web_app`**——脚本会拒绝；用 `worker_app`
 * （`infra/postgres/grants.sql`：`article` INSERT/UPDATE、`operation_audit` INSERT、`novel`/`promo_link`/
 * `novel_chapter`/`article_template` SELECT 都已授予）。预演只需要 SELECT。
 *
 * 推荐流程（L2 变更，先批准、执行与验收由不同代理完成；顺序：预演 -> 运营看样本 -> 金丝雀一批 -> 分批执行）：
 *
 *   # 0. 列出各语种默认模板与其关联篇数
 *   tsx scripts/l10n/repair-template-tkd.ts --list --locales=en,ja
 *   # 1. 预演整个模板（--all-linked 只读，不能与 --apply 同用）
 *   tsx scripts/l10n/repair-template-tkd.ts --template-key=system-default-de-v1 --all-linked
 *   # 2. 生成排除清单（手改过的文章 + 语种不符的文章），运营把每条 reason 里的 auto-generated 改成真实理由 = 签字
 *   tsx scripts/l10n/repair-template-tkd.ts --template-key=system-default-de-v1 --generate-exclusion-file=/abs/de-exclude.json
 *   # 3. 冻结整轮范围（模板内容哈希 + 目标篇数 + 已签字的排除集）
 *   tsx scripts/l10n/repair-template-tkd.ts --template-key=system-default-de-v1 --generate-execution-manifest \
 *     --execution-manifest=/abs/de-exec.json --exclude-article-ids-file=/abs/de-exclude.json
 *   # 4. 每批：先预演，再带 --expected-count 执行（首批不带 --after-id；之后的 --after-id 用上一批输出的 nextAfterId）
 *   tsx scripts/l10n/repair-template-tkd.ts --template-key=system-default-de-v1 --limit=200 \
 *     --execution-manifest=/abs/de-exec.json --cursor-file=/abs/de-round1-cursor.json
 *   tsx scripts/l10n/repair-template-tkd.ts --template-key=system-default-de-v1 --locale=de --limit=200 \
 *     --execution-manifest=/abs/de-exec.json --cursor-file=/abs/de-round1-cursor.json \
 *     --expected-count=<预演的 changedCount> --backup=/abs/de-round1-batch1.json \
 *     --operator=<执行人> --reason="<批准编号/理由>" --apply
 *   # 5. 回滚一批（只在文章当前值仍等于回写后的值时才回滚）
 *   tsx scripts/l10n/repair-template-tkd.ts --restore-from=/abs/de-round1-batch1.json --expected-count=<篇数> \
 *     --operator=<执行人> --reason="<理由>" --apply
 *
 * 任何写文件的参数（备份、`--manifest`、排除清单、执行清单）都是独占创建：目标已存在就报错，
 * 不会覆盖上一批的文件——续跑确认文件因此天然按轮次/批次隔离，不要复用文件名。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { SITE_LOCALES } from "../../src/lib/locale/locale-canonical";
import {
  TEMPLATE_TKD_MAX_BATCH_LIMIT,
  assertTemplateTkdScopeArgs,
  generateTemplateTkdExclusionFile,
  generateTemplateTkdExecutionManifest,
  loadTemplateTkdDbRole,
  runTemplateTkdRepair,
  runTemplateTkdRestore,
  type TemplateTkdDb,
  type TemplateTkdRepairOptions,
} from "../../src/server/article-templates/tkd-repair";

export type RepairTemplateTkdCommand =
  | { kind: "help" }
  | { kind: "list"; locales: string[] }
  | { kind: "generate-exclusion-file"; templateKey: string; templateVersion: number; outPath: string }
  | { kind: "generate-execution-manifest"; templateKey: string; templateVersion: number; outPath: string; excludeFilePath?: string }
  | { kind: "restore"; backupPath: string; expectedCount?: number; apply: boolean; operator?: string; reason?: string; requestId?: string }
  | { kind: "repair"; options: TemplateTkdRepairOptions };

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

/** `--name=value` 或 `--name value`。 */
function argValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function integerArg(argv: readonly string[], name: string): number | undefined {
  const raw = argValue(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function printRepairTemplateTkdHelp(): string {
  return `Template TKD repair CLI (metaTitle/metaDescription only; dry-run by default)

  --list --locales=en,ja
  --template-key=<key> [--template-version=1] --all-linked                     (dry-run only)
  --template-key=<key> --limit=<1..${TEMPLATE_TKD_MAX_BATCH_LIMIT}> [--after-id=<uuid>] ...             (one batch)
  --template-key=<key> --article-ids=<uuid,uuid,...>                          (<= ${TEMPLATE_TKD_MAX_BATCH_LIMIT} ids)
  --template-key=<key> --generate-exclusion-file=/abs/exclude.json
  --template-key=<key> --generate-execution-manifest --execution-manifest=/abs/exec.json [--exclude-article-ids-file=/abs/exclude.json]
  apply: --locale=<l> --expected-count=<n> --backup=/abs/backup.json --operator=<who> --reason=<why>
         --execution-manifest=/abs/exec.json --cursor-file=/abs/cursor.json --apply
  --restore-from=/abs/backup.json --expected-count=<n> --operator=<who> --reason=<why> --apply
  --manifest=/abs/changes.json   (any mode: write the full before/after change list)
`;
}

export function parseRepairTemplateTkdArgs(argv: readonly string[]): RepairTemplateTkdCommand {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h") || argv.length === 0) return { kind: "help" };

  if (hasFlag(argv, "--list")) {
    const raw = argValue(argv, "--locales");
    if (!raw) throw new Error("--list requires --locales=<comma-separated locales>");
    const locales = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
    const unsupported = locales.filter((locale) => !(SITE_LOCALES as readonly string[]).includes(locale));
    if (unsupported.length > 0) throw new Error(`Unsupported locales: ${unsupported.join(", ")}`);
    return { kind: "list", locales };
  }

  const restoreFrom = argValue(argv, "--restore-from");
  if (restoreFrom !== undefined) {
    return {
      kind: "restore",
      backupPath: restoreFrom,
      expectedCount: integerArg(argv, "--expected-count"),
      apply: hasFlag(argv, "--apply"),
      operator: argValue(argv, "--operator"),
      reason: argValue(argv, "--reason"),
      requestId: argValue(argv, "--request-id"),
    };
  }

  const templateKey = argValue(argv, "--template-key");
  if (!templateKey) throw new Error("Missing --template-key=<templateKey> (e.g. system-default-de-v1)");
  const templateVersion = integerArg(argv, "--template-version") ?? 1;

  const generateExclusion = argValue(argv, "--generate-exclusion-file");
  if (generateExclusion !== undefined) {
    return { kind: "generate-exclusion-file", templateKey, templateVersion, outPath: generateExclusion };
  }
  if (hasFlag(argv, "--generate-execution-manifest")) {
    const outPath = argValue(argv, "--execution-manifest");
    if (!outPath) throw new Error("--generate-execution-manifest requires --execution-manifest=<absolute path to write>");
    return { kind: "generate-execution-manifest", templateKey, templateVersion, outPath, excludeFilePath: argValue(argv, "--exclude-article-ids-file") };
  }

  const articleIdsRaw = argValue(argv, "--article-ids");
  const articleIds = articleIdsRaw
    ? [...new Set(articleIdsRaw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))]
    : undefined;
  const limitRaw = argValue(argv, "--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && !Number.isInteger(limit)) throw new Error("--limit must be an integer");
  const scope = {
    allLinked: hasFlag(argv, "--all-linked"),
    afterId: argValue(argv, "--after-id")?.toLowerCase(),
    limit,
    articleIds,
  };
  const apply = hasFlag(argv, "--apply");
  // 范围参数不合法时在连库之前就失败（库函数里还会再校验一次，这里只是更早、更便宜）。
  assertTemplateTkdScopeArgs({ ...scope, apply });
  return {
    kind: "repair",
    options: {
      templateKey,
      templateVersion,
      scope,
      apply,
      locale: argValue(argv, "--locale"),
      expectedCount: integerArg(argv, "--expected-count"),
      backupPath: argValue(argv, "--backup"),
      manifestPath: argValue(argv, "--manifest"),
      operator: argValue(argv, "--operator"),
      reason: argValue(argv, "--reason"),
      requestId: argValue(argv, "--request-id"),
      excludeFilePath: argValue(argv, "--exclude-article-ids-file"),
      executionManifestPath: argValue(argv, "--execution-manifest"),
      cursorFilePath: argValue(argv, "--cursor-file"),
    },
  };
}

async function listTemplates(prisma: PrismaClient, locales: string[]) {
  const templates = await prisma.articleTemplate.findMany({
    where: { locale: { in: locales }, deletedAt: null, applicableArticleType: { in: ["novel_article", "any"] } },
    orderBy: [{ locale: "asc" }, { templateKey: "asc" }, { version: "asc" }],
    select: {
      id: true,
      templateKey: true,
      version: true,
      templateName: true,
      locale: true,
      status: true,
      _count: { select: { articles: { where: { deletedAt: null } } } },
    },
  });
  console.log(JSON.stringify({ mode: "LIST", locales, templates }, null, 2));
}

async function main(): Promise<void> {
  const command = parseRepairTemplateTkdArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(printRepairTemplateTkdHelp());
    return;
  }
  const prisma = new PrismaClient();
  const db = prisma as unknown as TemplateTkdDb;
  try {
    const role = await loadTemplateTkdDbRole(db);
    console.error(`[repair-template-tkd] connected as ${role.currentUser} (article UPDATE=${role.canUpdateArticle}, operation_audit INSERT=${role.canInsertAudit})`);
    switch (command.kind) {
      case "list":
        await listTemplates(prisma, command.locales);
        return;
      case "generate-exclusion-file": {
        const { file, count } = await generateTemplateTkdExclusionFile(db, command);
        console.log(JSON.stringify({ mode: "EXCLUSION_FILE_GENERATED", outPath: command.outPath, templateKey: file.templateKey, count, sha256: file.sha256 }, null, 2));
        return;
      }
      case "generate-execution-manifest": {
        const { manifest, sha256 } = await generateTemplateTkdExecutionManifest(db, command);
        console.log(
          JSON.stringify(
            {
              mode: "EXECUTION_MANIFEST_GENERATED",
              outPath: command.outPath,
              sha256,
              templateKey: manifest.template.templateKey,
              targetCount: manifest.targetArticleIds.count,
              excludedCount: manifest.excludedArticleIds.count,
              createdAtCutoff: manifest.createdAtCutoff,
            },
            null,
            2,
          ),
        );
        return;
      }
      case "restore": {
        const result = await runTemplateTkdRestore(db, command);
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      case "repair": {
        const summary = await runTemplateTkdRepair(db, command.options, (early) => {
          // 有 blocker 时函数会抛错；先把摘要打出来，人才看得到 blockers[]。
          console.log(JSON.stringify(early, null, 2));
        });
        if (summary.mode === "APPLIED") console.log(JSON.stringify({ mode: "APPLIED", ...summary.applied }, null, 2));
        return;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
