import { describe, expect, it } from "vitest";

import { selectHomepageNavCategories } from "@/lib/site/home-nav";

/**
 * v0.5.15 首页题材导航的选择规则（纯函数）。
 *
 * 前台首页那一排 = 运营勾选的 且 该语种有书的分类。"有书"那一半由 `listPublicCategories` 给出，
 * 这里只钉"勾选"那一半：只留 `homepageVisible === true`、顺序不变、全 false 为空且不回退、全 true 原样。
 * 页脚与详情页可链接集合不经过这个函数（见 `category-link-set-equality.test.ts` 与 `home-nav-curation.test.tsx`）。
 */

const tag = (slug: string, homepageVisible: boolean) => ({ slug, label: slug.toUpperCase(), href: `/category/${slug}`, homepageVisible });

describe("selectHomepageNavCategories", () => {
  it("只保留 homepageVisible 为 true 的项，并保持调用方给的顺序（H3：不重排）", () => {
    const input = [tag("zeta", true), tag("alpha", false), tag("mid", true), tag("beta", false), tag("omega", true)];
    expect(selectHomepageNavCategories(input).map((item) => item.slug)).toEqual(["zeta", "mid", "omega"]);
  });

  it("全是 false：返回空数组，不回退成全部（H4）", () => {
    expect(selectHomepageNavCategories([tag("a", false), tag("b", false)])).toEqual([]);
    expect(selectHomepageNavCategories([])).toEqual([]);
  });

  it("全是 true：与输入逐项相同（同一批对象引用，顺序一致）", () => {
    const input = [tag("b", true), tag("a", true), tag("c", true)];
    const output = selectHomepageNavCategories(input);
    expect(output).toEqual(input);
    output.forEach((item, index) => expect(item).toBe(input[index]));
  });

  it("不改输入数组，也不改各项（项里的 href / label 一个字符都不变，H9）", () => {
    const input = Object.freeze([Object.freeze(tag("a", true)), Object.freeze(tag("b", false))]);
    const snapshot = JSON.stringify(input);
    const output = selectHomepageNavCategories(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(output[0]).toBe(input[0]);
    expect(output[0]!.href).toBe("/category/a");
  });

  it("字段缺失（undefined）当作未勾选：宁可少显示，也不误显示", () => {
    const missing = { slug: "x", label: "X", href: "/category/x" } as unknown as ReturnType<typeof tag>;
    expect(selectHomepageNavCategories([missing, tag("y", true)]).map((item) => item.slug)).toEqual(["y"]);
  });

  it("保留项上的其余字段（泛型透传）", () => {
    const rich = { ...tag("a", true), id: "id-1", sortOrder: 7 };
    expect(selectHomepageNavCategories([rich])[0]).toEqual({ ...rich });
  });
});
