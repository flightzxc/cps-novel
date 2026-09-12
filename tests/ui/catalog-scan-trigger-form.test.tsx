import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelScanOption } from "@/app/(admin)/catalog-sync/_lib/read-channel-apps";

/**
 * `CatalogScanTriggerForm` (PR-C2; reshaped by Phase B —
 * `施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md` §三 — into CPS
 * `changdu-sync-panel.tsx` parity: 渠道 → 剧场 chips → 语种 chips → 渠道账号 →
 * 「开始同步」, apply-only, no page-mechanics fields, no mode picker).
 *
 * Same double-replacement discipline as `catalog-sync-client.test.tsx`: only
 * the Server Action module (`../_actions`) is mocked, so this file only
 * records which action got called with what, and what the component renders
 * back — every branch (validation, four outcomes, access-denied, flag-off
 * copy) is driven by the real component and the real `scan-task-copy.ts`.
 */

const actions = vi.hoisted(() => ({
  dryRunCatalogScanTaskAction: vi.fn(),
  applyCatalogScanTaskAction: vi.fn(),
}));

vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
// C-6: the form now calls useRouter() (router.refresh() is ImportProgress's
// onTerminal callback) -- same double-mock shape admin-task-detail-panel.test.tsx
// already uses for the same reason. `routerRefresh` is hoisted (not a fresh
// vi.fn() per useRouter() call) so tests can assert on the exact instance the
// component actually invoked.
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { CatalogScanTriggerForm } = await import(
  "@/app/(admin)/catalog-sync/_components/catalog-scan-trigger-form"
);

function channel(overrides: Partial<ChannelScanOption> = {}): ChannelScanOption {
  return {
    id: "channel-1",
    code: "changdu",
    name: "Changdu",
    channelApps: [{ id: "app-1", sourceAppCode: "moboreader", sourceAppName: "MoboReader" }],
    channelAccounts: [{ id: "acct-1", businessId: "biz-1", accountName: "主账户" }],
    ...overrides,
  };
}

const CHANNELS: readonly ChannelScanOption[] = [
  channel(),
  channel({
    id: "channel-2",
    code: "second-channel",
    name: "第二渠道",
    channelApps: [{ id: "app-2a", sourceAppCode: "app-2a", sourceAppName: "剧场 2A" }],
    channelAccounts: [
      { id: "acct-2a", businessId: "biz-2a", accountName: "第二渠道账户 A" },
      { id: "acct-2b", businessId: "biz-2b", accountName: "第二渠道账户 B" },
    ],
  }),
];

function okResult<T>(data: T) {
  return { ok: true as const, data };
}

function renderForm(
  options: {
    channels?: readonly ChannelScanOption[];
    contentPublishGranted?: boolean;
    contentPublishBlockedReason?: string | null;
    safetyMaxPages?: number;
  } = {},
) {
  return render(
    <CatalogScanTriggerForm
      channels={options.channels ?? CHANNELS}
      contentPublishGranted={options.contentPublishGranted ?? true}
      contentPublishBlockedReason={options.contentPublishBlockedReason ?? null}
      safetyMaxPages={options.safetyMaxPages ?? 2000}
    />,
  );
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /开始同步/ }) as HTMLButtonElement;
}

async function submit(): Promise<void> {
  await click(submitButton());
}

function languageChip(label: string): HTMLElement {
  return screen.getByRole("button", { name: label });
}

beforeEach(() => {
  actions.dryRunCatalogScanTaskAction.mockReset();
  actions.applyCatalogScanTaskAction.mockReset();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("没有可用的活跃渠道", () => {
  it("不渲染表单，只给出去配置渠道账户的指引，且不触碰任何 Action", async () => {
    renderForm({ channels: [] });
    expect(screen.getByTestId("catalog-scan-no-channel-apps")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /开始同步/ })).toBeNull();
    expect(actions.applyCatalogScanTaskAction).not.toHaveBeenCalled();
  });
});

