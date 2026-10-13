/**
 * 同名去重（v0.6.0，Owner 10-14 拍板第 3 项）：口令码模式剧场（PlotNovel）的书，如果存在
 * **同语种、同规范化书名**的、属于其它（可直接跳转的）剧场的书（MoboReader），就不生成文章——
 * 只保留 MoboReader 那一份。MoboReader 能直接跳转阅读，转化更好；也避免出现两篇近似重复的文章。
 *
 * 只影响"生成候选"（后台批量生成的候选行、入队准入、批量生成任务的枚举），**不改任何已存在的数据**：
 * 已经生成过的文章不会被撤回，书也不会被下架或合并。
 *
 * 规范化沿用换小说功能的口径：`normalizeNovelTitle`（NFKC、小写、去引号、标点变空格、折叠空白——
 * CPS `normalizeName` 的逐字移植，`src/lib/novel/novel-identity.ts`），库里对应列 `novel.title_normalized`
 * （索引 `(locale, title_normalized)`）。这一列对回填之前的老书可能是 NULL，所以：
 *   - 口令码模式一侧（要判定的书）直接用书名现算，不依赖这一列；
 *   - 对侧（其它剧场的书）优先按列匹配；列为 NULL 的行退一步按"书名忽略大小写相等"取回候选，再用同一个函数
 *     现算比对。书名只差标点、且对侧列为 NULL 的极少数书会漏判——运维手册要求改挂前先跑回填脚本，把 NULL 清零。
 *
 * 规则的是"对侧在其它（非口令码）剧场下存在"，而不是写死 `moboreader` 这个名字——和 K2 的"领取闸只认数据库、
 * 不留写死名单"同一个纪律；后台文案按拍板措辞写作"MoboReader 已有同名书"。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { normalizeNovelTitle } from "@/lib/novel/novel-identity";
import { loadCodeModeChannelAppIds } from "@/server/publication/code-mode-theaters";

type Db = Pick<PrismaClient, "channelApp" | "novel"> | Pick<Prisma.TransactionClient, "channelApp" | "novel">;

export type DuplicateProbe = Readonly<{ id: string; locale: string; title: string }>;

const CHUNK_SIZE = 200;

function key(locale: string, normalized: string): string {
  return `${locale}\u0000${normalized}`;
}

/** 返回 `candidates` 里"在其它非口令码剧场下存在同语种同规范化书名的书"的编号集合。 */
export async function findDuplicatesInLinkTheaters(
  db: Db,
  candidates: readonly DuplicateProbe[],
): Promise<Set<string>> {
  const duplicates = new Set<string>();
  if (candidates.length === 0) return duplicates;
  const codeModeIds = await loadCodeModeChannelAppIds(db);

  for (let offset = 0; offset < candidates.length; offset += CHUNK_SIZE) {
    const chunk = candidates.slice(offset, offset + CHUNK_SIZE)
      .map((candidate) => ({ ...candidate, normalized: normalizeNovelTitle(candidate.title) }))
      .filter((candidate) => candidate.normalized.length > 0);
    if (chunk.length === 0) continue;

    const byLocale = new Map<string, typeof chunk>();
    for (const candidate of chunk) byLocale.set(candidate.locale, [...(byLocale.get(candidate.locale) ?? []), candidate]);
    const where: Prisma.NovelWhereInput = {
      deletedAt: null,
      id: { notIn: chunk.map((candidate) => candidate.id) },
      sourceItems: { some: { deletedAt: null, channelAppId: { notIn: codeModeIds } } },
      OR: [...byLocale].flatMap(([locale, group]) => [
        { locale, titleNormalized: { in: group.map((candidate) => candidate.normalized) } },
        { locale, titleNormalized: null, title: { in: group.map((candidate) => candidate.title), mode: "insensitive" as const } },
      ]),
    };
    const rows = await db.novel.findMany({ where, select: { locale: true, title: true, titleNormalized: true } });
    const existing = new Set(rows.map((row) => key(row.locale, row.titleNormalized ?? normalizeNovelTitle(row.title))));
    for (const candidate of chunk) {
      if (existing.has(key(candidate.locale, candidate.normalized))) duplicates.add(candidate.id);
    }
  }
  return duplicates;
}
