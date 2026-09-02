import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminCapabilityState } from "@/contracts";
import { describeCreateContentOutcome, type CreateContentResult } from "@/app/(admin)/catalog-sync/_lib/outcome-copy";
import type { ClaimChannelAppOption } from "@/app/(admin)/catalog-sync/_lib/read-channel-apps";
import type { SourceItemRow } from "@/app/(admin)/catalog-sync/_lib/read-source-items";

import { installDialogShim } from "./jsdom-dialog";

/**
 * `/catalog-sync` 渲染与接线验收（P0-S13 + RC-1）。
 *
 * 只替换两样东西：Server Action 模块与 `next/navigation`——`admin-channel-
 * accounts.test.tsx` 定的规矩同样适用于这里。替身只记录"哪个 Action 被调、
 * 参数是什么、回传了什么"，不改组件自己的判断：dry-run 先跑、"确认创建"是否
 * 可点、每种 outcome 渲染成什么，全部走真实组件与真实的
 * `describeCreateContentOutcome`。
 *
 * RC-1 的 `PromoLinkClaimDialog` 沿用同一条纪律，且只通过 `CatalogSyncClient`
 * 驱动测试——`create-content-dialog.tsx` 从未有独立测试文件，两个从这个表格
 * 打开的对话框走同一个precedent，而不是另开一份重复的渲染脚手架。
 */

