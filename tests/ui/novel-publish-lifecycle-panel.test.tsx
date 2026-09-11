import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublishLifecyclePanel } from "@/app/(admin)/novels/_components/publish-lifecycle-panel";

import { installDialogShim } from "./jsdom-dialog";

/**
 * `PublishLifecyclePanel` — the novel-detail-page publish/withdraw/takedown/
 * restore controls (PR-C3, task items 1-3). Follows
 * `tests/ui/admin-channel-accounts.test.tsx`'s discipline exactly: only the
 * Server Action module and `next/navigation` are replaced (the former needs
 * `next/headers` and Prisma, which jsdom cannot load; the latter has no
 * router in a bare render). Every other judgment call — which buttons show
 * for which status, whether the confirm dialog opens, whether a blank
 * reason is rejected client-side — goes through the real component.
 */

installDialogShim();

const actions = vi.hoisted(() => ({
  publishArticleAction: vi.fn(),
  withdrawNovelAction: vi.fn(),
  takedownNovelAction: vi.fn(),
  restoreNovelAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/novels/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const ARTICLE_DRAFT = { articleId: "a1", locale: "en", slug: "s1", status: "draft" as const };
const ARTICLE_PUBLISHED = { ...ARTICLE_DRAFT, status: "published" as const };

function dialog(): HTMLDialogElement | null {
  return document.querySelector("dialog");
}

beforeEach(() => {
  actions.publishArticleAction.mockReset();
  actions.withdrawNovelAction.mockReset();
  actions.takedownNovelAction.mockReset();
  actions.restoreNovelAction.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("按钮可见性 · 与 requireSourceStatus 的前置条件一一对应", () => {
  it("draft：只出现 发布 与 版权/安全移除", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    expect(screen.queryByTestId("publish-action-publish")).toBeTruthy();
    expect(screen.queryByTestId("publish-action-takedown")).toBeTruthy();
    expect(screen.queryByTestId("publish-action-withdraw")).toBeNull();
    expect(screen.queryByTestId("publish-action-restore")).toBeNull();
  });

  it("published：只出现 下架 与 版权/安全移除；文章已是 published 时隐藏 发布", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="published"
        article={ARTICLE_PUBLISHED}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    expect(screen.queryByTestId("publish-action-publish")).toBeNull();
    expect(screen.queryByTestId("publish-action-withdraw")).toBeTruthy();
    expect(screen.queryByTestId("publish-action-takedown")).toBeTruthy();
    expect(screen.queryByTestId("publish-action-restore")).toBeNull();
  });

  it("takedown：只出现 恢复", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="takedown"
        article={{ ...ARTICLE_DRAFT, status: "takedown" }}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    expect(screen.queryByTestId("publish-action-publish")).toBeNull();
    expect(screen.queryByTestId("publish-action-withdraw")).toBeNull();
    expect(screen.queryByTestId("publish-action-takedown")).toBeNull();
    expect(screen.queryByTestId("publish-action-restore")).toBeTruthy();
  });

  it("unpublished：出现 发布（重新发布）与 版权/安全移除，不出现 下架", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="unpublished"
        article={{ ...ARTICLE_DRAFT, status: "unpublished" }}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    expect(screen.queryByTestId("publish-action-publish")).toBeTruthy();
    expect(screen.queryByTestId("publish-action-withdraw")).toBeNull();
    expect(screen.queryByTestId("publish-action-takedown")).toBeTruthy();
  });

  it("没有关联文章时不出现发布按钮，并给出提示", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={null}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    expect(screen.queryByTestId("publish-action-publish")).toBeNull();
    expect(screen.getByText("该书目暂无关联文章，无法执行发布。")).toBeTruthy();
  });
});

describe("能力位闸门 · 缺能力位仍显示按钮，但禁用并点名缺口", () => {
  it("content:publish 被拒时，发布按钮被禁用且提示缺口", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="denied"
        canTakedown="granted"
      />,
    );
    const button = screen.getByTestId("publish-action-publish") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/内容发布/)).toBeTruthy();
  });

  it("content:takedown 为 two_factor_required 时，版权移除按钮禁用并提示需要完成二次验证", () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="two_factor_required"
      />,
    );
    const button = screen.getByTestId("publish-action-takedown") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/双重验证/)).toBeTruthy();
  });
});

