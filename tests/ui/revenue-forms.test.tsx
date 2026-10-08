import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RangeFilter } from "@/app/(admin)/revenue/_components/range-filter";
import { dialogCalls, installDialogShim } from "./jsdom-dialog";

/**
 * `/revenue` 的两个 client 组件：区间筛选（GET 表单）与同步表单（确认弹窗 → server action）。
 * 只替换 server action 与路由；组件、校验、文案、`ConfirmDialog` 都是真的。
 */

installDialogShim();

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const actions = vi.hoisted(() => ({ enqueueRevenueSyncAction: vi.fn() }));
vi.mock("@/app/(admin)/revenue/_actions", () => actions);

const { SyncForm } = await import("@/app/(admin)/revenue/_components/sync-form");

const TODAY = "2026-10-08";
const TASK_ID = "50000000-0000-4000-8000-0000000000bb";
const EXISTING_ID = "60000000-0000-4000-8000-0000000000cc";

function renderSyncForm(overrides: { blocked?: boolean; defaultBegin?: string; defaultEnd?: string } = {}) {
  return render(
    <SyncForm
      today={TODAY}
      defaultBegin={overrides.defaultBegin ?? "2026-10-02"}
      defaultEnd={overrides.defaultEnd ?? "2026-10-08"}
      blocked={overrides.blocked ?? false}
    />,
  );
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /发起同步|提交中/ }) as HTMLButtonElement;
}

function dialog(): HTMLDialogElement {
  return document.querySelector("dialog") as HTMLDialogElement;
}

async function setDate(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  });
}

async function clickSubmit(): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByTestId("revenue-sync-form"));
  });
}

async function confirm(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(dialog()).getByRole("button", { name: "确认同步" }));
  });
}

beforeEach(() => {
  actions.enqueueRevenueSyncAction.mockReset();
  routerRefresh.mockClear();
});

describe("SyncForm · 默认值与禁用", () => {
  it("默认区间来自 props（最近 7 天，结束于今天），显示共 7 天", () => {
    renderSyncForm();
    expect((screen.getByLabelText("同步开始日期") as HTMLInputElement).value).toBe("2026-10-02");
    expect((screen.getByLabelText("同步结束日期") as HTMLInputElement).value).toBe("2026-10-08");
    expect(screen.getByTestId("revenue-sync-form").textContent).toContain("共 7 天");
    expect(submitButton().disabled).toBe(false);
  });

  it("blocked（已有活跃任务 / 没有账号）：按钮与日期输入都禁用，提交不会打开弹窗也不会调用 action", async () => {
    renderSyncForm({ blocked: true });
    expect(submitButton().disabled).toBe(true);
    expect((screen.getByLabelText("同步开始日期") as HTMLInputElement).disabled).toBe(true);
    await clickSubmit();
    expect(dialogCalls(dialog()).showModal).toBe(0);
    expect(actions.enqueueRevenueSyncAction).not.toHaveBeenCalled();
  });
});

describe("SyncForm · 提交前校验（以服务端为准，这里只省一次往返）", () => {
  it.each([
    ["反向", "2026-10-08", "2026-10-02", "开始日期不能晚于结束日期"],
    ["跨度超过 92 天", "2026-07-08", "2026-10-08", "不能超过 92 天"],
    ["结束日期在未来", "2026-10-02", "2026-10-09", "不能晚于今天"],
    ["日期为空", "", "2026-10-08", "日期格式不正确"],
  ])("%s：显示原因，不弹确认，不调用 action", async (_label, begin, end, message) => {
    renderSyncForm();
    await setDate("同步开始日期", begin);
    await setDate("同步结束日期", end);
    await clickSubmit();

    expect(screen.getByTestId("revenue-sync-field-error").textContent).toContain(message);
    expect(dialogCalls(dialog()).showModal).toBe(0);
    expect(actions.enqueueRevenueSyncAction).not.toHaveBeenCalled();
  });

  it("改动日期后，旧的校验提示随之消失", async () => {
    renderSyncForm();
    await setDate("同步开始日期", "2026-10-09");
    await clickSubmit();
    expect(screen.getByTestId("revenue-sync-field-error")).toBeTruthy();
    await setDate("同步开始日期", "2026-10-02");
    expect(screen.queryByTestId("revenue-sync-field-error")).toBeNull();
  });

  it("恰好 92 天可以通过", async () => {
    renderSyncForm();
    await setDate("同步开始日期", "2026-07-09");
    await clickSubmit();
    expect(screen.queryByTestId("revenue-sync-field-error")).toBeNull();
    expect(dialogCalls(dialog()).showModal).toBe(1);
  });
});

