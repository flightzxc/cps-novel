import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAppScanOption } from "@/app/(admin)/catalog-sync/_lib/read-channel-apps";

/**
 * `CatalogScanTriggerForm` (PR-C2) — the "新建目录扫描任务" block on
 * `/catalog-sync`. Same double-replacement discipline as
 * `catalog-sync-client.test.tsx`: only the Server Action module
 * (`../_actions`) is mocked, so this file only records which action got
 * called with what, and what the component renders back — every branch
 * (validation, mode default, four outcomes, access-denied, flag-off copy)
 * is driven by the real component and the real `scan-task-copy.ts`.
 */

const actions = vi.hoisted(() => ({
  dryRunCatalogScanTaskAction: vi.fn(),
  applyCatalogScanTaskAction: vi.fn(),
}));

vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);

const { CatalogScanTriggerForm } = await import(
  "@/app/(admin)/catalog-sync/_components/catalog-scan-trigger-form"
);

function app(overrides: Partial<ChannelAppScanOption> = {}): ChannelAppScanOption {
  return {
    id: "app-1",
    channelCode: "moboreader",
    channelName: "Moboreader",
    sourceAppCode: "mobo-app-1",
    sourceAppName: "Mobo App",
    channelAccounts: [{ id: "acct-1", businessId: "biz-1", accountName: "主账户" }],
    ...overrides,
  };
}

const APPS: readonly ChannelAppScanOption[] = [
  app(),
  app({
    id: "app-2",
    channelCode: "changdu",
    channelName: "畅读",
    sourceAppCode: "cd-app-1",
    sourceAppName: "CD App",
    channelAccounts: [
      { id: "acct-2a", businessId: "biz-2a", accountName: "畅读账户 A" },
      { id: "acct-2b", businessId: "biz-2b", accountName: "畅读账户 B" },
    ],
  }),
];

function okResult<T>(data: T) {
  return { ok: true as const, data };
}

function renderForm(
  options: {
    channelApps?: readonly ChannelAppScanOption[];
    contentPublishGranted?: boolean;
    contentPublishBlockedReason?: string | null;
    maxPageSize?: number;
    safetyMaxPages?: number;
  } = {},
) {
  return render(
    <CatalogScanTriggerForm
      channelApps={options.channelApps ?? APPS}
      contentPublishGranted={options.contentPublishGranted ?? true}
      contentPublishBlockedReason={options.contentPublishBlockedReason ?? null}
      maxPageSize={options.maxPageSize ?? 100}
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
  return screen.getByRole("button", { name: /创建扫描任务/ }) as HTMLButtonElement;
}

async function submit(): Promise<void> {
  await click(submitButton());
}

beforeEach(() => {
  actions.dryRunCatalogScanTaskAction.mockReset();
  actions.applyCatalogScanTaskAction.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("没有可用的活跃渠道应用", () => {
  it("不渲染表单，只给出去配置渠道账户的指引，且不触碰任何 Action", async () => {
    renderForm({ channelApps: [] });
    expect(screen.getByTestId("catalog-scan-no-channel-apps")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /创建扫描任务/ })).toBeNull();
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
  });
});

describe("默认态：dry_run 缺省，字段有合理初值", () => {
  it("模式默认是 dry_run，提交按钮文案随之显示 dry_run", () => {
    renderForm();
    expect((screen.getByLabelText("模式") as HTMLSelectElement).value).toBe("dry_run");
    expect(screen.getByRole("button", { name: "创建扫描任务（dry_run）" })).toBeTruthy();
  });

  it("渠道应用与渠道账户默认选中第一项", () => {
    renderForm();
    expect((screen.getByLabelText("渠道应用") as HTMLSelectElement).value).toBe("app-1");
    expect((screen.getByLabelText("渠道账户") as HTMLSelectElement).value).toBe("acct-1");
  });

  it("切换渠道应用会把渠道账户重置为新应用的第一个账户", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("渠道应用"), { target: { value: "app-2" } });
    expect((screen.getByLabelText("渠道账户") as HTMLSelectElement).value).toBe("acct-2a");
    expect(within(screen.getByLabelText("渠道账户") as HTMLElement).getAllByRole("option")).toHaveLength(2);
  });

  it("渠道下没有启用中的账户时，账户下拉禁用并显示占位项", () => {
    renderForm({ channelApps: [app({ channelAccounts: [] })] });
    const select = screen.getByLabelText("渠道账户") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(within(select).getByText("（该渠道下没有启用中的账户）")).toBeTruthy();
  });

  it("安全页数上限会显示在说明文案里", () => {
    renderForm({ safetyMaxPages: 500 });
    expect(screen.getByText(/500 页/)).toBeTruthy();
  });
});

