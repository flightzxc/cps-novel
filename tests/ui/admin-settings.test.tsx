import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSiteSettingView } from "@/server/site-settings";

import { SiteSettingsClient } from "@/app/(admin)/settings/_components/site-settings-client";

/**
 * `/settings` 页（PR-C4）的渲染与接线验收。
 *
 * 写走的是 `/api/admin/site-settings` HTTP 路由（不是 Server Action——
 * `SITE_SETTING_ENTRY_ID` 是 `admin.api.site_settings` 这种 Route 风格 id，
 * 绑定检查要求走 Route Handler），所以这里只替身 `fetch`，不替身任何 Action
 * 模块；`adminFetch` 本身也不替身，让 envelope 解析、`x-request-id` 生成、
 * `credentials:"same-origin"` 全走真实实现。
 */

const BASE_SETTING: AdminSiteSettingView = {
  siteName: "CPS Novel",
  siteDescription: "Published novels.",
  homeMetaTitle: "CPS Novel",
  homeMetaDescription: "Published novels.",
  defaultOgImage: "https://cdn.example.com/default-og.jpg",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const CONFIGURED_INDEXNOW_SETTING: AdminSiteSettingView = {
  ...BASE_SETTING,
  indexNowHost: "novel.example.com",
  indexNowKey: "old-key-value",
  indexNowKeyLocation: "https://novel.example.com/indexnow-key.txt",
};

function renderClient(
  options: {
    setting?: AdminSiteSettingView | null;
    settingsManage?: "granted" | "denied" | "two_factor_required";
    expectedIndexNowHost?: string | null;
    expectedIndexNowKeyLocation?: string | null;
  } = {},
) {
  return render(
    <SiteSettingsClient
      setting={options.setting === undefined ? BASE_SETTING : options.setting}
      settingsManage={options.settingsManage ?? "granted"}
      expectedIndexNowHost={options.expectedIndexNowHost ?? "novel.example.com"}
      expectedIndexNowKeyLocation={
        options.expectedIndexNowKeyLocation ?? "https://novel.example.com/indexnow-key.txt"
      }
    />,
  );
}

function ogForm(): HTMLElement {
  return screen.getByRole("form", { name: "保存 OG 兜底图" });
}

function indexNowForm(): HTMLElement {
  return screen.getByRole("form", { name: "保存 IndexNow 配置" });
}

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

/** 按调用顺序返回排队的响应；最后一个响应会在队列耗尽后重复返回。 */
function queueFetch(...entries: Array<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  let cursor = 0;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const entry = entries[Math.min(cursor, entries.length - 1)];
    cursor += 1;
    return new Response(JSON.stringify(entry.body), { status: entry.status ?? 200 });
  });
  vi.stubGlobal("fetch", spy);
  return { spy, calls };
}