describe("默认态：渠道 → 剧场 → 语种 → 账户 依次生效", () => {
  it("渠道、账户默认选中第一项；语种默认一个都不选", () => {
    renderForm();
    expect((screen.getByLabelText("渠道") as HTMLSelectElement).value).toBe("channel-1");
    expect((screen.getByLabelText("渠道账户") as HTMLSelectElement).value).toBe("acct-1");
    expect(languageChip("英文").getAttribute("aria-pressed")).toBe("false");
  });

  it("剧场 chips 来自所选渠道下的 active ChannelApp", () => {
    renderForm();
    expect(screen.getByRole("button", { name: "MoboReader" })).toBeTruthy();
  });

  it("切换渠道会把剧场与账户都重置为新渠道的第一项", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("渠道"), { target: { value: "channel-2" } });
    expect(screen.getByRole("button", { name: "剧场 2A" })).toBeTruthy();
    expect((screen.getByLabelText("渠道账户") as HTMLSelectElement).value).toBe("acct-2a");
    expect(screen.getByLabelText("渠道账户").querySelectorAll("option")).toHaveLength(2);
  });

  it("渠道下没有启用中的账户时，账户下拉禁用并显示占位项", () => {
    renderForm({ channels: [channel({ channelAccounts: [] })] });
    const select = screen.getByLabelText("渠道账户") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByText("（该渠道下没有启用中的账户）")).toBeTruthy();
  });

  it("安全页数上限会显示在说明文案里", () => {
    renderForm({ safetyMaxPages: 500 });
    expect(screen.getByText(/500 页/)).toBeTruthy();
  });

  it("点击语种 chip 切换选中态，并体现在按钮文案上", async () => {
    renderForm();
    expect(screen.getByRole("button", { name: /开始同步$/ })).toBeTruthy();
    await click(languageChip("英文"));
    expect(languageChip("英文").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "开始同步 · 1 语种" })).toBeTruthy();
    await click(languageChip("日文"));
    expect(screen.getByRole("button", { name: "开始同步 · 2 语种" })).toBeTruthy();
    await click(languageChip("英文"));
    expect(screen.getByRole("button", { name: "开始同步 · 1 语种" })).toBeTruthy();
  });
});

// L10N P5 (矩阵 #13): the chip list is now derived from the moboreader
// 18-code table (`channel-language.ts`'s `MOBOREADER_LANGUAGE_CODE_TO_LOCALE`),
// not the 15-entry `SITE_LOCALES` registry — a *source-app* concept, not a
// *site* concept. Mutation ③ (chip reverted to the static 15-item
// `SITE_LOCALES` render) is exactly what the first assertion below catches.
describe("同步语种 chip 由 moboreader 18 码派生（L10N P5 矩阵 #13）", () => {
  it("渲染 18 个语种 chip，不是 SITE_LOCALES 的 15 个", () => {
    renderForm();
    const group = screen.getByRole("group", { name: "同步语种" });
    const chips = within(group).getAllByRole("button");
    expect(chips).toHaveLength(18);
  });

  it("非站点语种（it/fil/ms/tr）标注「仅索引不建内容」，站点语种不带该标注", () => {
    renderForm();
    // Non-site locales fall back to their bare upstream code as the label
    // (no SITE_LOCALE_LABELS entry exists for them) — see
    // `catalog-scan-trigger-form.tsx`'s `CATALOG_SCAN_LANGUAGE_CHIP_OPTIONS`.
    // The accessible name joins the label text node and the nested
    // annotation `<span>` with a space (RTL's accessible-name computation),
    // hence the space before the full-width parenthesis below.
    for (const code of ["it", "fil", "ms", "tr"]) {
      const chip = screen.getByRole("button", { name: new RegExp(`^${code} （仅索引不建内容）$`) });
      expect(chip).toBeTruthy();
    }
    // A registered site locale (already covered above via label "英文") must
    // never carry the annotation.
    expect(screen.getByRole("button", { name: "英文" }).textContent).not.toContain("仅索引不建内容");
  });

  it("非站点语种 chip 仍可选中并计入语种数（languages[] 只是任务元数据，从不发上游）", async () => {
    renderForm();
    const chip = screen.getByRole("button", { name: /^it （仅索引不建内容）$/ });
    await click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "开始同步 · 1 语种" })).toBeTruthy();
  });

  // L10N P5.1 (port-registry P5 反方向登记): moboreader 18 码交集 SITE_LOCALES
  // 15 语只得 14 个——`cs` 是唯一「站点已注册、上游却没有对应码」的语种
  // （MOBOREADER_LANGUAGE_CODE_TO_LOCALE 没有任何码映射到 cs），所以它不该
  // 出现在这个 chip 组里。这不是"cs 没内容"的既有场景（active-locales.ts 的
  // "cs 无内容"是另一件事：cs 有上游文章但站点侧判定为空），是"上游压根没有
  // 这个语种的码"，chip 组渲染的是渠道源码表，不是站点语种注册表。
  it("chip 组不含 cs——moboreader 码表没有任何码映射到 cs（NO_SOURCE_SAMPLE，反方向验证）", () => {
    renderForm();
    const group = screen.getByRole("group", { name: "同步语种" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).not.toContain("捷克文");
    expect(screen.queryByRole("button", { name: "捷克文" })).toBeNull();
  });
});

