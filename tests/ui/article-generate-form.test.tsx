import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

vi.mock("@/app/(admin)/articles/_actions", () => ({
  applyArticleGenerateAction: vi.fn(),
  dryRunArticleGenerateAction: vi.fn(),
}));

const { ArticleGenerateForm } = await import(
  "@/app/(admin)/articles/generate/_components/generate-form"
);

const BLOCKED_ID = "11111111-1111-4111-8111-111111111111";
const READY_ID = "22222222-2222-4222-8222-222222222222";

describe("ArticleGenerateForm admission", () => {
  it("keeps blocked novels visible, disables their option, and explains the reason", () => {
    render(<ArticleGenerateForm
      pinned={{ status: "absent" }}
      pageNovels={[
        {
          novelId: BLOCKED_ID,
          title: "Blocked",
          locale: "en",
          businessId: "blocked",
          hasLiveArticle: false,
          promoReady: false,
          promoOutcome: "promo_link_missing",
          canGenerateArticle: false,
          generateBlockedReason: "promo_link_missing",
        },
        {
          novelId: READY_ID,
          title: "Ready",
          locale: "en",
          businessId: "ready",
          hasLiveArticle: false,
          promoReady: true,
          promoOutcome: "ready",
          canGenerateArticle: true,
        },
      ]}
      templates={[]}
      canWrite
    />);
    const blockedOption = screen.getByRole("option", { name: /Blocked.*缺少推广链接/ }) as HTMLOptionElement;
    const readyOption = screen.getByRole("option", { name: /Ready/ }) as HTMLOptionElement;
    expect(blockedOption.disabled).toBe(true);
    expect(readyOption.disabled).toBe(false);
  });

  it("disables both preview and create for a blocked pinned novel", () => {
    render(<ArticleGenerateForm
      pinned={{
        status: "found",
        novel: {
          novelId: BLOCKED_ID,
          title: "Blocked",
          locale: "en",
          businessId: "blocked",
          hasLiveArticle: false,
          promoReady: false,
          promoOutcome: "promo_link_not_ready",
          canGenerateArticle: false,
          generateBlockedReason: "promo_link_not_ready",
        },
      }}
      pageNovels={[]}
      templates={[]}
      canWrite
    />);
    expect(screen.getByText(/生成准入：推广链接未就绪/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "预览计划" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "创建文章" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