function parseBody(call: FetchCall | undefined): Record<string, unknown> {
  if (!call?.init?.body) throw new Error("no body on this fetch call");
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headerOf(call: FetchCall | undefined, name: string): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

async function type(input: Element, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

async function submit(form: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.submit(form);
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: null }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("读：能力位闸门", () => {
  it("settings:manage denied 时不渲染任何设置数据，只说明缺的能力位", () => {
    renderClient({ setting: null, settingsManage: "denied" });
    const notice = screen.getByTestId("settings-capability-denied");
    expect(notice.textContent).toContain("settings:manage");
    expect(notice.textContent).toContain("站点设置管理");
    expect(screen.queryByText("OG 兜底图")).toBeNull();
    expect(screen.queryByText("IndexNow 推送配置")).toBeNull();
  });

  it("two_factor_required 与 denied 是两种不同的说法", () => {
    renderClient({ setting: null, settingsManage: "two_factor_required" });
    const notice = screen.getByTestId("settings-capability-denied");
    expect(notice.textContent).toContain("双重验证");
    expect(notice.textContent).toContain("settings:manage");
  });
});

describe("读：OG 兜底图区", () => {
  it("为空时显著警示会导致首页/浏览页无法访问，且不渲染预览图", () => {
    renderClient({ setting: { ...BASE_SETTING, defaultOgImage: "" } });
    const warning = screen.getByTestId("og-empty-warning");
    expect(warning.textContent).toContain("未配置将导致首页 / 浏览页无法访问");
    expect(within(ogForm()).queryByAltText("OG 兜底图预览")).toBeNull();
  });

  it("有值时渲染预览图并且不显示空值警示", () => {
    renderClient();
    expect(screen.queryByTestId("og-empty-warning")).toBeNull();
    const preview = within(ogForm()).getByAltText("OG 兜底图预览") as HTMLImageElement;
    expect(preview.src).toBe(BASE_SETTING.defaultOgImage);
  });
});

describe("读：IndexNow 配置区", () => {
  it("三字段全空时标为未配置，不是警示态", () => {
    renderClient();
    expect(screen.getByText("未配置")).toBeTruthy();
    expect(screen.queryByText("已配置")).toBeNull();
  });

  it("三字段都填了才标为已配置", () => {
    renderClient({ setting: CONFIGURED_INDEXNOW_SETTING });
    expect(screen.getByText("已配置")).toBeTruthy();
  });

  it("运营指引写明 host 对齐 SITE_URL、keyLocation 指向 /indexnow-key.txt、填字段不等于开闸", () => {
    renderClient();
    const guidance = indexNowForm().parentElement!;
    expect(guidance.textContent).toContain("novel.example.com");
    expect(guidance.textContent).toContain("/indexnow-key.txt");
    expect(guidance.textContent).toContain("填了这三个字段 ≠ 开启 IndexNow 推送");
    expect(guidance.textContent).toContain("部署 env");
  });
});

describe("写：字段级编辑——只发改动的字段", () => {
  it("只改 OG 图时，PATCH 只带 defaultOgImage，不带任何 indexNow 字段", async () => {
    const { calls } = queueFetch({
      body: {
        ok: true,
        data: { setting: { ...BASE_SETTING, defaultOgImage: "https://cdn.example.com/new.jpg" }, replayed: false },
      },
    });
    renderClient();

    await type(within(ogForm()).getByLabelText("图片地址"), "https://cdn.example.com/new.jpg");
    await type(within(ogForm()).getByLabelText("修改原因（必填，写入审计）"), "补齐兜底图");
    await submit(ogForm());

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = parseBody(calls[0]);
    expect(body).toMatchObject({
      expectedUpdatedAt: BASE_SETTING.updatedAt,
      reason: "补齐兜底图",
      defaultOgImage: "https://cdn.example.com/new.jpg",
    });
    expect(body).not.toHaveProperty("indexNowHost");
    expect(body).not.toHaveProperty("indexNowKey");
    expect(body).not.toHaveProperty("indexNowKeyLocation");
  });

  it("保存 OG 成功时不重置另一区未提交的 IndexNow 草稿", async () => {
    const NEXT: AdminSiteSettingView = {
      ...BASE_SETTING,
      defaultOgImage: "https://cdn.example.com/next.jpg",
      updatedAt: "2026-08-20T01:00:00.000Z",
    };
    queueFetch({ body: { ok: true, data: { setting: NEXT, replayed: false } } });
    renderClient();

    await type(within(indexNowForm()).getByLabelText("indexNowHost"), "draft.example.com");
    await type(within(ogForm()).getByLabelText("图片地址"), "https://cdn.example.com/next.jpg");
    await type(within(ogForm()).getByLabelText("修改原因（必填，写入审计）"), "更新封面");
    await submit(ogForm());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已保存"));
    expect((within(indexNowForm()).getByLabelText("indexNowHost") as HTMLInputElement).value).toBe(
      "draft.example.com",
    );
  });

  it("IndexNow 区只改一个字段时，PATCH 只带那一个字段", async () => {
    const { calls } = queueFetch({
      body: {
        ok: true,
        data: {
          setting: { ...CONFIGURED_INDEXNOW_SETTING, indexNowKey: "rotated-key" },
          replayed: false,
        },
      },
    });
    renderClient({ setting: CONFIGURED_INDEXNOW_SETTING });

    await type(within(indexNowForm()).getByLabelText("indexNowKey"), "rotated-key");
    await type(
      within(indexNowForm()).getByLabelText("修改原因（必填，写入审计）"),
      "轮换 IndexNow key",
    );
    await submit(indexNowForm());

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = parseBody(calls[0]);
    expect(body).toEqual({
      expectedUpdatedAt: CONFIGURED_INDEXNOW_SETTING.updatedAt,
      reason: "轮换 IndexNow key",
      indexNowKey: "rotated-key",
    });
  });

  it("没有改动时提交按钮保持禁用，不发请求", async () => {
    const { calls } = queueFetch({ body: { ok: true, data: null } });
    renderClient();

    const button = within(ogForm()).getByRole("button", { name: "保存 OG 兜底图" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await submit(ogForm());
    expect(calls).toHaveLength(0);
  });

  it("原因为空时提交按钮保持禁用", async () => {
    renderClient();
    await type(within(ogForm()).getByLabelText("图片地址"), "https://cdn.example.com/new.jpg");
    const button = within(ogForm()).getByRole("button", { name: "保存 OG 兜底图" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("写：结果分支", () => {
  async function submitOgChange() {
    await type(within(ogForm()).getByLabelText("图片地址"), "https://cdn.example.com/next.jpg");
    await type(within(ogForm()).getByLabelText("修改原因（必填，写入审计）"), "更新封面");
    await submit(ogForm());
  }

  it("成功（非 replayed）：提示已保存，且字段回填服务端返回的最新值", async () => {
    const NEXT: AdminSiteSettingView = {
      ...BASE_SETTING,
      defaultOgImage: "https://cdn.example.com/next.jpg",
      updatedAt: "2026-08-20T01:00:00.000Z",
    };
    queueFetch({ body: { ok: true, data: { setting: NEXT, replayed: false } } });
    renderClient();
    await submitOgChange();

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已保存"));
    expect(screen.getByText(/最近更新/).textContent).toContain("2026");
  });

  it("replayed:true：文案与首次成功不同，说明未重复写入", async () => {
    const NEXT: AdminSiteSettingView = {
      ...BASE_SETTING,
      defaultOgImage: "https://cdn.example.com/next.jpg",
      updatedAt: "2026-08-20T01:00:00.000Z",
    };
    queueFetch({ body: { ok: true, data: { setting: NEXT, replayed: true } } });
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("该请求此前已生效，未重复写入"),
    );
  });

  it("乐观锁冲突：提示刷新重试，并自动发起 GET 把最新值拉回来", async () => {
    const REFRESHED: AdminSiteSettingView = {
      ...BASE_SETTING,
      defaultOgImage: "https://cdn.example.com/someone-else-set-this.jpg",
      updatedAt: "2026-08-20T02:00:00.000Z",
    };
    const { calls } = queueFetch(
      { status: 409, body: { ok: false, status: 409, code: "site_setting_conflict" } },
      { body: { ok: true, data: REFRESHED } },
    );
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("站点设置已被其他操作人修改"),
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].init?.method ?? "GET").toBe("GET");
    expect(headerOf(calls[1], "x-request-id")).toBeUndefined();

    // 自动刷新后，表单显示的是别人写入的最新值，不是本地还没提交成功的草稿。
    await waitFor(() =>
      expect(
        (within(ogForm()).getByLabelText("图片地址") as HTMLInputElement).value,
      ).toBe(REFRESHED.defaultOgImage),
    );
  });

  it("乐观锁冲突的幂等子类型（idempotency_conflict）文案不同于普通冲突，且同样触发刷新", async () => {
    const { calls } = queueFetch(
      {
        status: 409,
        body: {
          ok: false,
          status: 409,
          code: "site_setting_conflict",
          details: { reason: "idempotency_conflict" },
        },
      },
      { body: { ok: true, data: BASE_SETTING } },
    );
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("该请求标识已用于另一次不同的提交"),
    );
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("site_setting_invalid：显示参数无效文案，不触发自动刷新", async () => {
    const { calls } = queueFetch({
      status: 400,
      body: { ok: false, status: 400, code: "site_setting_invalid" },
    });
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("站点设置参数无效，请检查后重试"),
    );
    expect(calls).toHaveLength(1);
  });

  it("site_setting_not_seeded：显示单例缺失文案，不触发自动刷新", async () => {
    const { calls } = queueFetch({
      status: 500,
      body: { ok: false, status: 500, code: "site_setting_not_seeded" },
    });
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("站点设置单例缺失，请联系运维检查部署"),
    );
    expect(calls).toHaveLength(1);
  });

  it("通用错误兜底：前端不认识的 code 也不崩溃，落到兜底文案", async () => {
    queueFetch({
      status: 403,
      body: { ok: false, status: 403, code: "some_future_unmapped_code" },
    });
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("操作失败，请稍后重试"),
    );
  });

  it("已登记但与 site_setting 无关的错误码，走它自己的映射文案", async () => {
    queueFetch({
      status: 429,
      body: { ok: false, status: 429, code: "admin_rate_limited" },
    });
    renderClient();
    await submitOgChange();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("操作过于频繁"),
    );
  });
});

describe("写：request-id", () => {
  it("每次提交都带一个新的 UUID，且是 same-origin 请求", async () => {
    const NEXT: AdminSiteSettingView = {
      ...BASE_SETTING,
      defaultOgImage: "https://cdn.example.com/next.jpg",
      updatedAt: "2026-08-20T01:00:00.000Z",
    };
    const { calls } = queueFetch(
      { body: { ok: true, data: { setting: NEXT, replayed: false } } },
      { body: { ok: true, data: { setting: { ...NEXT, defaultOgImage: "https://cdn.example.com/again.jpg" }, replayed: false } } },
    );
    renderClient();

    await submitOgChange();
    await waitFor(() => expect(calls).toHaveLength(1));

    await type(within(ogForm()).getByLabelText("图片地址"), "https://cdn.example.com/again.jpg");
    await type(within(ogForm()).getByLabelText("修改原因（必填，写入审计）"), "再次更新");
    await submit(ogForm());
    await waitFor(() => expect(calls).toHaveLength(2));

    const first = headerOf(calls[0], "x-request-id");
    const second = headerOf(calls[1], "x-request-id");
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).not.toBe(first);
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  async function submitOgChange() {
    await type(within(ogForm()).getByLabelText("图片地址"), "https://cdn.example.com/next.jpg");
    await type(within(ogForm()).getByLabelText("修改原因（必填，写入审计）"), "更新封面");
    await submit(ogForm());
  }
});