describe("SyncForm · 确认弹窗", () => {
  it("提交 → 先弹确认，正文写明只读查询与区间天数；取消则不调用 action", async () => {
    renderSyncForm();
    await clickSubmit();

    expect(dialogCalls(dialog()).showModal).toBe(1);
    expect(dialog().open).toBe(true);
    expect(screen.getByTestId("revenue-sync-confirm-body").textContent).toBe(
      "将向上游发起只读查询，同步 2026-10-02 ~ 2026-10-08 共 7 天。",
    );
    expect(actions.enqueueRevenueSyncAction).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    });
    expect(dialog().open).toBe(false);
    expect(actions.enqueueRevenueSyncAction).not.toHaveBeenCalled();
  });

  it("改过日期后，弹窗正文跟着变", async () => {
    renderSyncForm();
    await setDate("同步开始日期", "2026-10-06");
    await clickSubmit();
    expect(screen.getByTestId("revenue-sync-confirm-body").textContent).toContain("2026-10-06 ~ 2026-10-08 共 3 天");
  });
});

describe("SyncForm · 提交结果", () => {
  it("成功：调用 action（区间 + 一次性 requestId），提示任务链接，刷新页面，按钮保持禁用", async () => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({ ok: true, data: { taskId: TASK_ID, duplicate: false } });
    renderSyncForm();
    await clickSubmit();
    await confirm();

    await waitFor(() => expect(screen.getByTestId("revenue-sync-created")).toBeTruthy());
    expect(actions.enqueueRevenueSyncAction).toHaveBeenCalledTimes(1);
    const input = actions.enqueueRevenueSyncAction.mock.calls[0]![0] as {
      beginDate: string;
      endDate: string;
      requestId: string;
    };
    expect(input.beginDate).toBe("2026-10-02");
    expect(input.endDate).toBe("2026-10-08");
    expect(input.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // 入队幂等令牌由服务端生成，客户端不传。
    expect(Object.keys(input).sort()).toEqual(["beginDate", "endDate", "requestId"]);

    const created = screen.getByTestId("revenue-sync-created");
    expect(created.textContent).toContain("同步任务已创建");
    expect(within(created).getByRole("link").getAttribute("href")).toBe(`/tasks/${TASK_ID}`);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(submitButton().disabled).toBe(true);
    expect(dialog().open).toBe(false);
  });

  it("命中既有任务（duplicate）：如实说明", async () => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({ ok: true, data: { taskId: TASK_ID, duplicate: true } });
    renderSyncForm();
    await clickSubmit();
    await confirm();
    await waitFor(() => expect(screen.getByTestId("revenue-sync-created")).toBeTruthy());
    expect(screen.getByTestId("revenue-sync-created").textContent).toContain("命中了已有的同步任务");
  });

  it.each([
    ["channel_account_unavailable", "没有可用的海阅渠道账号"],
    ["channel_account_ambiguous", "海阅渠道账号不止一个"],
    ["invalid_date_range", "同步区间无效"],
    ["invalid_request", "请求无效"],
    ["request_token_conflict", "请求标识冲突"],
  ])("后端 code %s → 中文原因，不刷新页面", async (code, expected) => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({ ok: false, kind: "enqueue_failed", code });
    renderSyncForm();
    await clickSubmit();
    await confirm();

    await waitFor(() => expect(screen.getByTestId("revenue-sync-failed")).toBeTruthy());
    const failed = screen.getByTestId("revenue-sync-failed");
    expect(failed.textContent).toContain(expected);
    expect(failed.textContent).not.toContain(code);
    expect(routerRefresh).not.toHaveBeenCalled();
    // 失败后可以改了再试：按钮没有被锁死。
    expect(submitButton().disabled).toBe(false);
  });

  it("revenue_sync_already_active：说明原因、链到既有任务，并刷新页面让活跃任务显示出来", async () => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({
      ok: false,
      kind: "enqueue_failed",
      code: "revenue_sync_already_active",
      existingTaskId: EXISTING_ID,
    });
    renderSyncForm();
    await clickSubmit();
    await confirm();

    await waitFor(() => expect(screen.getByTestId("revenue-sync-failed")).toBeTruthy());
    const failed = screen.getByTestId("revenue-sync-failed");
    expect(failed.textContent).toContain("已有同步任务在排队或执行中");
    expect(within(failed).getByRole("link").getAttribute("href")).toBe(`/tasks/${EXISTING_ID}`);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("未知 code：显示原文，而不是编一句话", async () => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({ ok: false, kind: "enqueue_failed", code: "brand_new_code" });
    renderSyncForm();
    await clickSubmit();
    await confirm();
    await waitFor(() => expect(screen.getByTestId("revenue-sync-failed")).toBeTruthy());
    expect(screen.getByTestId("revenue-sync-failed").textContent).toContain("brand_new_code");
  });

  it("2FA 过期（access_denied 信封）：显示前端自有文案", async () => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      envelope: { code: "admin_two_factor_required", status: 403 },
    });
    renderSyncForm();
    await clickSubmit();
    await confirm();
    await waitFor(() => expect(screen.getByTestId("revenue-sync-failed")).toBeTruthy());
    expect(screen.getByTestId("revenue-sync-failed").textContent).toContain("双重验证");
  });

  it("缺能力位（access_denied）：点名能力位", async () => {
    actions.enqueueRevenueSyncAction.mockResolvedValue({
      ok: false,
      kind: "access_denied",
      envelope: { code: "admin_capability_denied", status: 403, details: { capability: "revenue:view" } },
    });
    renderSyncForm();
    await clickSubmit();
    await confirm();
    await waitFor(() => expect(screen.getByTestId("revenue-sync-failed")).toBeTruthy());
    expect(screen.getByTestId("revenue-sync-failed").textContent).toContain("revenue:view");
  });

  it("action 抛异常（网络断开等）：给出通用提示，不读异常 message", async () => {
    actions.enqueueRevenueSyncAction.mockRejectedValue(new Error("secret driver detail"));
    renderSyncForm();
    await clickSubmit();
    await confirm();
    await waitFor(() => expect(screen.getByTestId("revenue-sync-failed")).toBeTruthy());
    const failed = screen.getByTestId("revenue-sync-failed");
    expect(failed.textContent).toContain("提交失败");
    expect(failed.textContent).not.toContain("secret driver detail");
  });
});

