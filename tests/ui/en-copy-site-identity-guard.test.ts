import { describe, expect, it } from "vitest";

import { en } from "@/lib/locale/messages/en";

/**
 * C（Owner 2026-09-29 拍板"按运营原文做"）守卫：`en` 目录（公开文案的英文
 * 原文，其它 14 语种由后续翻译单处理）里不得出现"本网站/this site"、
 * "原网站/原平台/original platform/source platform"、"预览/preview"及同义
 * 表述——按本站就是官方站点处理，不做"本站只是导流入口"的声明。
 *
 * 新增用例（交接文档"测试与门禁"一节要求）。变异①：给任意一个键的值加回
 * "this site" 必须让这条用例变红，证明它真的在守——见交接回报里的变异记录。
 *
 * 允许的例外逐条登记，且必须附理由——不是随手加白名单：目前没有例外。
 * 任何新增的含"preview"字样的键都应该先看是不是真的要面向用户展示"预览"
 * 这个概念，还是可以换一种不提它的说法（参照本轮 A3/C 的处理方式）。
 */
const ALLOWED_EXCEPTIONS: ReadonlySet<string> = new Set([]);

const BANNED_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "this site", pattern: /this site/i },
  { name: "original platform", pattern: /original platform/i },
  { name: "source platform", pattern: /source platform/i },
  { name: "preview", pattern: /preview/i },
];

function flattenLeaves(node: unknown, prefix: string[] = []): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      for (const [path, leaf] of flattenLeaves(value, [...prefix, key])) {
        out.set(path, leaf);
      }
    }
    return out;
  }
  out.set(prefix.join("."), node);
  return out;
}

describe("en 公开文案守卫 · 不提本站/原平台/预览（C，Owner 2026-09-29）", () => {
  it("每一条英文文案都不含 this site / original platform / source platform / preview（大小写不敏感）", () => {
    const leaves = flattenLeaves(en);
    const offenders: string[] = [];
    for (const [key, value] of leaves) {
      if (typeof value !== "string") continue;
      if (ALLOWED_EXCEPTIONS.has(key)) continue;
      for (const { name, pattern } of BANNED_PATTERNS) {
        if (pattern.test(value)) {
          offenders.push(`${key}: contains "${name}" — "${value}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("允许例外清单本身没有游离条目——每个例外键必须真的存在于 en 目录里", () => {
    const leaves = flattenLeaves(en);
    for (const key of ALLOWED_EXCEPTIONS) {
      expect(leaves.has(key), `${key} 不是 en 目录里的真实键`).toBe(true);
    }
  });
});
