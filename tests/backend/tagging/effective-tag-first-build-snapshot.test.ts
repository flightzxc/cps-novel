/**
 * B-38：迁移 `20261009120000_b38_novel_effective_tag` 里的"首次建表"段（B38_FIRST_BUILD_BEGIN/END）
 * 必须是 `buildEffectiveTagFirstBuildSql()`（src/server/tagging/effective-tag-projection.ts）的逐字快照
 * ——空白归一后相等。规则只在 effective-tag-projection.ts 里定义一次；迁移里这一份是它的快照，
 * 改规则必须两处同改，否则这条用例变红。
 * 结果层面的一致（迁移段 vs reconcileAllEffectiveTags 逐行相等）由真实库用例
 * `tests/integration/tagging/effective-tag-projection-postgres.test.ts` 证明。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEffectiveTagFirstBuildSql } from "@/server/tagging/effective-tag-projection";

const root = path.resolve(import.meta.dirname, "../../..");
const migrationPath = path.join(root, "prisma/migrations/20261009120000_b38_novel_effective_tag/migration.sql");
const migration = readFileSync(migrationPath, "utf8");

export function extractFirstBuildSegment(sql: string): string {
  const begin = sql.indexOf("-- B38_FIRST_BUILD_BEGIN");
  const end = sql.indexOf("-- B38_FIRST_BUILD_END");
  if (begin < 0 || end < 0 || end < begin) throw new Error("B38_FIRST_BUILD markers missing");
  return sql.slice(begin + "-- B38_FIRST_BUILD_BEGIN".length, end).trim();
}

const squash = (sql: string) => sql.replace(/\s+/g, " ").replace(/\s*;\s*$/, "").trim();

describe("B-38 migration · 首次建表段是规则 SQL 的逐字快照", () => {
  it("标记各出现一次，且 BEGIN 在 END 之前", () => {
    expect(migration.match(/-- B38_FIRST_BUILD_BEGIN/g)).toHaveLength(1);
    expect(migration.match(/-- B38_FIRST_BUILD_END/g)).toHaveLength(1);
  });

  it("空白归一后与 buildEffectiveTagFirstBuildSql() 相等", () => {
    expect(squash(extractFirstBuildSegment(migration))).toBe(squash(buildEffectiveTagFirstBuildSql()));
  });

  it("快照段是一条完整语句（以分号结尾），不含绑定变量", () => {
    const segment = extractFirstBuildSegment(migration);
    expect(segment.trimEnd().endsWith(";")).toBe(true);
    expect(segment).not.toMatch(/\$\d/);
  });

  it("迁移只新增：建表、两个索引、两个外键、两个 CHECK、一个部分索引，不碰任何旧表的列/约束", () => {
    const statements = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements.match(/^CREATE TABLE /gm)).toEqual(["CREATE TABLE "]);
    expect(statements).toContain('CREATE TABLE "novel_effective_tag"');
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/ALTER TABLE "(?!novel_effective_tag")/);
    expect(statements).toContain("novel_effective_tag_provenance_check");
    expect(statements).toContain("novel_effective_tag_rank_check");
    expect(statements).toContain('CREATE INDEX "article_public_list_order_idx"');
    expect(statements).toMatch(
      /ON "article" \("locale", "published_at" DESC, "id"\)\s+WHERE "status" = 'published' AND "deleted_at" IS NULL AND "article_type" = 'novel_article'/,
    );
  });
});