describe("表单校验：不合法输入拦在提交之前，Action 不会被调用", () => {
  it("结束页小于起始页 → 报错在结束页字段，不提交", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("起始页"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("结束页"), { target: { value: "2" } });
    await submit();

    expect(screen.getByText("结束页码不能小于起始页码")).toBeTruthy();
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("每页条数超过上限 → 报错带出具体上限数字", async () => {
    renderForm({ maxPageSize: 50 });
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "999" } });
    await submit();

    expect(screen.getByText("每页条数不能超过 50")).toBeTruthy();
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("起始页为 0 或负数 → 报错，视为非法整数", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("起始页"), { target: { value: "0" } });
    await submit();

    expect(screen.getByText("起始页码必须是大于 0 的整数")).toBeTruthy();
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("每页条数留空 → 报错，视为非法整数", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "" } });
    await submit();

    expect(screen.getByText("每页条数必须是大于 0 的整数")).toBeTruthy();
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("修正后重新提交，错误提示消失", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("起始页"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("结束页"), { target: { value: "2" } });
    await submit();
    expect(screen.getByText("结束页码不能小于起始页码")).toBeTruthy();

    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-1", mode: "dry_run" }),
    );
    fireEvent.change(screen.getByLabelText("结束页"), { target: { value: "10" } });
    await submit();

    expect(screen.queryByText("结束页码不能小于起始页码")).toBeNull();
    expect(actions.dryRunCatalogScanTaskAction).toHaveBeenCalledTimes(1);
  });
});