describe("发布 · 直接点击，不经过二次确认", () => {
  it("点击后调用 publishArticleAction，成功时渲染发布结果并刷新页面", async () => {
    actions.publishArticleAction.mockResolvedValue({
      ok: true,
      data: { outcome: "published", articleId: "a1", novelId: "n1", locale: "en", firstPublish: true },
    });
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-publish"));
    });
    expect(actions.publishArticleAction).toHaveBeenCalledWith(
      expect.objectContaining({ novelId: "n1", articleId: "a1" }),
    );
    expect(await screen.findByText(/发布成功——这是该书目首次对外发布/)).toBeTruthy();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("rejected 时逐条渲染门禁理由与指引，每条带 data-testid", async () => {
    actions.publishArticleAction.mockResolvedValue({
      ok: true,
      data: {
        outcome: "rejected",
        gate: {
          publishable: false,
          reasons: ["promo_link_missing", "preview_chapter_missing"],
          requiredMetadataMissing: null,
        },
      },
    });
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-publish"));
    });
    expect(await screen.findByTestId("publish-gate-reason-promo_link_missing")).toBeTruthy();
    expect(screen.getByTestId("publish-gate-reason-preview_chapter_missing")).toBeTruthy();
    expect(screen.getByText(/未通过发布门禁，共 2 项/)).toBeTruthy();
  });

  it("conflict 时给出安全重试提示与重试按钮，点击后再次调用 publishArticleAction", async () => {
    actions.publishArticleAction.mockResolvedValue({ ok: true, data: { outcome: "conflict" } });
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-publish"));
    });
    expect(await screen.findByText(/可直接重试/)).toBeTruthy();
    const retry = screen.getByTestId("publish-retry-conflict");
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(actions.publishArticleAction).toHaveBeenCalledTimes(2);
  });

  it("not_found 时给出刷新提示", async () => {
    actions.publishArticleAction.mockResolvedValue({ ok: true, data: { outcome: "not_found" } });
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-publish"));
    });
    expect(await screen.findByText(/对应文章不存在/)).toBeTruthy();
  });

  it("action 返回 access_denied 时展示错误文案，不刷新页面", async () => {
    actions.publishArticleAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      envelope: { ok: false, status: 403, code: "admin_capability_denied", details: { capability: "content:publish" } },
    });
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-publish"));
    });
    expect(await screen.findByText(/发布失败/)).toBeTruthy();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