describe("表单校验：不合法输入拦在提交之前，Action 不会被调用", () => {
  it("一个语种都没选 → 报错，不提交", async () => {
    renderForm();
    await submit();
    expect(screen.getByText("请至少选择一种语种")).toBeTruthy();
    expect(actions.applyCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("选中语种后重新提交，错误提示消失", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-1", mode: "apply" }),
    );
    renderForm();
    await submit();
    expect(screen.getByText("请至少选择一种语种")).toBeTruthy();

    await click(languageChip("英文"));
    await submit();

    expect(screen.queryByText("请至少选择一种语种")).toBeNull();
    expect(actions.applyCatalogScanTaskAction).toHaveBeenCalledTimes(1);
  });
});

describe("提交只走 apply，语种数组进入 payload", () => {
  it("以正确参数调用 applyCatalogScanTaskAction，且从不调用 dryRunCatalogScanTaskAction", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-1", mode: "apply" }),
    );
    renderForm();
    await click(languageChip("英文"));
    await click(languageChip("日文"));
    await submit();

    expect(actions.applyCatalogScanTaskAction).toHaveBeenCalledTimes(1);
    const call = actions.applyCatalogScanTaskAction.mock.calls[0][0];
    expect(call.channelAccountId).toBe("acct-1");
    expect(call.channelAppId).toBe("app-1");
    expect(new Set(call.languages)).toEqual(new Set(["en", "ja"]));
    expect(call.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
    // Phase B removed page mechanics from the client-supplied contract —
    // this form must never (re-)introduce them.
    expect(call).not.toHaveProperty("pageStart");
    expect(call).not.toHaveProperty("pageEnd");
    expect(call).not.toHaveProperty("pageSize");
    expect(call).not.toHaveProperty("mode");
  });

  it("提交中禁用按钮并显示「同步中…」", async () => {
    let resolve!: (value: unknown) => void;
    actions.applyCatalogScanTaskAction.mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    renderForm();
    await click(languageChip("英文"));

    fireEvent.submit(submitButton().closest("form")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "同步中…" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "同步中…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolve(okResult({ outcome: "created", taskId: "task-1", mode: "apply" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("scan-outcome-created")).toBeTruthy();
  });
});

describe("表单不再渲染模式 / 分页字段", () => {
  it("没有「模式」下拉，也没有起始页/结束页/每页条数输入框", () => {
    renderForm();
    expect(screen.queryByLabelText("模式")).toBeNull();
    expect(screen.queryByLabelText("起始页")).toBeNull();
    expect(screen.queryByLabelText("结束页")).toBeNull();
    expect(screen.queryByLabelText("每页条数")).toBeNull();
    expect(screen.queryByText(/dry_run/)).toBeNull();
  });
});

describe("缺少 content:publish", () => {
  it("按钮禁用，并说明原因", async () => {
    renderForm({
      contentPublishGranted: false,
      contentPublishBlockedReason: "缺少能力位 内容发布（content:publish），请联系管理员授予",
    });
    await click(languageChip("英文"));

    const button = submitButton();
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/缺少能力位 内容发布/)).toBeTruthy();

    await click(button);
    expect(actions.applyCatalogScanTaskAction).not.toHaveBeenCalled();
  });
});

