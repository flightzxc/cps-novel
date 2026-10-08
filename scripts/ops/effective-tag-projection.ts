/**
 * Operator CLI for the novel category-membership projection (`novel_effective_tag`, B-38)
 * and the public-list scale trigger (`scale-check`, B-38 第二段).
 * 对应 CPS `scripts/backfill-effective-tags.ts`。规则、锁和只写差异的语义见
 * `src/server/tagging/effective-tag-projection.ts` 的文件头。
 *
 * 什么时候用：
 *   - 发版后验收：`check`，差异必须全为 0（迁移里已经一次建好，不需要回填）；
 *   - 回滚到上一版再前滚之后：回滚期间旧代码不会重算，先 `check`，不为 0 再 `reconcile`；
 *   - 运维脚本直接改过映射 / 标签真源（`scripts/p2-06-5-production/tagging-bootstrap.ts` 等）之后：
 *     必须 `reconcile` 一次——它们绕过了"同事务重算"的写入点；
 *   - 怀疑有漏掉的写入点：站点地图每次刷新前的检查日志（`effective_tag_check`）不为 0/0/0 时。
 *   - 每次发版前：`scale-check`（见下）。
 *
 * 在 worker 层执行（`worker_app` 对投影表有读写删权限）：
 *
 * Read-only check (the default). Prints one summary line, and up to 20 sample rows per kind.
 * Exit 0 only when there is no difference; exit 3 otherwise:
 *   npx tsx scripts/ops/effective-tag-projection.ts
 *   npx tsx scripts/ops/effective-tag-projection.ts check
 *     -> EFFECTIVE_TAG_CHECK missing=<n> extra=<n> changed=<n>
 *
 * Full reconcile (writes only the differences, one transaction, exclusive advisory lock).
 * Without BOTH `--apply` and the exact confirmation phrase this is read-only — it just runs `check`:
 *   npx tsx scripts/ops/effective-tag-projection.ts reconcile --apply \
 *     --confirm RECONCILE-EFFECTIVE-TAGS
 *     -> EFFECTIVE_TAG_RECONCILE inserted=<n> updated=<n> deleted=<n> ms=<n>
 *        EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0      (re-checked after the write)
 *
 * Scale trigger (read-only; 发版检查清单用，方案 4.7). Computes the per-locale-per-category count matrix
 * (the same query the footer/sitemap use) and compares it with the thresholds in `src/lib/site/public-list.ts`
 * (`PUBLIC_LIST_SCALE_THRESHOLDS`: any category in any locale above 40,000 visible books, or any locale above
 * 60,000 visible books in total). Exit 0 when under, 3 when exceeded — then public list pagination must move
 * from OFFSET to keyset paging before release:
 *   npx tsx scripts/ops/effective-tag-projection.ts scale-check
 *     -> PUBLIC_LIST_SCALE_CHECK exceeded=<true|false> max_category_count=<n> max_locale_total=<n> \
 *        category_threshold=40000 locale_threshold=60000
 *        PUBLIC_LIST_SCALE_EXCEEDED kind=category locale=<l> slug=<s> count=<n>   (one line per offender)
 *        PUBLIC_LIST_SCALE_EXCEEDED kind=locale locale=<l> total=<n>
 *
 * 不打印连接串、密钥或任何环境变量。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  evaluatePublicListScale,
  queryPublicCategoryCounts,
  type PublicListScaleReport,
} from "../../src/lib/site/public-list";
import {
  checkEffectiveTags,
  reconcileAllEffectiveTags,
  type EffectiveTagCheckResult,
} from "../../src/server/tagging/effective-tag-projection";

export const EFFECTIVE_TAG_RECONCILE_CONFIRM_PHRASE = "RECONCILE-EFFECTIVE-TAGS";

/** 退出码：0 无差异 / 已对账且复查为零 / 规模未超阈值；3 有差异 / 规模超阈值；64 参数错误或运行失败。 */
export const EFFECTIVE_TAG_EXIT = Object.freeze({ clean: 0, differences: 3, failure: 64 });

export type EffectiveTagOpsArgs =
  | Readonly<{ mode: "check" }>
  | Readonly<{ mode: "scale-check" }>
  | Readonly<{ mode: "reconcile"; apply: boolean }>;

