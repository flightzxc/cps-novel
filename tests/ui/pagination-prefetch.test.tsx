import "./setup-cleanup";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { Pagination } from "@/features/public-ui/collection/Pagination";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";

import { PaginationBeforePn15 } from "../fixtures/pagination-before-pn15";

/**
 * PN-15：`Pagination` 加了可选 `prefetch`。
 *  - 不传时行为与改动前**逐字节一致**（浏览 / 分类 / 博客列表在网址冻结下翻页链接一字不差）；
 *  - 传 `false` 时两个翻页 `Link` 都带 `prefetch={false}`（搜索结果页用，免得浏览器后台多跑一次搜索查询）。
 */

const linkProps: Array<Record<string, unknown>> = [];

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      linkProps.push({ ...props });
      const { href, children, className } = props as { href: string; children?: React.ReactNode; className?: string };
      return React.createElement("a", { href, className }, children);
    },
  };
});

function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const CASES = [
  { name: "全部作品页", basePath: "/browse", searchParams: undefined },
  { name: "全部作品页·带分类", basePath: "/browse", searchParams: { category: "romance" } },
  { name: "分类页", basePath: "/category/female-audience", searchParams: undefined },
  { name: "博客列表", basePath: "/blog", searchParams: undefined },
  { name: "非英语·全部作品页", basePath: "/ja/browse", searchParams: undefined },
] as const;

describe("不传 prefetch：与改动前逐字节一致", () => {
  for (const locale of SITE_LOCALES) {
    for (const { name, basePath, searchParams } of CASES) {
      for (const [currentPage, totalPages] of [[1, 1], [1, 3], [2, 3], [3, 3], [2, 2]] as const) {
        it(`${locale} · ${name} · ${currentPage}/${totalPages}`, () => {
          const now = html(<Pagination locale={locale} currentPage={currentPage} totalPages={totalPages} basePath={basePath} searchParams={searchParams} />);
          const before = html(<PaginationBeforePn15 locale={locale} currentPage={currentPage} totalPages={totalPages} basePath={basePath} searchParams={searchParams} />);
          expect(now).toBe(before);
        });
      }
    }
  }

  it("不传时两个 Link 的 props 里根本没有 prefetch 这个键（不是 undefined，是没有）", () => {
    linkProps.length = 0;
    render(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/browse" />);
    expect(linkProps).toHaveLength(2);
    for (const props of linkProps) expect("prefetch" in props).toBe(false);
  });

  it("翻页链接的 href 钉死（浏览 / 分类 / 博客）", () => {
    const hrefs = (node: React.ReactElement) => [...html(node).matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
    expect(hrefs(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/browse" />)).toEqual(["/browse", "/browse?page=3"]);
    expect(hrefs(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/browse" searchParams={{ category: "romance" }} />)).toEqual([
      "/browse?category=romance",
      "/browse?category=romance&page=3",
    ]);
    expect(hrefs(<Pagination locale="ja" currentPage={1} totalPages={2} basePath="/ja/blog" />)).toEqual(["/ja/blog?page=2"]);
  });

  it("浏览 / 分类 / 博客列表三个调用点的源码里没有 prefetch", () => {
    for (const file of ["browse.tsx", "category.tsx", "blog-list.tsx"]) {
      const source = readFileSync(path.resolve(import.meta.dirname, "../../src/app/_pages", file), "utf8");
      const calls = source.match(/<Pagination[\s\S]*?\/>/g) ?? [];
      expect(calls.length, `${file} 里应有 <Pagination`).toBeGreaterThan(0);
      for (const call of calls) expect(call).not.toContain("prefetch");
    }
  });
});

describe("传 prefetch", () => {
  it("false：上一页、下一页两个 Link 都带 prefetch=false", () => {
    linkProps.length = 0;
    render(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/search" searchParams={{ q: "alpha" }} prefetch={false} />);
    expect(linkProps).toHaveLength(2);
    expect(linkProps.map((props) => props.prefetch)).toEqual([false, false]);
    expect(linkProps.map((props) => props.href)).toEqual(["/search?q=alpha", "/search?q=alpha&page=3"]);
  });

  it("true 原样透传", () => {
    linkProps.length = 0;
    render(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/browse" prefetch />);
    expect(linkProps.map((props) => props.prefetch)).toEqual([true, true]);
  });

  it("传不传 prefetch，渲染出的 HTML 相同（prefetch 不进 DOM 属性）", () => {
    const withFalse = html(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/search" searchParams={{ q: "alpha" }} prefetch={false} />);
    const without = html(<Pagination locale="en" currentPage={2} totalPages={3} basePath="/search" searchParams={{ q: "alpha" }} />);
    expect(withFalse).toBe(without);
  });

  it("搜索结果页的调用点传了 prefetch={false}", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../../src/features/public-ui/search/SearchScreen.tsx"), "utf8");
    expect(source).toMatch(/<Pagination[\s\S]*?prefetch=\{false\}[\s\S]*?\/>/);
  });
});
