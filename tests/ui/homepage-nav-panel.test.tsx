import "./setup-cleanup";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanonicalTagsClient } from "@/app/(admin)/tags/canonical/_components/canonical-tags-client";
import { HomepageNavPanel } from "@/app/(admin)/tags/canonical/_components/homepage-nav-panel";
import { projectAdminCanonicalTag, projectAdminHomepageNav } from "@/contracts";
import type { AdminCanonicalTagItem, AdminHomepageNavCandidates } from "@/domain/tagging-admin";

/**
 * v0.5.15 首页题材导航勾选面板（客户端组件）的渲染与接线。
 *
 * `adminFetch` 不打桩——stub 的是 `fetch`，让组件走真实的信封解析路径，也让"header 与 body 里的 requestId
 * 必须字节相同"这条集成陷阱在真实代码路径上被验证（同 `admin-canonical-tags.test.tsx` 的做法）。
 * 数据先造成 kernel 形状，再经真实的 `projectAdminHomepageNav` 投影成 view。
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  routerRefresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(payload: unknown) {
  return { json: async () => ({ ok: true, data: payload }) } as unknown as Response;
}

function envelopeResponse(envelope: unknown) {
  return { json: async () => envelope } as unknown as Response;
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function candidates(overrides: Partial<AdminHomepageNavCandidates> = {}): AdminHomepageNavCandidates {
  return {
    items: [
      { id: A, slug: "alpha", facet: "genre", sortOrder: 10, zhName: "阿尔法", enName: "Alpha", isHomepageVisible: true, enBookCount: 40, localeCount: 3 },
      { id: B, slug: "beta", facet: "theme", sortOrder: 20, zhName: null, enName: "Beta", isHomepageVisible: true, enBookCount: 0, localeCount: 1 },
      { id: C, slug: "gamma", facet: null, sortOrder: 30, zhName: null, enName: null, isHomepageVisible: false, enBookCount: 7, localeCount: 2 },
      { id: D, slug: "delta", facet: null, sortOrder: 40, zhName: "德尔塔", enName: null, isHomepageVisible: false, enBookCount: 0, localeCount: 0 },
    ],
    visibleCount: 2,
    audit: [],
    ...overrides,
  };
}

function renderPanel(
  state: "granted" | "denied" | "two_factor_required" = "granted",
  data: AdminHomepageNavCandidates = candidates(),
) {
  return render(<HomepageNavPanel data={projectAdminHomepageNav(data)} tagManage={state} />);
}

const checkbox = (id: string) => screen.getByTestId(`homepage-nav-${id}`) as HTMLInputElement;
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;

describe("v0.5.15 首页题材导航面板 · 渲染", () => {
  it("一句说明；每项一个真实 checkbox + label，标签文字 = 中文名（无则 en 名，再无则 slug）· slug · 英语 N 本 · M 个语种有书", () => {
    renderPanel();
    expect(screen.getByTestId("homepage-nav-help").textContent).toBe(
      "勾选的分类会出现在前台首页的题材导航里（各语种只显示其中有书的）；不影响分类页、页脚和站点地图。保存后刷新首页立即生效。",
    );
    const labelOf = (id: string) => (document.querySelector(`label[for="homepage-nav-${id}"]`) as HTMLLabelElement).textContent;
    expect(labelOf(A)).toBe("阿尔法 · alpha · 英语 40 本 · 3 个语种有书");
    expect(labelOf(B)).toBe("Beta · beta · 英语 0 本 · 1 个语种有书");
    expect(labelOf(C)).toBe("gamma · gamma · 英语 7 本 · 2 个语种有书");
    expect(labelOf(D)).toBe("德尔塔 · delta · 英语 0 本 · 0 个语种有书");
    for (const id of [A, B, C, D]) {
      expect(checkbox(id).type).toBe("checkbox");
      expect(checkbox(id).id).toBe(`homepage-nav-${id}`);
    }
    // 按服务端给的顺序（分类排序号）排列。
    const order = [...document.querySelectorAll("input[type=checkbox]")].map((node) => (node as HTMLInputElement).id);
    expect(order).toEqual([A, B, C, D].map((id) => `homepage-nav-${id}`));
  });

  it("初始勾选 = 库里 is_homepage_visible=true 的分类；计数「已勾选 X / 共 Y」；没有改动时保存 disabled", () => {
    renderPanel();
    expect([A, B, C, D].map((id) => checkbox(id).checked)).toEqual([true, true, false, false]);
    expect(screen.getByTestId("homepage-nav-count").textContent).toBe("已勾选 2 / 共 4");
    expect(button("homepage-nav-save").disabled).toBe(true);
  });

  it("勾选 / 取消勾选会更新计数，并让保存可用；改回原状保存又变回 disabled", () => {
    renderPanel();
    fireEvent.click(checkbox(C));
    expect(checkbox(C).checked).toBe(true);
    expect(screen.getByTestId("homepage-nav-count").textContent).toBe("已勾选 3 / 共 4");
    expect(button("homepage-nav-save").disabled).toBe(false);
    fireEvent.click(checkbox(C));
    expect(screen.getByTestId("homepage-nav-count").textContent).toBe("已勾选 2 / 共 4");
    expect(button("homepage-nav-save").disabled).toBe(true);
  });

  it("全选 / 全不选", () => {
    renderPanel();
    fireEvent.click(button("homepage-nav-select-all"));
    expect([A, B, C, D].every((id) => checkbox(id).checked)).toBe(true);
    expect(screen.getByTestId("homepage-nav-count").textContent).toBe("已勾选 4 / 共 4");
    fireEvent.click(button("homepage-nav-select-none"));
    expect([A, B, C, D].some((id) => checkbox(id).checked)).toBe(false);
    expect(screen.getByTestId("homepage-nav-count").textContent).toBe("已勾选 0 / 共 4");
    expect(button("homepage-nav-save").disabled).toBe(false); // 与初始(2 个)不同 = 有改动
  });

  it("没有启用中的分类：显示空状态", () => {
    renderPanel("granted", candidates({ items: [], visibleCount: 0 }));
    expect(screen.getByTestId("homepage-nav-empty")).toBeTruthy();
    expect(screen.getByTestId("homepage-nav-count").textContent).toBe("已勾选 0 / 共 0");
  });

  it("折叠区展示最近保存记录：动作文案「首页导航」，保存前后的名单和本次新增 / 去掉都读得出来", () => {
    renderPanel("granted", candidates({
      audit: [{
        action: "tag.canonical.homepage_nav.replace",
        actorId: "admin-1",
        requestId: "r-1",
        reason: null,
        before: { homepageNav: ["alpha"] },
        after: { homepageNav: ["alpha", "beta"], added: ["beta"], removed: [] },
        createdAt: "2026-10-10T08:00:00.000Z",
      }],
    }));
    const log = screen.getByTestId("homepage-nav-audit");
    expect(within(log).getByTestId("homepage-nav-audit-item-0-action").textContent).toBe("首页导航");
    const diff = within(log).getByTestId("homepage-nav-audit-item-0-diff").textContent ?? "";
    expect(diff).toContain("首页导航名单：1 项：alpha → 2 项：alpha、beta");
    expect(diff).toContain("本次新增：1 项：beta");
    expect(diff).toContain("本次去掉：(空)");
  });
});

describe("v0.5.15 首页题材导航面板 · 权限", () => {
  it("无 tag:manage：勾选框、全选 / 全不选、保存全部 disabled，并显示原因", () => {
    renderPanel("denied");
    for (const id of [A, B, C, D]) expect(checkbox(id).disabled).toBe(true);
    expect(button("homepage-nav-select-all").disabled).toBe(true);
    expect(button("homepage-nav-select-none").disabled).toBe(true);
    expect(button("homepage-nav-save").disabled).toBe(true);
    expect(screen.getByTestId("homepage-nav-blocked").textContent).toContain("tag:manage");
  });

  it("会话没完成两步验证：同样 disabled，原因写明要先完成两步验证", () => {
    renderPanel("two_factor_required");
    expect(checkbox(A).disabled).toBe(true);
    expect(screen.getByTestId("homepage-nav-blocked").textContent).toContain("双重验证");
  });

  it("有 tag:manage：可编辑，不显示原因（组件不接收也不依赖分类写开关）", () => {
    renderPanel("granted");
    for (const id of [A, B, C, D]) expect(checkbox(id).disabled).toBe(false);
    expect(screen.queryByTestId("homepage-nav-blocked")).toBeNull();
  });
});

describe("v0.5.15 首页题材导航面板 · 保存", () => {
  it("提交体形状：两个数组 + requestId；header 与 body 的 requestId 字节相同；expected 取页面加载时的名单", async () => {
    fetchMock.mockResolvedValue(okResponse({ visibleCount: 2, changedCount: 2, replayed: false }));
    renderPanel();
    fireEvent.click(checkbox(A)); // 去掉 alpha
    fireEvent.click(checkbox(C)); // 加上 gamma
    fireEvent.click(button("homepage-nav-save"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/admin/canonical-tags/homepage-nav");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["expectedVisibleCanonicalTagIds", "requestId", "visibleCanonicalTagIds"]);
    expect(body.visibleCanonicalTagIds).toEqual([B, C]);
    expect(body.expectedVisibleCanonicalTagIds).toEqual([A, B]);
    expect(typeof body.requestId).toBe("string");
    expect(headers["x-request-id"]).toBe(body.requestId);
  });

  it("全不选后保存：visibleCanonicalTagIds 为空数组", async () => {
    fetchMock.mockResolvedValue(okResponse({ visibleCount: 0, changedCount: 2, replayed: false }));
    renderPanel();
    fireEvent.click(button("homepage-nav-select-none"));
    fireEvent.click(button("homepage-nav-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body.visibleCanonicalTagIds).toEqual([]);
    expect(body.expectedVisibleCanonicalTagIds).toEqual([A, B]);
  });

  it("成功：显示「保存成功」、刷新页面；保存按钮回到 disabled，再保存时 expected 已是刚保存的名单；每次保存新生成 requestId", async () => {
    fetchMock.mockResolvedValue(okResponse({ visibleCount: 3, changedCount: 1, replayed: false }));
    renderPanel();
    fireEvent.click(checkbox(C));
    fireEvent.click(button("homepage-nav-save"));
    await waitFor(() => expect(screen.getByTestId("homepage-nav-notice").textContent).toContain("保存成功"));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(button("homepage-nav-save").disabled).toBe(true);

    fireEvent.click(checkbox(D));
    fireEvent.click(button("homepage-nav-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const first = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(second.expectedVisibleCanonicalTagIds).toEqual(first.visibleCanonicalTagIds);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("名单被别人改过（409）：用中文错误文案显示，不刷新页面，不自动重试，只提供手动「刷新」", async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ok: false, status: 409, code: "homepage_nav_conflict" }));
    renderPanel();
    fireEvent.click(checkbox(C));
    fireEvent.click(button("homepage-nav-save"));
    await waitFor(() => expect(screen.getByTestId("homepage-nav-notice").textContent)
      .toContain("保存失败：首页导航名单已被别人改过，请刷新后再保存"));
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByTestId("homepage-nav-notice")).getByRole("button", { name: "刷新" }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    // 失败后勾选保留，运营可以直接再试。
    expect(checkbox(C).checked).toBe(true);
  });

  it("名单里有不存在或已停用的分类（400）：显示对应中文文案", async () => {
    fetchMock.mockResolvedValue(envelopeResponse({ ok: false, status: 400, code: "invalid_homepage_nav" }));
    renderPanel();
    fireEvent.click(checkbox(C));
    fireEvent.click(button("homepage-nav-save"));
    await waitFor(() => expect(screen.getByTestId("homepage-nav-notice").textContent)
      .toContain("名单里有不存在或已停用的分类"));
  });

  it("服务端数据刷新后（router.refresh 带来新 props）以服务端为准重置勾选与基线", () => {
    const view = projectAdminHomepageNav(candidates());
    const { rerender } = render(<HomepageNavPanel data={view} tagManage="granted" />);
    fireEvent.click(checkbox(C));
    expect(checkbox(C).checked).toBe(true);
    const refreshed = projectAdminHomepageNav(candidates({
      items: candidates().items.map((item) => (item.id === D ? { ...item, isHomepageVisible: true } : item)),
    }));
    rerender(<HomepageNavPanel data={refreshed} tagManage="granted" />);
    expect([A, B, C, D].map((id) => checkbox(id).checked)).toEqual([true, true, false, true]);
    expect(button("homepage-nav-save").disabled).toBe(true);
  });
});

describe("v0.5.15 分类列表 · 只读「首页」列", () => {
  function tagItem(id: string, slug: string, isHomepageVisible: boolean): AdminCanonicalTagItem {
    return {
      id, stableId: `ct-${slug}`, slug, active: true, canonicalDefinition: "d", facet: null, sortOrder: 1,
      isHomepageVisible, taxonomyVersion: "v1", translations: [], aliases: [],
      keywordSummary: { total: 0, active: 0, lexiconVersions: [] },
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastMutation: null,
    };
  }

  it("表头有「首页」；勾选的分类显示「显示」，未勾选显示「—」", () => {
    render(
      <CanonicalTagsClient
        items={[tagItem(A, "alpha", true), tagItem(B, "beta", false)].map(projectAdminCanonicalTag)}
        tagManage="granted"
      />,
    );
    expect(screen.getAllByRole("columnheader").map((node) => node.textContent)).toContain("首页");
    expect(screen.getByTestId(`canonical-tag-homepage-${A}`).textContent).toBe("显示");
    expect(screen.getByTestId(`canonical-tag-homepage-${B}`).textContent).toBe("—");
  });

  it("契约投影带出 isHomepageVisible", () => {
    expect(projectAdminCanonicalTag(tagItem(A, "alpha", false)).isHomepageVisible).toBe(false);
    expect(projectAdminCanonicalTag(tagItem(A, "alpha", true)).isHomepageVisible).toBe(true);
  });
});
