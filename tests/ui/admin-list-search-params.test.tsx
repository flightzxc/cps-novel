import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSessionView } from "@/contracts";

/**
 * 后台列表页「全部」空选项 → 不过滤。
 *
 * 线上缺陷：书目管理用筛选表单搜索后整页报"内容数据读取失败"。原因是筛选栏的
 * "全部状态""全部语种"（`<option value="">`）会提交 `status=` / `locale=`，页面把
 * 这些空串原样交给严格的服务层，服务层对"非空且未登记"的值一律抛错，空串也因此
 * 抛 `invalid_status` / `invalid_locale`。
 *
 * 这里按真实路径验证：页面是真实的 Server Component（`await Page(...)` 再
 * `render`），服务层用 `vi.fn(actual.listAdminXxx)` 包一层——**调用的仍是真实的
 * 服务函数**（真实的入参校验），只多出一个能读到"页面到底传了什么"的探针；数据库换成
 * 返回空结果的替身。所以：
 *   - 空串不再触发报错（真实校验放行）；
 *   - 同时能断言页面传给服务层的是 `undefined` 而不是 `""`；
 *   - 非空非法值（`status=foo`）依旧被真实校验拒绝——页面没有把校验放宽。
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh }),
  usePathname: () => "/novels",
}));

const logoutAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction }));

vi.mock("@/features/admin-ui/sidebar", () => ({
  AdminSidebar: () => <nav data-testid="stub-sidebar" />,
}));

// 批量发布工具条会 import server action 模块（带 next/headers），这里只需要它不炸。
vi.mock("@/app/(admin)/novels/_actions", () => ({ publishNovelsBatchAction: vi.fn() }));

/**
 * 空库替身：`listAdminNovels` / `listAdminSourceLabels` 都是「先 COUNT、再取行」的
 * 两条 `$queryRaw`（`Promise.all` 里按声明顺序依次调用），奇数次返回 COUNT=0，偶数次
 * 返回空行集。
 */
const fakeDb = vi.hoisted(() => {
  let calls = 0;
  return {
    reset() {
      calls = 0;
    },
    db: {
      $queryRaw: async () => (calls++ % 2 === 0 ? [{ count: "0" }] : []),
    },
  };
});
vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: fakeDb.db }));

const requireContentPage = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin)/novels/_lib/content-page-guard", () => ({ requireContentPage }));

const SESSION: AdminSessionView = {
  identityId: "id-1",
  username: "root",
  role: "super_admin",
  twoFactorCompleted: true,
  idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  capabilities: [
    { capability: "content:view", state: "granted" },
    { capability: "content:publish", state: "granted" },
  ],
};

vi.mock("@/app/(admin)/_lib/page-guard", () => ({
  sessionView: () => SESSION,
  capabilityViews: () => SESSION.capabilities,
}));

const spies = vi.hoisted(() => ({
  listAdminNovels: vi.fn(),
  listAdminSourceLabels: vi.fn(),
}));
vi.mock("@/server/admin-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/admin-content")>();
  spies.listAdminNovels.mockImplementation(actual.listAdminNovels);
  spies.listAdminSourceLabels.mockImplementation(actual.listAdminSourceLabels);
  return { ...actual, ...spies };
});

const { default: NovelsPage } = await import("@/app/(admin)/novels/page");
const { default: TagsPage } = await import("@/app/(admin)/tags/page");
const { blankParamToUndefined } = await import("@/app/(admin)/_lib/search-params");

const LABEL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  fakeDb.reset();
  spies.listAdminNovels.mockClear();
  spies.listAdminSourceLabels.mockClear();
  requireContentPage.mockReset();
  requireContentPage.mockResolvedValue({ context: {}, granted: true });
});

function novelsInput() {
  expect(spies.listAdminNovels).toHaveBeenCalledTimes(1);
  return spies.listAdminNovels.mock.calls[0]![1] as Record<string, unknown>;
}

function tagsInput() {
  expect(spies.listAdminSourceLabels).toHaveBeenCalledTimes(1);
  return spies.listAdminSourceLabels.mock.calls[0]![1] as Record<string, unknown>;
}

describe("blankParamToUndefined", () => {
  it("空串与纯空白 → undefined", () => {
    expect(blankParamToUndefined("")).toBeUndefined();
    expect(blankParamToUndefined("   ")).toBeUndefined();
    expect(blankParamToUndefined("\t\n")).toBeUndefined();
  });

  it("undefined → undefined", () => {
    expect(blankParamToUndefined(undefined)).toBeUndefined();
  });

  it("非空值原样返回，不 trim、不放宽（带空格的非法值交给服务层拒绝）", () => {
    expect(blankParamToUndefined("abc")).toBe("abc");
    expect(blankParamToUndefined(" published")).toBe(" published");
    expect(blankParamToUndefined("foo")).toBe("foo");
  });

  it("重复参数产生的数组原样放行，不在这里抛无关的 TypeError", () => {
    const repeated = ["a", "b"] as unknown as string;
    expect(blankParamToUndefined(repeated)).toBe(repeated);
  });
});