describe("四种结果分支各自独立呈现", () => {
  beforeEach(async () => {
    renderForm();
    await click(languageChip("英文"));
  });

  it("created：成功语气", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-created-1", mode: "apply" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-created");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.textContent).toContain("已入队");
  });

  it("created_disabled：展示两个 flag 各自的开关状态，且都能在 DOM 里找到", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({
        outcome: "created_disabled",
        taskId: "task-disabled-1",
        mode: "apply",
        flags: { featureEnabled: false, writeAllowed: false },
      }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-created_disabled");
    expect(panel.textContent).toContain("disabled");
    expect(screen.getByTestId("flag-row-FEATURE_NOVEL_CATALOG_SYNC").textContent).toContain("未开启");
    expect(screen.getByTestId("flag-row-NOVEL_CATALOG_SYNC_ALLOW_WRITE").textContent).toContain("未开启");
  });

  it("created：内联渲染 ImportProgress 进度卡，并给出「前往任务中心」「查看推广链接」入口 (C-6)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network stub: not exercised by this assertion")));
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-created-progress", mode: "apply" }),
    );
    await submit();

    expect(screen.getByTestId("import-progress-task-id").textContent).toContain("task-created-progress");
    expect(screen.getByRole("link", { name: "前往任务中心 →" }).getAttribute("href")).toBe("/tasks");
    expect(screen.getByRole("link", { name: "查看推广链接 →" }).getAttribute("href")).toBe("/promo-links");
  });

  it("created_disabled：同样携带 taskId，也内联渲染进度卡 (C-6)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network stub: not exercised by this assertion")));
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({
        outcome: "created_disabled",
        taskId: "task-disabled-progress",
        mode: "apply",
        flags: { featureEnabled: false, writeAllowed: false },
      }),
    );
    await submit();

    expect(screen.getByTestId("import-progress-task-id").textContent).toContain("task-disabled-progress");
  });

  it("进度卡到达终态时调用 router.refresh() 刷新来源条目列表 (C-6 onTerminal)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          taskType: "catalog_scan",
          status: "completed",
          total: 1,
          success: 1,
          failed: 0,
          skip: 0,
          processed: 1,
          percent: 100,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          taskErrors: [],
          items: [],
        }),
      }),
    );
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-terminal-progress", mode: "apply" }),
    );
    await submit();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("duplicate：幂等提示，不是失败语气", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "duplicate", taskId: "task-dup-1" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-duplicate");
    expect(panel.textContent).toContain("幂等");
  });

  it("active_conflict：说明已有进行中任务", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "active_conflict", taskId: "task-conflict-1" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-active_conflict");
    expect(panel.textContent).toContain("进行中");
  });

  it("不再渲染「建设中」文案或 SQL 查询指引", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-sql-check", mode: "apply" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-created");
    expect(panel.textContent).not.toContain("catalog_scan_task");
    expect(panel.textContent).not.toContain("建设中");
    expect(screen.queryByText(/select /)).toBeNull();
  });
});

describe("守卫失败 / 输入校验失败——各自独立呈现，不是笼统的失败提示", () => {
  it("access_denied：文案来自 errorEnvelopeCopy，能力位名称清晰可读", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "content:view" },
      },
    });
    renderForm();
    await click(languageChip("英文"));
    await submit();

    expect(screen.getByRole("alert").textContent).toContain("缺少能力位 内容查看（content:view）");
  });

  it("invalid_input：已知 code 翻成可操作的中文提示", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "languages_invalid",
    });
    renderForm();
    await click(languageChip("英文"));
    await submit();

    expect(screen.getByRole("alert").textContent).toContain("语种选择无效");
  });

  it("invalid_input：未知 code 也不裸打代码——落到兜底文案且原样带出 code 供排查", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "some_future_code",
    });
    renderForm();
    await click(languageChip("英文"));
    await submit();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("some_future_code");
    expect(alert.textContent).toContain("输入无效");
  });
});