describe("takedown · 二次确认与版权/安全移除的警示文案", () => {
  it("点击「版权/安全移除」打开确认框，警示文案提到正文会被永久删除且不可恢复", async () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const warning = screen.getByTestId("rights-transition-warning-takedown");
    expect(warning.textContent).toContain("永久删除");
    expect(warning.textContent).toContain("不可恢复");
    expect(warning.textContent).toContain("410");
  });

  it("原因为空时点击确认不提交、不调用 Action，确认框保持打开并就地展示校验提示", async () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    });
    expect(actions.takedownNovelAction).not.toHaveBeenCalled();
    // Previously a silent no-op: the dialog stayed open with zero feedback,
    // and this exact copy was unreachable from the button. Now it must
    // actually render.
    expect(dialog()?.open).toBe(true);
    expect(screen.getByTestId("rights-transition-reason-error").textContent).toBe(
      "请填写操作原因后再提交（会写入审计记录）。",
    );
  });

  it("就地校验提示：输入内容后自动清除，重新打开确认框也会清除上一次的提示", async () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    });
    expect(screen.getByTestId("rights-transition-reason-error")).toBeTruthy();

    const input = screen.getByPlaceholderText("例如：版权方要求下线");
    fireEvent.change(input, { target: { value: "版" } });
    expect(screen.queryByTestId("rights-transition-reason-error")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    expect(screen.queryByTestId("rights-transition-reason-error")).toBeNull();
  });

  it("填写原因后确认，调用 takedownNovelAction 并携带 trim 后的原因，成功后刷新页面", async () => {
    actions.takedownNovelAction.mockResolvedValue({
      ok: true,
      data: { novelId: "n1", novelStatus: "takedown", affectedArticleIds: ["a1"] },
    });
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const input = screen.getByPlaceholderText("例如：版权方要求下线");
    fireEvent.change(input, { target: { value: "  版权方要求下线  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    });
    expect(actions.takedownNovelAction).toHaveBeenCalledWith(
      expect.objectContaining({ novelId: "n1", reason: "版权方要求下线" }),
    );
    expect(await screen.findByText(/受影响文章数：1/)).toBeTruthy();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it("取消关闭确认框且不调用 Action", async () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
    });
    expect(actions.takedownNovelAction).not.toHaveBeenCalled();
  });

  /**
   * Fix (Owner-approved 窄范围修复 lane, 2026-09-11): `runRightsTransition`
   * shares this exact bug shape with `../../articles/_components/
   * article-list.tsx`'s `confirmWithdraw` (that component's own doc comment
   * calls out this file by name as sharing the shape) — `await call` used
   * to sit outside any try/catch while `onConfirm` fires this function as
   * `void runRightsTransition(pending)`, so a *rejected* promise (e.g. a
   * stale Next.js build throwing "Failed to find Server Action" after a
   * deploy) skipped every line after the `await`, including
   * `setBusy(false)`, leaving `pending={busy}` stuck `true` and the confirm
   * button permanently reading "处理中…", disabled. Pins the fix: the button
   * becomes clickable again with its normal confirmLabel ("确认移除"), a
   * readable refresh-prompting notice appears, the dialog is deliberately
   * left open (reason preserved, retry-able after a refresh), and no
   * premature `router.refresh()` fires.
   */
  it("takedownNovelAction 因 stale bundle 而 reject（Failed to find Server Action）时，按钮恢复可点击并展示刷新提示，而不是永久卡在「处理中」", async () => {
    actions.takedownNovelAction.mockRejectedValue(
      new Error('Failed to find Server Action "abc123def456". This request might be from an older or newer deployment.'),
    );
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const input = screen.getByPlaceholderText("例如：版权方要求下线");
    fireEvent.change(input, { target: { value: "版权方要求下线" } });
    const confirmButton = () => screen.getByRole("button", { name: /^(确认移除|处理中…)$/ });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
    expect(confirmButton().textContent).toBe("确认移除");
    expect(dialog()?.open).toBe(true);
    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "版权/安全移除请求未完成（页面版本已过期），请刷新页面后重试",
      ),
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("takedownNovelAction 因普通网络错误 reject 时，同样恢复可点击并展示（非 stale-bundle 措辞的）刷新提示", async () => {
    actions.takedownNovelAction.mockRejectedValue(new Error("Network request failed"));
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="draft"
        article={ARTICLE_DRAFT}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-takedown"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const input = screen.getByPlaceholderText("例如：版权方要求下线");
    fireEvent.change(input, { target: { value: "版权方要求下线" } });
    const confirmButton = () => screen.getByRole("button", { name: /^(确认移除|处理中…)$/ });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    await waitFor(() => expect((confirmButton() as HTMLButtonElement).disabled).toBe(false));
    await vi.waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "版权/安全移除请求未完成（网络或页面版本已过期），请刷新页面后重试",
      ),
    );
  });
});

describe("restore · 警示明确说明恒落 draft", () => {
  it("点击「恢复」的确认框警示文案提到草稿与需要重新过门禁", async () => {
    render(
      <PublishLifecyclePanel
        novelId="n1"
        novelStatus="takedown"
        article={{ ...ARTICLE_DRAFT, status: "takedown" }}
        canPublish="granted"
        canTakedown="granted"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("publish-action-restore"));
    });
    await waitFor(() => expect(dialog()?.open).toBe(true));
    const warning = screen.getByTestId("rights-transition-warning-restore");
    expect(warning.textContent).toContain("草稿");
    expect(warning.textContent).toContain("门禁");
  });
});