describe("提交 · dry_run（默认模式）", () => {
  it("以正确参数调用 dryRunCatalogScanTaskAction，且从不调用 applyCatalogScanTaskAction", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-1", mode: "dry_run" }),
    );
    renderForm();
    fireEvent.change(screen.getByLabelText("起始页"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("结束页"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "30" } });
    await submit();

    expect(actions.dryRunCatalogScanTaskAction).toHaveBeenCalledTimes(1);
    const call = actions.dryRunCatalogScanTaskAction.mock.calls[0][0];
    expect(call).toMatchObject({
      channelAccountId: "acct-1",
      channelAppId: "app-1",
      pageStart: 2,
      pageEnd: 6,
      pageSize: 30,
    });
    expect(call.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(actions.applyCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("提交中禁用按钮并显示「创建中…」", async () => {
    let resolve!: (value: unknown) => void;
    actions.dryRunCatalogScanTaskAction.mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    renderForm();

    fireEvent.submit(screen.getByRole("button", { name: /创建扫描任务/ }).closest("form")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "创建中…" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "创建中…" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolve(okResult({ outcome: "created", taskId: "task-1", mode: "dry_run" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("scan-outcome-created")).toBeTruthy();
  });
});

describe("提交 · apply（切换模式后）", () => {
  it("有 content:publish 时调用 applyCatalogScanTaskAction，不调用 dry_run", async () => {
    actions.applyCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-9", mode: "apply" }),
    );
    renderForm({ contentPublishGranted: true });
    fireEvent.change(screen.getByLabelText("模式"), { target: { value: "apply" } });
    await submit();

    expect(actions.applyCatalogScanTaskAction).toHaveBeenCalledTimes(1);
    expect(actions.dryRunCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("缺少 content:publish 时切到 apply 会禁用提交按钮，并说明原因；点不动也就调不到 Action", async () => {
    renderForm({
      contentPublishGranted: false,
      contentPublishBlockedReason: "缺少能力位 内容发布（content:publish），请联系管理员授予",
    });
    fireEvent.change(screen.getByLabelText("模式"), { target: { value: "apply" } });

    const button = screen.getByRole("button", { name: "创建扫描任务（apply）" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/缺少能力位 内容发布/)).toBeTruthy();
    expect(screen.getByText("仍可创建 dry_run 任务。")).toBeTruthy();

    await click(button);
    expect(actions.applyCatalogScanTaskAction).not.toHaveBeenCalled();
  });

  it("缺少 content:publish 但仍是 dry_run 模式时，提交按钮不受影响", () => {
    renderForm({ contentPublishGranted: false, contentPublishBlockedReason: "缺少能力位 内容发布" });
    const button = screen.getByRole("button", { name: "创建扫描任务（dry_run）" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

describe("四种结果分支各自独立呈现", () => {
  beforeEach(() => {
    renderForm();
  });

  it("created：成功语气，展示模式与后续查询指引", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-created-1", mode: "dry_run" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-created");
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.textContent).toContain("已入队");
    expect(panel.textContent).toContain("task-created-1");
  });

  it("created_disabled：展示两个 flag 各自的开关状态，且都能在 DOM 里找到", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({
        outcome: "created_disabled",
        taskId: "task-disabled-1",
        mode: "dry_run",
        flags: { featureEnabled: false, writeAllowed: false },
      }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-created_disabled");
    expect(panel.textContent).toContain("disabled");
    expect(screen.getByTestId("flag-row-FEATURE_NOVEL_CATALOG_SYNC").textContent).toContain("未开启");
    expect(screen.getByTestId("flag-row-NOVEL_CATALOG_SYNC_ALLOW_WRITE").textContent).toContain("未开启");
  });

  it("created_disabled：两个闸各自独立展示，不是绑在一起——总闸开、写闸关的组合也要如实呈现", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({
        outcome: "created_disabled",
        taskId: "task-disabled-2",
        mode: "apply",
        flags: { featureEnabled: true, writeAllowed: false },
      }),
    );
    await submit();

    expect(screen.getByTestId("flag-row-FEATURE_NOVEL_CATALOG_SYNC").textContent).toContain("已开启");
    expect(screen.getByTestId("flag-row-NOVEL_CATALOG_SYNC_ALLOW_WRITE").textContent).toContain("未开启");
  });

  it("duplicate：幂等提示，不是失败语气", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "duplicate", taskId: "task-dup-1" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-duplicate");
    expect(panel.textContent).toContain("幂等");
  });

  it("active_conflict：说明已有进行中任务，提示等待或稍后重试", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "active_conflict", taskId: "task-conflict-1" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-active_conflict");
    expect(panel.textContent).toContain("task-conflict-1");
  });

  it("每种结果都带出只读 SQL 查询指引，taskId 出现在 WHERE 子句里", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue(
      okResult({ outcome: "created", taskId: "task-sql-check", mode: "dry_run" }),
    );
    await submit();

    const panel = screen.getByTestId("scan-outcome-created");
    expect(within(panel).getByText(/catalog_scan_task/).textContent).toContain("task-sql-check");
  });
});

describe("守卫失败 / 输入校验失败——各自独立呈现，不是笼统的失败提示", () => {
  it("access_denied：文案来自 errorEnvelopeCopy，能力位名称清晰可读", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue({
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
    await submit();

    expect(screen.getByRole("alert").textContent).toContain("缺少能力位 内容查看（content:view）");
  });

  it("invalid_input：已知 code 翻成可操作的中文提示", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "page_size_exceeded",
    });
    renderForm();
    await submit();

    expect(screen.getByRole("alert").textContent).toContain("每页条数超过上限");
  });

  it("invalid_input：未知 code 也不裸打代码——落到兜底文案且原样带出 code 供排查", async () => {
    actions.dryRunCatalogScanTaskAction.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      code: "some_future_code",
    });
    renderForm();
    await submit();

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("some_future_code");
    expect(alert.textContent).toContain("输入无效");
  });
});
