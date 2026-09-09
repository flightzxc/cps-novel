import "./setup-cleanup";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { PreviewChapterList } from "@/features/public-ui/novel/PreviewChapterList";
import type { PreviewChapterRef } from "@/features/public-ui/types";

/**
 * 低危清扫第 1 批 · item D-⑥：`novel.previewChaptersDescription` 在 count=1
 * 时的英文复数缺陷（"1 preview chapter**s**..."）——`t()` 不支持 ICU 复数
 * （`src/lib/locale/messages/index.ts` 的 `{name}` 直替正则），所以
 * `PreviewChapterList.tsx` 改成 count===1 时走专门的单数键
 * `novel.previewChaptersDescriptionOne`，count≥2 仍走原键。
 *
 * 覆盖两侧：真正驱动详情页文案的 `en` 目录，以及至少一个非英文目录（`fr`，
 * 语法数一致性问题最直观）证明单数键确实随 locale 切换、不是英文写死。
 */

function chapters(count: number): PreviewChapterRef[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Chapter ${index + 1}`,
    href: `/dev-preview/novel/${index + 1}`,
  }));
}

describe("PreviewChapterList · previewChaptersDescription 的单复数分支", () => {
  it("count=1 时（en）用单数句，不出现 '1 preview chapters'", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(1)} />);
    expect(screen.getByText("1 preview chapter on this site, provided by the original platform.")).toBeTruthy();
    expect(screen.queryByText(/1 preview chapters\b/)).toBeNull();
  });

  it("count=2 时（en）仍用原有的 {count} 复数句", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(2)} />);
    expect(screen.getByText("2 preview chapters on this site, all provided by the original platform.")).toBeTruthy();
  });

  it("count=5 时（en）复数句按真实章数插值", () => {
    render(<PreviewChapterList locale="en" chapters={chapters(5)} />);
    expect(screen.getByText("5 preview chapters on this site, all provided by the original platform.")).toBeTruthy();
  });

  it("count=1 时（fr）用 fr 的单数键，而不是英文兜底", () => {
    render(<PreviewChapterList locale="fr" chapters={chapters(1)} />);
    expect(
      screen.getByText("1 chapitre d'aperçu sur ce site, fourni par la plateforme d'origine."),
    ).toBeTruthy();
  });

  it("count=3 时（fr）仍用 fr 的 {count} 复数句", () => {
    render(<PreviewChapterList locale="fr" chapters={chapters(3)} />);
    expect(
      screen.getByText("3 chapitres d'aperçu sur ce site, tous fournis par la plateforme d'origine."),
    ).toBeTruthy();
  });
});
