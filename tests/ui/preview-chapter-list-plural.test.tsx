import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { PreviewChapterList } from "@/features/public-ui/novel/PreviewChapterList";
import type { PreviewChapterRef } from "@/features/public-ui/types";

/**
 * A3 折中方案（Owner 2026-09-29 修订 D-12 第 2 条，见
 * `docs/adr/ADR-D12-chapter-list-lock-revision.md`）上线后，章节列表区块的
 * 数量说明从 `novel.previewChaptersDescription` 改用 `novel.
 * chapterListCount`（"{count} chapters total"，count = `totalChapterCount`，
 * 不再是可试读章节数），标题也从 `novel.previewChapters`（"Preview
 * chapters"）改成 `novel.chapterListTitle`（"Chapter list"）。
 *
 * 这份用例原本锁的是 `previewChaptersDescription` 的单复数分支（工单
 * 施工工单_I18N_复数能力）；组件不再渲染那个键，改锁新键 `chapterListCount`
 * 的单复数分支——单复数机制本身（ICU plural 经 intl-messageformat 渲染）
 * 没有变化，只是绑定的键换了，理由记在交接回报"测试断言改动"一节。
 *
 * 只测 `chapterListCount` 的单复数分支，不传 `readOnUpstreamHref`——因此
 * 即便 `totalChapterCount` 大于真实章节数也不会触发锁定条目（见
 * `PreviewChapterList.tsx` 的 `hasLocked` 判据），不干扰这里要验证的数字。
 * 锁定条目/展开全部/无推广链接不渲染等用例见
 * `tests/ui/preview-chapter-list-locked.test.tsx`。
 *
 * fr 目录里 `novel.chapterListCount` 目前是英文占位（翻译单尚未派发，见
 * `docs/i18n/ops-seo-round1-copy-manifest.md`），此处不再像原用例那样断言
 * "fr 用 fr 自己的单数键"——占位阶段 fr 的字面值本来就和 en 相同，断言
 * 这一点不能证明本地化正确，只证明占位机制没坏（fr 的 key 集合完整，取值
 * 没有落到 undefined），价值不高，故不重复测；真正的 fr 翻译到位后应该把
 * 这类"逐字锁定 fr 译文"的用例加回来。
 */

function chapters(count: number): PreviewChapterRef[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Chapter ${index + 1}`,
    href: `/dev-preview/novel/${index + 1}`,
  }));
}

describe("PreviewChapterList · chapterListCount 的单复数分支", () => {
  it("count=1 时（en）用单数句，不出现 '1 chapters total'", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(1)} totalChapterCount={1} />);
    expect(screen.getByText("1 chapter total")).toBeTruthy();
    expect(screen.queryByText(/1 chapters total\b/)).toBeNull();
  });

  it("count=2 时（en）用 {count} 复数句", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(2)} totalChapterCount={2} />);
    expect(screen.getByText("2 chapters total")).toBeTruthy();
  });

  it("count=5 时（en）复数句按总章数插值，不是按真实章节数", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(2)} totalChapterCount={5} />);
    expect(screen.getByText("5 chapters total")).toBeTruthy();
  });

  it("标题固定为 'Chapter list'，不是旧的 'Preview chapters'", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(1)} totalChapterCount={1} />);
    expect(screen.getByText("Chapter list")).toBeTruthy();
    expect(screen.queryByText("Preview chapters")).toBeNull();
  });
});
