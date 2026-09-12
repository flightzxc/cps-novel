import "./setup-cleanup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RebindCandidate, RebindView } from "@/app/(admin)/articles/_types/rebind";

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.7/§4A.8). Same
 * "mock only the Server Action module, render the real component" discipline
 * `catalog-scan-trigger-form.test.tsx` already uses. Assertion style
 * (`.textContent`, `.disabled`, `toBeTruthy()`/`toBeNull()`) matches
 * `articles-admin.test.tsx`'s own convention — this repo has no
 * `@testing-library/jest-dom` matcher registration.
 */

const actions = vi.hoisted(() => ({
  rebindArticleNovelAction: vi.fn(),
  rollbackArticleNovelAction: vi.fn(),
  searchRebindCandidatesAction: vi.fn(),
}));

vi.mock("@/app/(admin)/articles/_actions", () => actions);

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { ArticleRebindPanel } = await import("@/app/(admin)/articles/_components/article-rebind-panel");

function candidate(overrides: Partial<RebindCandidate> = {}): RebindCandidate {
  return {
    novelId: "11111111-1111-4111-8111-111111111111",
    title: "Target Novel",
    businessId: "biz-target",
    slug: "target-novel",
    locale: "en",
    status: "published",
    guardLevel: "ok",
    findings: [],
    titleMismatch: false,
    ...overrides,
  };
}