describe("RangeFilter · GET 表单与快捷项", () => {
  function renderFilter() {
    return render(<RangeFilter dateFrom="2026-09-09" dateTo="2026-10-08" today={TODAY} />);
  }

  it("原生 GET 表单，字段名就是 from / to，带当前值", () => {
    renderFilter();
    const form = screen.getByRole("search");
    expect(form.getAttribute("method")?.toLowerCase()).toBe("get");
    const from = screen.getByLabelText("开始日期") as HTMLInputElement;
    const to = screen.getByLabelText("结束日期") as HTMLInputElement;
    expect(from.name).toBe("from");
    expect(to.name).toBe("to");
    expect(from.value).toBe("2026-09-09");
    expect(to.value).toBe("2026-10-08");
    expect(to.max).toBe(TODAY);
  });

  it("快捷项：最近 7 / 30 / 90 天，都以北京时间今天结束；当前区间那一项高亮", () => {
    renderFilter();
    const hrefs = Object.fromEntries(
      ["最近 7 天", "最近 30 天", "最近 90 天"].map((name) => [
        name,
        screen.getByRole("link", { name }).getAttribute("href"),
      ]),
    );
    expect(hrefs).toEqual({
      "最近 7 天": "/revenue?from=2026-10-02&to=2026-10-08",
      "最近 30 天": "/revenue?from=2026-09-09&to=2026-10-08",
      "最近 90 天": "/revenue?from=2026-07-11&to=2026-10-08",
    });
    expect(screen.getByRole("link", { name: "最近 30 天" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: "最近 7 天" }).getAttribute("aria-current")).toBeNull();
  });

  it("快捷项区间自己通过页面校验（90 天 ≤ 92 天）", () => {
    renderFilter();
    const href = screen.getByRole("link", { name: "最近 90 天" }).getAttribute("href")!;
    const params = new URLSearchParams(href.split("?")[1]);
    const days = (Date.parse(params.get("to")!) - Date.parse(params.get("from")!)) / 86_400_000 + 1;
    expect(days).toBeLessThanOrEqual(92);
  });

  it("反向 / 超过 92 天：拦截提交并说明原因", async () => {
    renderFilter();
    const form = screen.getByRole("search");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-10-09" } });
    });
    // fireEvent.submit 在被 preventDefault 时返回 false。
    let allowed = true;
    await act(async () => {
      allowed = fireEvent.submit(form);
    });
    expect(allowed).toBe(false);
    expect(screen.getByTestId("revenue-range-error").textContent).toContain("开始日期不能晚于结束日期");

    await act(async () => {
      fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-01-01" } });
    });
    await act(async () => {
      allowed = fireEvent.submit(form);
    });
    expect(allowed).toBe(false);
    expect(screen.getByTestId("revenue-range-error").textContent).toContain("不能超过 92 天");
  });

  it("合法区间：放行原生提交（不 preventDefault）", async () => {
    renderFilter();
    let allowed = false;
    await act(async () => {
      allowed = fireEvent.submit(screen.getByRole("search"));
    });
    expect(allowed).toBe(true);
    expect(screen.queryByTestId("revenue-range-error")).toBeNull();
  });
});