const actions = vi.hoisted(() => ({
  dryRunContentCreationAction: vi.fn(),
  applyContentCreationAction: vi.fn(),
  enqueuePromoLinkClaimAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { CatalogSyncClient } = await import(
  "@/app/(admin)/catalog-sync/_components/catalog-sync-client"
);

installDialogShim();

function row(overrides: Partial<SourceItemRow> = {}): SourceItemRow {
  return {
    id: "src-1",
    title: "示例小说 A",
    description: "一段简介",
    coverUrl: "https://example.com/cover.jpg",
    totalChapterCount: 120,
    paidFromChapter: 20,
    sourceLocale: "en",
    sourceLanguageCode: "1",
    sourceLanguageName: "English",
    status: "pending",
    novelId: null,
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    channelAppId: "channel-app-1",
    channelCode: "moboreader",
    channelName: "Moboreader",
    sourceAppCode: "mobo-app-1",
    sourceAppName: "Mobo App",
    ...overrides,
  };
}

const ROWS: readonly SourceItemRow[] = [
  row(),
  row({ id: "src-2", title: "已建立的条目", status: "linked", novelId: "novel-9" }),
];

function claimApp(overrides: Partial<ClaimChannelAppOption> = {}): ClaimChannelAppOption {
  return {
    id: "channel-app-1",
    channelCode: "moboreader",
    channelName: "Moboreader",
    sourceAppCode: "mobo-app-1",
    sourceAppName: "Mobo App",
    claimCapabilityEnabled: true,
    channelAccounts: [{ id: "acct-1", businessId: "biz-1", accountName: "主账号" }],
    ...overrides,
  };
}

const PLAN = {
  locale: "en" as const,
  title: "示例小说 A",
  novelSlug: "the-novel-a",
  articleSlug: "the-novel-a-article",
  provisionalPublicPageShortId: "prov001",
};

const CREATED_SUMMARY = {
  novelId: "novel-1",
  novelBusinessId: "biz-001",
  articleId: "article-1",
  locale: "en" as const,
  novelSlug: "the-novel-a",
  articleSlug: "the-novel-a-article",
  publicPageShortId: "abc123",
};

function okResult<T>(data: T) {
  return { ok: true as const, data };
}

function renderPage(
  options: {
    items?: readonly SourceItemRow[];
    contentPublish?: AdminCapabilityState;
    claimChannelApps?: readonly ClaimChannelAppOption[];
    promoClaimMaxBatchSize?: number;
    promoClaimGranted?: boolean;
    promoClaimBlockedReason?: string | null;
  } = {},
) {
  return render(
    <CatalogSyncClient
      items={options.items ?? ROWS}
      contentPublish={options.contentPublish ?? "granted"}
      claimChannelApps={options.claimChannelApps ?? [claimApp()]}
      promoClaimMaxBatchSize={options.promoClaimMaxBatchSize ?? 50}
      promoClaimGranted={options.promoClaimGranted ?? true}
      promoClaimBlockedReason={options.promoClaimBlockedReason ?? null}
    />,
  );
}

function dialog(): HTMLDialogElement {
  return document.querySelector("dialog") as HTMLDialogElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function openDialog(title = "示例小说 A"): Promise<void> {
  await click(within(rowOf(title)).getByRole("button", { name: "创建内容" }));
}

function rowOf(title: string): HTMLElement {
  const cell = screen.getByText(title);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${title}`);
  return tr as HTMLElement;
}

beforeEach(() => {
  actions.dryRunContentCreationAction.mockReset();
  actions.applyContentCreationAction.mockReset();
  actions.enqueuePromoLinkClaimAction.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("来源条目表格 · 渲染", () => {
  it("列出标题、语种识别、渠道、章节数与状态徽标", () => {
    renderPage();
    expect(screen.getByText("示例小说 A")).toBeTruthy();
    // 两行来源同一渠道，特意断言"两处都在"而不是要求唯一，避免把真实的重复
    // 数据误判成测试 bug。
    expect(screen.getAllByText("Moboreader（moboreader）")).toHaveLength(2);
    expect(screen.getByTestId("source-item-status-pending").textContent).toBe("待创建");
    expect(screen.getByTestId("source-item-status-linked").textContent).toBe("已建立书目");
  });

  it("空表渲染空状态", () => {
    renderPage({ items: [] });
    expect(screen.getByText("没有符合条件的来源条目")).toBeTruthy();
  });

  it("每一行都有创建内容按钮，即便该条目已经 linked——点开会看到 already_exists 而不是被隐藏", () => {
    renderPage();
    expect(screen.getAllByRole("button", { name: "创建内容" })).toHaveLength(2);
  });
});

describe("创建内容对话框 · dry-run 自动触发", () => {
  it("打开对话框立即以正确参数调用 dryRunContentCreationAction", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
    renderPage();

    await openDialog();

    expect(actions.dryRunContentCreationAction).toHaveBeenCalledTimes(1);
    const call = actions.dryRunContentCreationAction.mock.calls[0][0];
    expect(call.novelSourceItemId).toBe("src-1");
    expect(call.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(actions.applyContentCreationAction).not.toHaveBeenCalled();
  });

  it("加载中展示状态文案，计划到达后渲染字段与语种一致时不显示不匹配提示", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
    renderPage();
    await openDialog();

    const dlg = within(dialog());
    expect(dlg.getByText("the-novel-a")).toBeTruthy();
    expect(dlg.getByText("the-novel-a-article")).toBeTruthy();
    expect(dlg.getByText(/prov001/)).toBeTruthy();
    expect(dlg.getByText("120")).toBeTruthy();
    expect(dlg.queryByTestId("locale-mismatch-notice")).toBeNull();
  });

  it("来源条目语种不是 en 时显示不匹配提示", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
    renderPage({ items: [row({ sourceLocale: "ja" })] });
    await openDialog();
    expect(within(dialog()).getByTestId("locale-mismatch-notice").textContent).toContain("ja");
  });

  it("来源条目尚未识别出语种时显示另一句提示", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
    renderPage({ items: [row({ sourceLocale: null })] });
    await openDialog();
    expect(within(dialog()).getByTestId("locale-mismatch-notice").textContent).toContain(
      "语种归一 S7a 未接线",
    );
  });
});

describe("确认创建 → apply", () => {
  beforeEach(() => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
  });

  it("成功创建：调用 applyContentCreationAction、展示成功摘要与详情链接、并刷新数据", async () => {
    actions.applyContentCreationAction.mockResolvedValue(
      okResult({ outcome: "created", ...CREATED_SUMMARY }),
    );
    renderPage();
    await openDialog();
    await click(screen.getByRole("button", { name: "确认创建" }));

    expect(actions.applyContentCreationAction).toHaveBeenCalledTimes(1);
    expect(actions.applyContentCreationAction.mock.calls[0][0]).toMatchObject({
      novelSourceItemId: "src-1",
    });

    const dlg = within(dialog());
    expect(dlg.getByTestId("outcome-created").textContent).toContain("创建成功");
    expect(dlg.getByText("biz-001")).toBeTruthy();
    expect(dlg.getByRole("link", { name: "查看书目详情" }).getAttribute("href")).toBe(
      "/novels/novel-1",
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("已存在（幂等命中）：不算失败，但也不触发 router.refresh——数据本就没变", async () => {
    actions.applyContentCreationAction.mockResolvedValue(
      okResult({ outcome: "already_exists", ...CREATED_SUMMARY }),
    );
    renderPage();
    await openDialog();
    await click(screen.getByRole("button", { name: "确认创建" }));

    expect(within(dialog()).getByTestId("outcome-already_exists")).toBeTruthy();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("缺少 content:publish 时确认按钮禁用，并说明缺的是哪个能力位；点不动也就调不到 apply", async () => {
    renderPage({ contentPublish: "denied" });
    await openDialog();

    const confirmButton = within(dialog()).getByRole("button", { name: "确认创建" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(within(dialog()).getByText(/缺少能力位/).textContent).toContain("content:publish");

    await click(confirmButton);
    expect(actions.applyContentCreationAction).not.toHaveBeenCalled();
  });

  it("待完成 2FA 与未授予的措辞不同，运营据此知道该做什么", async () => {
    renderPage({ contentPublish: "two_factor_required" });
    await openDialog();
    expect(within(dialog()).getByText(/双重验证/)).toBeTruthy();
  });
});

describe("每种结果分类都有独立呈现（不静默吞掉任何一种）", () => {
  const BLOCKED_FIXTURES: readonly CreateContentResult[] = [
    { outcome: "source_item_not_found" },
    { outcome: "source_item_deleted" },
    { outcome: "source_item_ignored" },
    { outcome: "source_item_stale" },
    { outcome: "source_item_inconsistent_state" },
    {
      outcome: "locale_conflict",
      reason: "source_item_already_linked_to_different_locale",
      existingNovelId: "novel-7",
      existingLocale: "ja",
    },
    { outcome: "slug_unhealthy", field: "novel", baseSlug: "" },
    { outcome: "slug_conflict_exhausted", field: "article", baseSlug: "dup-title" },
    { outcome: "already_exists", ...CREATED_SUMMARY },
  ];

  it.each(BLOCKED_FIXTURES.map((fixture) => [fixture.outcome, fixture] as const))(
    "dry-run 直接返回 %s 时，对话框跳过计划态，直接展示该分类且不出现确认按钮",
    async (outcomeName, fixture) => {
      actions.dryRunContentCreationAction.mockResolvedValue(okResult(fixture));
      renderPage();
      await openDialog();

      const expected = describeCreateContentOutcome(fixture);
      const panel = within(dialog()).getByTestId(`outcome-${outcomeName}`);
      expect(panel.textContent).toContain(expected.title);
      expect(screen.queryByRole("button", { name: "确认创建" })).toBeNull();
    },
  );

  it("并发冲突只可能来自 apply：展示可重试的措辞与「重试」按钮，点击后重新 dry-run", async () => {
    actions.dryRunContentCreationAction.mockResolvedValueOnce(
      okResult({ outcome: "dry_run", plan: PLAN }),
    );
    actions.applyContentCreationAction.mockResolvedValue(
      okResult({ outcome: "concurrent_creation_conflict" }),
    );
    renderPage();
    await openDialog();
    await click(screen.getByRole("button", { name: "确认创建" }));

    expect(within(dialog()).getByTestId("outcome-concurrent_creation_conflict")).toBeTruthy();
    const retryButton = screen.getByRole("button", { name: "重试" });

    actions.dryRunContentCreationAction.mockResolvedValueOnce(
      okResult({ outcome: "dry_run", plan: PLAN }),
    );
    await click(retryButton);

    expect(actions.dryRunContentCreationAction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "确认创建" })).toBeTruthy());
  });

  it("模板渲染失败：把 code/slot/constraint 都带进正文，不是只报「失败」", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
    actions.applyContentCreationAction.mockResolvedValue(
      okResult({
        outcome: "template_render_failed",
        code: "ERR_TEMPLATE_OUTPUT_INVALID",
        slot: "title",
        constraint: "too_long",
      }),
    );
    renderPage();
    await openDialog();
    await click(screen.getByRole("button", { name: "确认创建" }));

    const panel = within(dialog()).getByTestId("outcome-template_render_failed");
    expect(panel.textContent).toContain("ERR_TEMPLATE_OUTPUT_INVALID");
    expect(panel.textContent).toContain("title");
    expect(panel.textContent).toContain("too_long");
  });
});

describe("守卫失败 / 输入校验失败——两类都不是 CreateContentResult，各自独立呈现", () => {
  it("access_denied：文案来自 errorEnvelopeCopy，而不是拼接服务端字符串", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "content:view" },
      },
    });
    renderPage();
    await openDialog();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("缺少能力位 内容查看（content:view）");
    });
  });

  it("invalid_input：来源条目标识无效时给出可操作的提示，而不是原样打印 code", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "invalid_novel_source_item_id",
    });
    renderPage();
    await openDialog();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("来源条目标识无效");
    });
  });
});

describe("取消与关闭", () => {
  it("取消不调用任何 Action，也不留下对话框", async () => {
    actions.dryRunContentCreationAction.mockResolvedValue(okResult({ outcome: "dry_run", plan: PLAN }));
    renderPage();
    await openDialog();
    expect(dialog()).not.toBeNull();

    await click(screen.getByRole("button", { name: "取消" }));

    // 对话框由 `{activeItem && <CreateContentDialog .../>}` 条件渲染——取消会把
    // `activeItem` 置空，组件整体卸载，而不是像 `ConfirmDialog` 那样常驻只切
    // `open`。断言的是"这棵子树真的没了"，不是"open 变成了 false"。
    expect(dialog()).toBeNull();
    expect(actions.applyContentCreationAction).not.toHaveBeenCalled();
  });
});

/**
 * RC-1 「领取推广链接」多选工具栏 + `PromoLinkClaimDialog`。
 *
 * `enqueuePromoLinkClaimAction` is mocked the same way the two
 * content-creation actions above are — this suite only checks wiring
 * (what the dialog passes to the action, how each outcome renders), not
 * `createPromoLinkClaimTask`'s own business logic (covered by
 * `tests/ui/promo-link-claim-actions.test.ts`).
 */

function checkboxFor(title: string): HTMLInputElement {
  return within(rowOf(title)).getByRole("checkbox") as HTMLInputElement;
}

function claimToolbarButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "领取推广链接" }) as HTMLButtonElement;
}

describe("领取推广链接 · 选择工具栏", () => {
  it("初始未勾选任何行：计数为 0，按钮禁用", () => {
    renderPage();
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("0");
    expect(claimToolbarButton().disabled).toBe(true);
  });

  it("勾选一行后计数变为 1，按钮可点；再取消勾选恢复禁用", async () => {
    renderPage();
    await click(checkboxFor("示例小说 A"));
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("1");
    expect(claimToolbarButton().disabled).toBe(false);

    await click(checkboxFor("示例小说 A"));
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("0");
    expect(claimToolbarButton().disabled).toBe(true);
  });

  it("没有勾选任何行时点击按钮不会打开对话框（按钮本身已禁用）", async () => {
    renderPage();
    await click(claimToolbarButton());
    expect(dialog()).toBeNull();
  });
});

describe("领取推广链接 · 对话框基础渲染与取消", () => {
  it("打开对话框展示已选数量、上限与所属渠道应用", async () => {
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());

    const dlg = within(dialog());
    expect(dlg.getByTestId("promo-claim-selection-count").textContent).toContain("1");
    expect(dlg.getByTestId("promo-claim-selection-count").textContent).toContain("50");
    expect(dlg.getByText(/Moboreader（moboreader）/)).toBeTruthy();
  });

  it("取消不调用 Action，也不留下对话框，且不清空已勾选的行", async () => {
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    expect(dialog()).not.toBeNull();

    await click(within(dialog()).getByRole("button", { name: "取消" }));

    expect(dialog()).toBeNull();
    expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
    // 取消是"关闭对话框"，不是"提交成功后清空选择"——计数应保持为 1。
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("1");
  });
});

describe("领取推广链接 · 跨渠道应用选择", () => {
  it("勾选分属不同渠道应用的行：对话框展示阻断提示，提交按钮保持禁用（同 P1-09 验收⑥：点不动也不隐藏，点了也调不到 action）", async () => {
    renderPage({
      items: [...ROWS, row({ id: "src-3", title: "另一渠道条目", channelAppId: "channel-app-2" })],
    });
    await click(checkboxFor("示例小说 A"));
    await click(checkboxFor("另一渠道条目"));
    await click(claimToolbarButton());

    const dlg = within(dialog());
    expect(dlg.getByTestId("promo-claim-cross-channel-app")).toBeTruthy();
    const submitButton = dlg.getByRole("button", { name: /确认领取/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);

    await click(submitButton);
    expect(actions.enqueuePromoLinkClaimAction).not.toHaveBeenCalled();
  });
});

describe("领取推广链接 · 能力位未开启（ChannelCapability 前置检查）", () => {
  it("所属渠道应用 claimCapabilityEnabled=false：展示冻结提示，不展示账户/模式选择器，提交按钮保持禁用", async () => {
    renderPage({ claimChannelApps: [claimApp({ claimCapabilityEnabled: false })] });
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());

    const dlg = within(dialog());
    expect(dlg.getByTestId("promo-claim-capability-disabled-precheck")).toBeTruthy();
    expect(dlg.queryByLabelText("渠道账户")).toBeNull();
    const submitButton = dlg.getByRole("button", { name: /确认领取/ }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });
});

describe("领取推广链接 · 超过单次上限", () => {
  it("已选数量超过 promoClaimMaxBatchSize 时展示警告，且提交按钮不可点", async () => {
    renderPage({
      items: [row({ id: "src-1", title: "A" }), row({ id: "src-2", title: "B" })],
      promoClaimMaxBatchSize: 1,
    });
    await click(checkboxFor("A"));
    await click(checkboxFor("B"));
    await click(claimToolbarButton());

    const dlg = within(dialog());
    expect(dlg.getByText(/超过单次上限 1 条/)).toBeTruthy();
    const submitButton = dlg.queryByRole("button", { name: /确认领取/ }) as HTMLButtonElement | null;
    expect(submitButton?.disabled).toBe(true);
  });
});

describe("领取推广链接 · apply 模式的不可逆提示与能力位闸门", () => {
  it("切到 apply 会展示不可逆警示；缺少 promo:claim 时确认按钮禁用并说明原因", async () => {
    renderPage({ promoClaimGranted: false, promoClaimBlockedReason: "缺少能力位 推广领取（promo:claim）" });
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());

    const dlg = within(dialog());
    const modeSelect = dlg.getByLabelText("模式") as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: "apply" } });

    expect(dlg.getByTestId("promo-claim-apply-irreversible-warning")).toBeTruthy();
    expect(dlg.getByText(/缺少能力位 推广领取/)).toBeTruthy();
    const submitButton = dlg.getByRole("button", { name: "确认领取（apply）" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });

  it("dry_run 模式下不展示不可逆警示", async () => {
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());

    expect(within(dialog()).queryByTestId("promo-claim-apply-irreversible-warning")).toBeNull();
  });
});

describe("领取推广链接 · 提交与结果分支", () => {
  it("确认领取以正确参数调用 enqueuePromoLinkClaimAction（账户来自选择器，offerType 不由前端传入）", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue(
      okResult({ outcome: "enqueued", taskId: "task-1", mode: "dry_run", eligibleCount: 1, skipReasonCounts: {} }),
    );
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    expect(actions.enqueuePromoLinkClaimAction).toHaveBeenCalledTimes(1);
    const call = actions.enqueuePromoLinkClaimAction.mock.calls[0][0];
    expect(call).toMatchObject({
      channelAccountId: "acct-1",
      channelAppId: "channel-app-1",
      novelSourceItemIds: ["src-1"],
      mode: "dry_run",
    });
    expect(call.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(call).not.toHaveProperty("offerType");
  });

  it("成功后展示 enqueued 结果面板，且提交按钮从对话框消失（不能重复提交同一次结果）", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue(
      okResult({ outcome: "enqueued", taskId: "task-1", mode: "dry_run", eligibleCount: 1, skipReasonCounts: {} }),
    );
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    const dlg = within(dialog());
    expect(dlg.getByTestId("promo-claim-outcome-enqueued")).toBeTruthy();
    expect(dlg.queryByRole("button", { name: /确认领取/ })).toBeNull();
  });

  it("提交成功后关闭对话框会清空已勾选的行——工具栏计数回到 0", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue(
      okResult({ outcome: "enqueued", taskId: "task-1", mode: "dry_run", eligibleCount: 1, skipReasonCounts: {} }),
    );
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));
    await click(within(dialog()).getByRole("button", { name: "关闭" }));

    expect(dialog()).toBeNull();
    expect(screen.getByTestId("promo-claim-toolbar-count").textContent).toContain("0");
  });

  it("capability_disabled 结果（提交时刻能力位刚好被冻结）：展示对应面板，不当成失败", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue(
      okResult({ outcome: "capability_disabled", channelAppId: "channel-app-1" }),
    );
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    expect(within(dialog()).getByTestId("promo-claim-outcome-capability_disabled")).toBeTruthy();
  });

  it("enqueued_disabled 结果：展示双闸检查单，两个 env 变量名都出现在正文里", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue(
      okResult({
        outcome: "enqueued_disabled",
        taskId: "task-2",
        mode: "dry_run",
        eligibleCount: 1,
        skipReasonCounts: {},
        flags: { featureEnabled: false, writeAllowed: false },
      }),
    );
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    const dlg = within(dialog());
    expect(dlg.getByTestId("promo-claim-flag-row-FEATURE_PROMO_LINK_CLAIM")).toBeTruthy();
    expect(dlg.getByTestId("promo-claim-flag-row-PROMO_LINK_CLAIM_ALLOW_WRITE")).toBeTruthy();
  });

  it("no_eligible_sources 结果：逐条展示跳过原因，而不是只报一句「失败」", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue(
      okResult({
        outcome: "no_eligible_sources",
        skipReasonCounts: { source_not_linked: 2 },
      }),
    );
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    expect(within(dialog()).getByTestId("promo-claim-skip-source_not_linked").textContent).toContain("2");
  });

  it("invalid_input：文案来自映射表，而不是原样打印 code", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "batch_size_exceeded",
    });
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    expect(within(dialog()).getByRole("alert").textContent).toContain("超过单次上限");
  });

  it("access_denied：文案来自 errorEnvelopeCopy", async () => {
    actions.enqueuePromoLinkClaimAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "promo:claim" },
      },
    });
    renderPage();
    await click(checkboxFor("示例小说 A"));
    await click(claimToolbarButton());
    await click(within(dialog()).getByRole("button", { name: "确认领取（dry_run）" }));

    expect(within(dialog()).getByRole("alert").textContent).toContain("缺少能力位");
  });
});