function view(overrides: Partial<RebindView> = {}): RebindView {
  return {
    article: { id: "article-1", locale: "en", slug: "current-slug", publicPageShortId: "AbCdEf12", title: "Current Article", status: "draft" },
    currentNovel: {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Current Novel",
      locale: "en",
      status: "published",
      promoLinkId: "promo-1",
      promoRedirectCode: "cur-code",
    },
    history: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ArticleRebindPanel", () => {
  it("🔴 始终展示「分类将随之变更」提示，不论是否已选目标", () => {
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);
    expect(screen.getByTestId("rebind-category-notice").textContent).toContain(
      "换绑后本页显示的分类将变为目标书目的分类",
    );
  });

  it("🔴 面板上不存在要求手打 UUID 的输入框——唯一的文本输入是搜索框", () => {
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);
    const textInputs = screen.getAllByRole("textbox").filter((el) => el.tagName === "INPUT");
    expect(textInputs).toHaveLength(1);
    expect(textInputs[0]).toBe(screen.getByTestId("rebind-search-input"));
    // Sanity: the search box itself never carries a UUID value/placeholder.
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(textInputs[0]!.getAttribute("placeholder") ?? "").not.toMatch(uuidPattern);
    expect((textInputs[0] as HTMLInputElement).value).not.toMatch(uuidPattern);
  });

  it("展示当前书目卡片：书名 / 语种 / 状态 / 推广链接就绪情况", () => {
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);
    expect(screen.getByText(/当前书目：Current Novel/)).toBeTruthy();
    expect(screen.getByText(/已绑定（cur-code）/)).toBeTruthy();
  });

  it("搜索返回候选卡片，点选后渲染三档守卫结果之一（ok → 绿色可执行）", async () => {
    actions.searchRebindCandidatesAction.mockResolvedValue({ ok: true, data: [candidate()] });
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);

    fireEvent.change(screen.getByTestId("rebind-search-input"), { target: { value: "target" } });
    await waitFor(() => expect(screen.queryByTestId(`rebind-candidate-${candidate().novelId}`)).toBeTruthy());

    fireEvent.click(screen.getByTestId(`rebind-candidate-${candidate().novelId}`));
    await waitFor(() => expect(screen.getByTestId("rebind-guard-banner").textContent).toContain("可执行"));
  });

  it("needs_ack 档：未勾选确认时提交按钮禁用；勾选后启用（连同必填理由）", async () => {
    const needsAck = candidate({
      guardLevel: "needs_ack",
      findings: [{ code: "CROSS_LOCALE_SIBLINGS", level: "needs_ack", message: "跨语种关联受影响" }],
    });
    actions.searchRebindCandidatesAction.mockResolvedValue({ ok: true, data: [needsAck] });
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);

    fireEvent.change(screen.getByTestId("rebind-search-input"), { target: { value: "target" } });
    await waitFor(() => expect(screen.queryByTestId(`rebind-candidate-${needsAck.novelId}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rebind-candidate-${needsAck.novelId}`));
    await waitFor(() => expect(screen.queryByTestId("rebind-acknowledge-checkbox")).toBeTruthy());

    fireEvent.change(screen.getByTestId("rebind-reason"), { target: { value: "channel outage" } });
    expect((screen.getByTestId("rebind-submit") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("rebind-acknowledge-checkbox"));
    expect((screen.getByTestId("rebind-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocked 档：提交按钮始终禁用，即使填了理由", async () => {
    const blocked = candidate({
      guardLevel: "blocked",
      findings: [{ code: "TARGET_LOCALE_OCCUPIED", level: "blocked", message: "目标书目在该语种下已有文章占位" }],
    });
    actions.searchRebindCandidatesAction.mockResolvedValue({ ok: true, data: [blocked] });
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);

    fireEvent.change(screen.getByTestId("rebind-search-input"), { target: { value: "target" } });
    await waitFor(() => expect(screen.queryByTestId(`rebind-candidate-${blocked.novelId}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rebind-candidate-${blocked.novelId}`));
    await waitFor(() => expect(screen.getByTestId("rebind-guard-banner").textContent).toContain("不可执行"));

    fireEvent.change(screen.getByTestId("rebind-reason"), { target: { value: "x" } });
    expect((screen.getByTestId("rebind-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("rebind-acknowledge-checkbox")).toBeNull();
  });

  it("未选中任何候选或未填理由时提交按钮禁用", () => {
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);
    expect((screen.getByTestId("rebind-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("canRebind=false 时搜索框与理由框禁用，提交按钮禁用", () => {
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind={false} />);
    expect((screen.getByTestId("rebind-search-input") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("rebind-reason") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("rebind-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("提交成功后调用 rebindArticleNovelAction 并刷新路由", async () => {
    actions.searchRebindCandidatesAction.mockResolvedValue({ ok: true, data: [candidate()] });
    actions.rebindArticleNovelAction.mockResolvedValue({
      ok: true,
      data: {
        articleId: "article-1",
        oldNovelId: "novel-old",
        newNovelId: candidate().novelId,
        oldPromoLinkId: null,
        newPromoLinkId: null,
        guardLevel: "ok",
        findings: [],
        auditId: "1",
        locale: "en",
        slug: "s",
        publicPageShortId: "p",
      },
    });
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);

    fireEvent.change(screen.getByTestId("rebind-search-input"), { target: { value: "target" } });
    await waitFor(() => expect(screen.queryByTestId(`rebind-candidate-${candidate().novelId}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`rebind-candidate-${candidate().novelId}`));
    fireEvent.change(screen.getByTestId("rebind-reason"), { target: { value: "channel outage" } });
    await waitFor(() => expect((screen.getByTestId("rebind-submit") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId("rebind-submit"));

    await waitFor(() =>
      expect(actions.rebindArticleNovelAction).toHaveBeenCalledWith(
        expect.objectContaining({
          articleId: "article-1",
          expectedOldNovelId: "22222222-2222-4222-8222-222222222222",
          targetNovelId: candidate().novelId,
          reason: "channel outage",
        }),
      ),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it("换绑记录存在 article.rebind_novel 行时才显示「换回上一次」按钮", () => {
    const withHistory = view({
      history: [
        {
          id: "1",
          action: "article.rebind_novel",
          reason: "prior switch",
          createdAt: "2026-09-01T00:00:00.000Z",
          beforeSnapshot: {},
          afterSnapshot: {},
        },
      ],
    });
    render(<ArticleRebindPanel articleId="article-1" initialView={withHistory} canRebind />);
    expect(screen.queryByTestId("rebind-rollback-button")).toBeTruthy();
  });

  it("没有换绑记录时不显示「换回上一次」按钮", () => {
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);
    expect(screen.queryByTestId("rebind-rollback-button")).toBeNull();
  });

  it("目标书名与当前书名不同时显示黄字非阻断提示", async () => {
    const mismatched = candidate({ title: "Different Title", titleMismatch: true });
    actions.searchRebindCandidatesAction.mockResolvedValue({ ok: true, data: [mismatched] });
    render(<ArticleRebindPanel articleId="article-1" initialView={view()} canRebind />);

    fireEvent.change(screen.getByTestId("rebind-search-input"), { target: { value: "different" } });
    await waitFor(() => expect(screen.queryByText("目标书名与当前书名不同")).toBeTruthy());
  });
});
