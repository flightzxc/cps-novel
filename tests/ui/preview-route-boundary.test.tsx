import "./setup-cleanup";
import { describe, expect, it, vi } from "vitest";

import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import {
  MOCK_PREVIEW_CHAPTER_TOTAL,
  getMockChapterView,
} from "@/features/public-ui/fixtures/mock-content";

/**
 * DEV_PREVIEW 章节路由的边界（P1-11 交付物 ⑤ 与 SEO 纪律）。
 *
 * `chapter-navigation.test.tsx` 验的是 fixture 与组件：`getMockChapterView(0)`
 * 返回 null、上下章互为逆操作。**没有任何用例加载过路由模块本身**——于是
 * "非规范章号走 404""noindex/nofollow""不设 canonical"这三条至今只写在
 * 注释里。这里直接执行 `page.tsx` / `layout.tsx` 的导出来验。
 *
 * `notFound()` 在 Next 里靠抛特殊错误中断渲染；这里换成一个可识别的哨兵，
 * 用例才能区分"调了 notFound"和"抛了别的错"。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

const routeModule = await import("@/app/dev-preview/chapter/[chapterNumber]/page");
const layoutModule = await import("@/app/dev-preview/chapter/layout");
const previewLayoutModule = await import("@/app/dev-preview/layout");
const rootLayoutModule = await import("@/app/layout");

const ChapterPreviewPage = routeModule.default;

/** 渲染这一章：返回渲染结果，或 "NOT_FOUND"。 */
async function visit(chapterNumber: string): Promise<"NOT_FOUND" | { type: unknown; props: never }> {
  try {
    return (await ChapterPreviewPage({
      params: Promise.resolve({ chapterNumber }),
    })) as unknown as { type: unknown; props: never };
  } catch (error) {
    if (error === NOT_FOUND) return "NOT_FOUND";
    throw error;
  }
}

async function metadataFor(chapterNumber: string) {
  return routeModule.generateMetadata({ params: Promise.resolve({ chapterNumber }) });
}

describe("章节预览路由 · 章号规范化", () => {
  it("每一章都各自可达，渲染的是阅读屏且章号对得上", async () => {
    for (let n = 1; n <= MOCK_PREVIEW_CHAPTER_TOTAL; n += 1) {
      const result = await visit(String(n));
      expect(result, `第 ${n} 章应当可达`).not.toBe("NOT_FOUND");
      const element = result as { type: unknown; props: { chapter: { number: number } } };
      expect(element.type).toBe(ChapterScreen);
      expect(element.props.chapter.number).toBe(n);
    }
  });

  it("越界章号走 404，而不是渲染一个空壳", async () => {
    for (const value of ["0", String(MOCK_PREVIEW_CHAPTER_TOTAL + 1), "999999"]) {
      expect(await visit(value), `${value} 应当 404`).toBe("NOT_FOUND");
    }
  });

  it.each([
    ["01", "前导零"],
    ["001", "多个前导零"],
    ["1.0", "小数写法"],
    ["1e0", "科学计数法"],
    ["+1", "带正号"],
    [" 1", "前导空格"],
    ["1 ", "尾随空格"],
    ["0x1", "十六进制"],
    ["1abc", "数字后缀垃圾"],
    ["", "空串"],
    ["-1", "负数"],
    ["１", "全角数字"],
    ["١", "阿拉伯-印度数字"],
    ["Ⅰ", "罗马数字"],
    ["Infinity", "Infinity"],
  ])("非规范章号 %s（%s）走 404——同一章不能有第二个可访问地址", async (value) => {
    // 这些写法里有好几个 Number() 都会解析成 1；只要放行任意一个，
    // 第 1 章就会同时挂在两个 URL 上，正式化后直接变成重复内容。
    expect(await visit(value)).toBe("NOT_FOUND");
  });

  it("generateStaticParams 只预生成真实存在的章号，且都是规范十进制", () => {
    const params = routeModule.generateStaticParams();
    expect(params).toEqual(
      Array.from({ length: MOCK_PREVIEW_CHAPTER_TOTAL }, (_, index) => ({
        chapterNumber: String(index + 1),
      })),
    );
    for (const { chapterNumber } of params) {
      expect(chapterNumber).toMatch(/^[1-9]\d*$/);
      expect(getMockChapterView(Number(chapterNumber))).not.toBeNull();
    }
  });
});

describe("章节预览路由 · robots 与 canonical", () => {
  it("每一章的元数据都是 noindex,nofollow", async () => {
    for (let n = 1; n <= MOCK_PREVIEW_CHAPTER_TOTAL; n += 1) {
      const metadata = await metadataFor(String(n));
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
  });

  it("🔴 不设 canonical——DEV_PREVIEW 不是正式章节页，self-canonical 等 D-8", async () => {
    const metadata = await metadataFor("1");
    expect(metadata.alternates).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain("canonical");
  });

  it("标题逐章不同，客户端切章时元数据不会停在第一章", async () => {
    const first = await metadataFor("1");
    const second = await metadataFor("2");
    expect(first.title).not.toBe(second.title);
    expect(String(first.title)).toContain("第 1 章");
    expect(String(second.title)).toContain("第 2 章");
  });

  it("章号不存在时标题降级但仍然 noindex——404 页面也不能被收录", async () => {
    const metadata = await metadataFor(String(MOCK_PREVIEW_CHAPTER_TOTAL + 1));
    expect(metadata.title).toBe("章节不存在");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("三层布局各自显式声明 noindex，改一层不等于放开索引", () => {
    for (const [name, metadata] of [
      ["根布局", rootLayoutModule.metadata],
      ["dev-preview 布局", previewLayoutModule.metadata],
      ["章节布局", layoutModule.metadata],
    ] as const) {
      expect(metadata.robots, `${name} 必须显式 noindex`).toEqual({ index: false, follow: false });
      expect(JSON.stringify(metadata), `${name} 不该有 canonical`).not.toContain("canonical");
    }
  });
});

describe("章节预览路由 · 阅读设置跨章存活的结构前提", () => {
  it("Provider 挂在 [chapterNumber] 之上的 layout 里，切兄弟路由时不重挂", () => {
    // 挂进页面就做不到跨章存活：切章会重挂 Provider，设置回默认值。
    // `reader-no-flash.test.tsx` 从源码验过防闪脚本的排序与内容；这里执行 layout
    // 本身，验它实际产出的节点身份——注释与实现漂移时源码扫描发现不了。
    const tree = layoutModule.default({ children: "CHILDREN" }) as {
      props: { children: readonly { type: unknown; props: Record<string, unknown> }[] };
    };
    const [script, provider] = tree.props.children;

    expect(script.type).toBe("script");
    expect(script.props.dangerouslySetInnerHTML).toBeDefined();
    expect(provider.type).toBe(ReaderSettingsProvider);
    expect(provider.props.children).toBe("CHILDREN");
  });
});