describe("/novels · 筛选栏「全部」提交空串", () => {
  it("status=\"\"、locale=\"\"、search=\"abc\"：服务层收到 undefined/undefined/\"abc\"，页面不报错", async () => {
    const element = await NovelsPage({
      searchParams: Promise.resolve({ status: "", locale: "", search: "abc" }),
    });

    const input = novelsInput();
    expect(input.status).toBeUndefined();
    expect(input.locale).toBeUndefined();
    expect(input.search).toBe("abc");

    render(element);
    // 页面渲染出来了，且搜索词被回显、两个下拉停在「全部」
    expect((screen.getByLabelText("搜索书名、业务 ID、slug") as HTMLInputElement).value).toBe("abc");
    expect((screen.getByLabelText("生命周期状态") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("语种") as HTMLSelectElement).value).toBe("");
  });

  it("浏览器真实提交的整串（含空的 labelId 与 search）也不报错", async () => {
    await NovelsPage({
      searchParams: Promise.resolve({ search: "", status: "", locale: "", labelId: "" }),
    });

    const input = novelsInput();
    expect(input.search).toBeUndefined();
    expect(input.status).toBeUndefined();
    expect(input.locale).toBeUndefined();
    expect(input.labelId).toBeUndefined();
  });

  it("纯空白的 search 视为未设置", async () => {
    await NovelsPage({ searchParams: Promise.resolve({ search: "   " }) });
    expect(novelsInput().search).toBeUndefined();
  });

  it("合法的非空筛选值原样传给服务层", async () => {
    await NovelsPage({
      searchParams: Promise.resolve({ status: "published", locale: "en", labelId: LABEL_ID }),
    });

    const input = novelsInput();
    expect(input.status).toBe("published");
    expect(input.locale).toBe("en");
    expect(input.labelId).toBe(LABEL_ID);
  });

  it("非空非法状态仍然报错：校验没有被放宽", async () => {
    await expect(
      NovelsPage({ searchParams: Promise.resolve({ status: "foo" }) }),
    ).rejects.toMatchObject({ name: "AdminContentQueryError", code: "invalid_status" });
  });

  it("非空未登记语种仍然报错", async () => {
    await expect(
      NovelsPage({ searchParams: Promise.resolve({ locale: "xx" }) }),
    ).rejects.toMatchObject({ name: "AdminContentQueryError", code: "invalid_locale" });
  });

  it("空 status 与非法 locale 并存时，错误只来自非法的那一个", async () => {
    await expect(
      NovelsPage({ searchParams: Promise.resolve({ status: "", locale: "xx" }) }),
    ).rejects.toMatchObject({ code: "invalid_locale" });
  });
});

describe("/tags · 「全部类型」提交空串（同类缺陷）", () => {
  it("labelKind=\"\"、search=\"abc\"：服务层收到 undefined/\"abc\"，页面不报错，activity 回落 current", async () => {
    const element = await TagsPage({
      searchParams: Promise.resolve({ labelKind: "", search: "abc", activity: "" }),
    });

    const input = tagsInput();
    expect(input.labelKind).toBeUndefined();
    expect(input.search).toBe("abc");
    expect(input.activity).toBeUndefined();

    render(element);
    expect((screen.getByLabelText("标签类型") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("标签状态") as HTMLSelectElement).value).toBe("current");
  });

  it("合法的非空筛选值原样传给服务层", async () => {
    await TagsPage({
      searchParams: Promise.resolve({ labelKind: "series_type", activity: "history" }),
    });

    const input = tagsInput();
    expect(input.labelKind).toBe("series_type");
    expect(input.activity).toBe("history");
  });

  it("非空非法类型仍然报错", async () => {
    await expect(
      TagsPage({ searchParams: Promise.resolve({ labelKind: "foo" }) }),
    ).rejects.toMatchObject({ name: "AdminContentQueryError", code: "invalid_label_kind" });
  });

  it("非空非法 activity 仍然报错", async () => {
    await expect(
      TagsPage({ searchParams: Promise.resolve({ activity: "foo" }) }),
    ).rejects.toMatchObject({ name: "AdminContentQueryError", code: "invalid_activity" });
  });
});
