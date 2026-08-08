import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  projectAdminChapterContent,
  projectAdminChapterDetail,
  projectAdminChapterListItem,
  projectAdminContentPage,
  projectAdminNovelDetail,
  projectAdminNovelListItem,
} from "@/contracts";

import {
  chapterContent,
  chapterDetail,
  chapterListItem,
  novelDetail,
  novelListItem,
  page,
  SENTINELS,
} from "./fixtures/admin-content";

/**
 * P2-04 契约的减法验收。
 *
 * kernel 的返回值本身就是可序列化的，所以"直接透传"在类型上永远不会报错——
 * 唯一挡住它的就是这一组断言：投影必须**丢掉**运营内核里那些商业与来源字段，
 * 而不是顺手带出去。
 */

const NOVEL_ITEM = projectAdminNovelListItem(novelListItem());
const NOVEL_DETAIL = projectAdminNovelDetail(novelDetail());
const CHAPTER_ITEM = projectAdminChapterListItem(chapterListItem());
const CHAPTER_DETAIL = projectAdminChapterDetail(chapterDetail());
const CHAPTER_CONTENT = projectAdminChapterContent(chapterContent());

/** kernel 有、但不许出现在任何浏览器可见 DTO 上的字段。 */
const DROPPED_FIELDS = [
  "author",
  "completionStatus",
  "country",
  "region",
  "coverUrl",
  "paidFromChapter",
  "splitRatio",
  "contentHash",
] as const;

function deepKeys(value: unknown, seen = new Set<unknown>()): string[] {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((entry) => deepKeys(entry, seen));
  return Object.entries(value).flatMap(([key, nested]) => [key, ...deepKeys(nested, seen)]);
}

describe("P2-04 契约减法", () => {
  it.each([
    ["书目列表项", NOVEL_ITEM],
    ["书目详情", NOVEL_DETAIL],
    ["章节列表项", CHAPTER_ITEM],
    ["章节详情", CHAPTER_DETAIL],
    ["章节正文", CHAPTER_CONTENT],
  ])("%s 不含任何被刻意丢弃的字段", (_name, projected) => {
    const keys = new Set(deepKeys(projected));
    for (const field of DROPPED_FIELDS) {
      expect(keys.has(field), `DTO 仍然带着 ${field}`).toBe(false);
    }
  });

  it.each([
    ["书目列表项", NOVEL_ITEM],
    ["书目详情", NOVEL_DETAIL],
    ["章节列表项", CHAPTER_ITEM],
    ["章节详情", CHAPTER_DETAIL],
    ["章节正文", CHAPTER_CONTENT],
  ])("%s 的序列化结果不含任何哨兵值", (_name, projected) => {
    const serialized = JSON.stringify(projected);
    for (const [field, sentinel] of Object.entries(SENTINELS)) {
      expect(serialized, `${field} 的哨兵值泄漏进了 DTO`).not.toContain(sentinel);
    }
  });

  it("完整 content_hash 只以 12 位前缀出现", () => {
    expect(CHAPTER_DETAIL.contentHashPrefix).toBe("a1b2c3d4e5f6");
    expect(CHAPTER_CONTENT.contentHashPrefix).toBe("a1b2c3d4e5f6");
    expect(CHAPTER_DETAIL.contentHashPrefix?.length).toBe(12);
  });

  it("只有章节正文 DTO 带 body", () => {
    expect(Object.keys(CHAPTER_CONTENT)).toContain("body");
    for (const projected of [NOVEL_ITEM, NOVEL_DETAIL, CHAPTER_ITEM, CHAPTER_DETAIL]) {
      expect(deepKeys(projected)).not.toContain("body");
    }
    const listPage = projectAdminContentPage(
      page([chapterListItem()]),
      projectAdminChapterListItem,
    );
    expect(JSON.stringify(listPage)).not.toContain("船在午夜离港");
  });

  it("详情与列表共用同一份字段口径", () => {
    for (const key of Object.keys(NOVEL_ITEM)) {
      expect(NOVEL_DETAIL, `详情缺少列表字段 ${key}`).toHaveProperty(key);
    }
    expect(NOVEL_DETAIL.novelId).toBe(NOVEL_ITEM.novelId);
    expect(NOVEL_DETAIL.preview).toEqual(NOVEL_ITEM.preview);
  });

  it("投影结果被冻结，调用方无法回填被丢弃的字段", () => {
    expect(Object.isFrozen(NOVEL_ITEM)).toBe(true);
    expect(Object.isFrozen(NOVEL_DETAIL)).toBe(true);
    expect(Object.isFrozen(CHAPTER_CONTENT)).toBe(true);
    expect(Object.isFrozen(NOVEL_DETAIL.sources)).toBe(true);
  });

  it("策略缺失时给 null，而不是伪造一个 0", () => {
    const noPolicy = projectAdminNovelListItem(
      novelListItem({
        preview: {
          policy: null,
          actualMaterializedChapterCount: 0,
          actualDisplayableChapterCount: 0,
          policyCountMatchesActual: null,
        },
      }),
    );
    expect(noPolicy.preview.policyChapterCount).toBeNull();
    expect(noPolicy.preview.policyCountMatchesActual).toBeNull();
    expect(projectAdminNovelDetail(novelDetail({
      preview: {
        policy: null,
        actualMaterializedChapterCount: 0,
        actualDisplayableChapterCount: 0,
        policyCountMatchesActual: null,
      },
    })).previewPolicy).toBeNull();
  });
});