export function parseEffectiveTagOpsArgs(argv: readonly string[]): EffectiveTagOpsArgs {
  const positional = argv.filter((arg, index) => !arg.startsWith("--") && argv[index - 1] !== "--confirm");
  const command = positional[0] ?? "check";
  if (positional.length > 1) throw new Error("effective_tag_ops_too_many_arguments");
  if (command === "check") return { mode: "check" };
  if (command === "scale-check") return { mode: "scale-check" };
  if (command !== "reconcile") throw new Error("effective_tag_ops_unknown_command");
  const confirmIndex = argv.indexOf("--confirm");
  const confirmed = confirmIndex >= 0 && argv[confirmIndex + 1] === EFFECTIVE_TAG_RECONCILE_CONFIRM_PHRASE;
  return { mode: "reconcile", apply: argv.includes("--apply") && confirmed };
}

function checkLines(result: EffectiveTagCheckResult): string[] {
  return [
    `EFFECTIVE_TAG_CHECK missing=${result.missing} extra=${result.extra} changed=${result.changed}`,
    ...result.samples.map(
      (sample) => `EFFECTIVE_TAG_CHECK_SAMPLE kind=${sample.kind} novel_id=${sample.novelId} canonical_tag_id=${sample.canonicalTagId}`,
    ),
  ];
}

function isClean(result: EffectiveTagCheckResult): boolean {
  return result.missing === 0 && result.extra === 0 && result.changed === 0;
}

function scaleLines(report: PublicListScaleReport): string[] {
  return [
    `PUBLIC_LIST_SCALE_CHECK exceeded=${report.exceeded} max_category_count=${report.maxCategoryCount} max_locale_total=${report.maxLocaleTotal} category_threshold=${report.thresholds.perCategoryPerLocale} locale_threshold=${report.thresholds.perLocaleTotal}`,
    ...report.categories.map(
      (item) => `PUBLIC_LIST_SCALE_EXCEEDED kind=category locale=${item.locale} slug=${item.slug} count=${item.count}`,
    ),
    ...report.locales.map((item) => `PUBLIC_LIST_SCALE_EXCEEDED kind=locale locale=${item.locale} total=${item.total}`),
  ];
}

export async function runEffectiveTagOps(
  db: PrismaClient,
  args: EffectiveTagOpsArgs,
  clock: () => number = () => performance.now(),
): Promise<Readonly<{ exitCode: number; lines: readonly string[]; stderr: readonly string[] }>> {
  if (args.mode === "scale-check") {
    const report = evaluatePublicListScale(await queryPublicCategoryCounts(db));
    return {
      exitCode: report.exceeded ? EFFECTIVE_TAG_EXIT.differences : EFFECTIVE_TAG_EXIT.clean,
      lines: scaleLines(report),
      stderr: [],
    };
  }
  if (args.mode === "check" || !args.apply) {
    const result = await checkEffectiveTags(db);
    return {
      exitCode: isClean(result) ? EFFECTIVE_TAG_EXIT.clean : EFFECTIVE_TAG_EXIT.differences,
      lines: checkLines(result),
      stderr: args.mode === "reconcile" ? ["effective_tag_reconcile_not_confirmed: ran the read-only check instead"] : [],
    };
  }
  const startedAt = clock();
  const summary = await reconcileAllEffectiveTags(db);
  const ms = Math.round(clock() - startedAt);
  const after = await checkEffectiveTags(db);
  return {
    exitCode: isClean(after) ? EFFECTIVE_TAG_EXIT.clean : EFFECTIVE_TAG_EXIT.differences,
    lines: [
      `EFFECTIVE_TAG_RECONCILE inserted=${summary.inserted} updated=${summary.updated} deleted=${summary.deleted} ms=${ms}`,
      ...checkLines(after),
    ],
    stderr: [],
  };
}

async function main(): Promise<void> {
  const args = parseEffectiveTagOpsArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const { exitCode, lines, stderr } = await runEffectiveTagOps(db, args);
    for (const line of lines) console.log(line);
    for (const line of stderr) console.error(line);
    process.exitCode = exitCode;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "effective_tag_ops_failed");
    process.exitCode = EFFECTIVE_TAG_EXIT.failure;
  });
}