/**
 * 契约层的运行时零依赖约束（`src/contracts/index.ts` 头注释第 1 条）。
 *
 * `@/server/admin-content` 会 import Prisma；`admin-content.ts` 只能以
 * `import type` 触碰 domain 与 server 层，否则 Prisma 会被拖进浏览器 bundle。
 */
describe("P2-04 契约模块边界", () => {
  it("contracts/admin-content.ts 对 domain 与 server 只有类型导入", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/contracts/admin-content.ts"),
      "utf8",
    );
    const imports = source.match(/^import .*?from ".*?";$/gms) ?? [];
    const runtime = imports.filter(
      (line) => !line.startsWith("import type") && /@\/(domain|lib|server)\//.test(line),
    );
    expect(runtime, `契约层出现了运行时导入：${runtime.join(" / ")}`).toEqual([]);
  });

  it("contracts/errors.ts 引用 kernel 错误码时同样只用类型导入", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/contracts/errors.ts"), "utf8");
    expect(source).toContain('import type { AdminContentQueryErrorCode } from "@/server/admin-content"');
  });
});

/**
 * 内容管理界面的源码扫描，沿用 `admin-secret-boundary` 的做法，但针对本期新增的
 * `(admin)/novels` 与内容 route。
 */
describe("P2-04 内容界面密钥面", () => {
  const FORBIDDEN = [
    "encryptedSecret",
    "encrypted_secret",
    "secretFingerprint",
    "secret_fingerprint",
    "tokenHash",
    "passwordHash",
    "sessionVersion",
    "credentialType",
    "rawPayload",
    "raw_payload",
  ] as const;

  async function sources(root: string): Promise<{ file: string; source: string }[]> {
    const directory = path.resolve(process.cwd(), root);
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return sources(path.relative(process.cwd(), target));
        return /\.tsx?$/.test(entry.name)
          ? [
              {
                file: path.relative(process.cwd(), target),
                source: (await readFile(target, "utf8"))
                  .replace(/\/\*[\s\S]*?\*\//g, " ")
                  .replace(/(^|[^:])\/\/.*$/gm, "$1"),
              },
            ]
          : [];
      }),
    );
    return nested.flat();
  }

  it("(admin)/novels 与内容 route 里不出现任何凭证字段", async () => {
    const files = [
      ...(await sources("src/app/(admin)/novels")),
      ...(await sources("src/app/api/admin/novels")),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const { file, source } of files) {
      for (const field of FORBIDDEN) {
        expect(source, `${file} 出现了 ${field}`).not.toContain(field);
      }
    }
  });

  it("内容界面不引用 Credential 服务", async () => {
    for (const { file, source } of await sources("src/app/(admin)/novels")) {
      expect(source, `${file} 引用了 Credential 服务`).not.toMatch(
        /@\/(server|lib)\/credentials/,
      );
    }
  });
});
