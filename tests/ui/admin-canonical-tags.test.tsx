import "./setup-cleanup";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  projectAdminCanonicalTagDetail,
  projectAdminCanonicalTagList,
  projectAdminTagMutationResult,
} from "@/contracts";
import type {
  AdminCanonicalTagDetail,
  AdminCanonicalTagItem,
  AdminCanonicalTagList,
  AdminTagAuditEntry,
  AdminTagAuthority,
} from "@/domain/tagging-admin";
import { CanonicalTagFilters } from "@/app/(admin)/tags/canonical/_components/canonical-tag-filters";
import { CanonicalTagsClient } from "@/app/(admin)/tags/canonical/_components/canonical-tags-client";
import { ClassifierDiagnosticsPanel } from "@/app/(admin)/tags/canonical/_components/classifier-diagnostics-panel";
import { TAG_TRANSLATION_LOCALES } from "@/lib/locale/locale-canonical";

/**
 * P2-06.5 Canonical Tag 管理页的渲染与接线验收（Admin V1 package 1）。
 *
 * `adminFetch` 不打桩——stub 的是 `fetch`，让组件走真实的 envelope 解析路径，
 * 也让「header 与 body 的 requestId 必须字节相同」这条集成陷阱在真实代码路径
 * 上被验证，而不是被替身悄悄绕过。
 *
 * 所有 fixture 都是 **kernel 形状**（`AdminCanonicalTagItem` / `AdminTagAuthority`
 * / `AdminCanonicalTagDetail`），再用真实的 `projectAdminCanonicalTagList` /
 * `projectAdminCanonicalTagDetail` 投影成 view——这样投影一旦开始外泄字段（比如
 * `keywords` 在 list 模式下本不该出现），这里会直接失败，而不是被手写 view
 * fixture 绕过去。
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

const TAG_ID_A = "11111111-1111-4111-8111-111111111111";
const TAG_ID_B = "22222222-2222-4222-8222-222222222222";
const UPDATED_AT_A = "2026-08-10T00:00:00.000Z";
const UPDATED_AT_B = "2026-08-11T00:00:00.000Z";

function canonicalTagItem(overrides: Partial<AdminCanonicalTagItem> = {}): AdminCanonicalTagItem {
  return {
    id: TAG_ID_A,
    stableId: "genre.wuxia",
    slug: "wuxia",
    active: true,
    canonicalDefinition:
      "武侠题材：以武功、江湖恩怨、侠义精神为核心叙事，常见门派、修炼与快意恩仇的桥段。",
    facet: "genre",
    sortOrder: 10,
    taxonomyVersion: "v1",
    translations: [
      { locale: "zh", displayName: "武侠" },
      { locale: "en", displayName: "Wuxia" },
    ],
    aliases: ["武侠", "wuxia"],
    keywordSummary: { total: 2, active: 1, lexiconVersions: ["c1-v2"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: UPDATED_AT_A,
    lastMutation: null,
    ...overrides,
  };
}

/** 没有 zh 译名的一行——本文件反补偿断言的主角。 */
const TAG_NO_ZH = canonicalTagItem({
  id: TAG_ID_B,
  stableId: "genre.scifi",
  slug: "scifi",
  translations: [{ locale: "en", displayName: "Science Fiction" }],
  aliases: [],
  keywordSummary: { total: 0, active: 0, lexiconVersions: [] },
  updatedAt: UPDATED_AT_B,
});

function authorityFixture(overrides: Partial<AdminTagAuthority> = {}): AdminTagAuthority {
  return {
    taxonomy: {
      status: "READY",
      canonicalV1Count: 123,
      canonicalV1Sha256: "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad",
      databaseActiveCount: 123,
      versions: ["v1"],
    },
    keywords: {
      status: "READY",
      activeKeywordCount: 40,
      versions: ["c1-v2"],
      fingerprint: "b".repeat(64),
      keywordEligibilityVersion: "keyword-eligibility-v2",
      keywordEligibilitySha256: "e796ba1ed79b344f790a70853d2e9773d6265e307615b2a60da28b90a6164854",
    },
    classifier: {
      status: "FROZEN",
      version: "2026-08-17-owner-final-c1-final",
      titleWeight: 30,
      descriptionWeight: 30,
      threshold: 30,
      maxTextTags: 3,
      fingerprint: "a".repeat(64),
    },
    ...overrides,
  };
}

function canonicalTagList(items: AdminCanonicalTagItem[]): AdminCanonicalTagList {
  return {
    items,
    page: 1,
    pageSize: 20,
    total: items.length,
    totalPages: 1,
    authority: authorityFixture(),
  };
}

function canonicalTagDetail(item: AdminCanonicalTagItem): AdminCanonicalTagDetail {
  return {
    tag: {
      ...item,
      keywords: [
        {
          keywordId: "kw-1",
          value: "武侠",
          scriptBuckets: ["cjk"],
          matchMode: "cjk_contiguous",
          riskFlags: [],
          active: true,
          lexiconVersion: "c1-v2",
        },
        {
          keywordId: "kw-2",
          value: "wuxia",
          scriptBuckets: ["latin"],
          matchMode: "word_boundary",
          riskFlags: ["ambiguous"],
          active: false,
          lexiconVersion: "c1-v2",
        },
      ],
      audit: [],
    },
    authority: authorityFixture(),
  };
}

describe("P2-06.5 Canonical Tag 筛选栏", () => {
  it("是纯 GET 表单，字段名即查询参数，且没有 page 字段", () => {
    const { container } = render(<CanonicalTagFilters values={{}} />);
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    expect(form?.getAttribute("method")?.toUpperCase()).toBe("GET");
    expect(form?.querySelector('[name="search"]')).toBeTruthy();
    expect(form?.querySelector('[name="active"]')).toBeTruthy();
    expect(form?.querySelector('[name="page"]')).toBeNull();
  });

  it("状态下拉默认「全部」，三态齐全", () => {
    render(<CanonicalTagFilters values={{}} />);
    const select = screen.getByLabelText("Canonical Tag 状态") as HTMLSelectElement;
    expect(select.value).toBe("all");
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "all",
      "active",
      "inactive",
    ]);
  });

  it("回显当前筛选值", () => {
    render(<CanonicalTagFilters values={{ search: "武侠", active: "inactive" }} />);
    expect((screen.getByLabelText("搜索 Canonical Tag") as HTMLInputElement).value).toBe("武侠");
    expect((screen.getByLabelText("Canonical Tag 状态") as HTMLSelectElement).value).toBe("inactive");
  });
});

describe("P2-06.5 Canonical Tag 列表渲染", () => {
  it("渲染 slug、状态徽章与更新时间", () => {
    const view = projectAdminCanonicalTagList(canonicalTagList([canonicalTagItem()]));
    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    expect(screen.getByText("wuxia")).toBeTruthy();
    expect(screen.getByText("genre.wuxia")).toBeTruthy();
    expect(screen.getByText("启用")).toBeTruthy();
  });

  it("停用的 Canonical Tag 显示「停用」徽章，不是「启用」", () => {
    const view = projectAdminCanonicalTagList(
      canonicalTagList([canonicalTagItem({ active: false })]),
    );
    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    expect(screen.getByText("停用")).toBeTruthy();
    expect(screen.queryByText("启用")).toBeNull();
  });

  it("displayName 有 zh 译名的行，展示名单元格显示的是 zh 译名", () => {
    const view = projectAdminCanonicalTagList(canonicalTagList([canonicalTagItem()]));
    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    const cell = screen.getByTestId(`canonical-tag-zh-${TAG_ID_A}`);
    expect(cell.textContent).toBe("武侠");
  });
});

describe("P2-06.5 Canonical Tag 反补偿断言", () => {
  /**
   * 🔴 核心红线：没有 zh 译名的行，展示名单元格必须显示 "—"，绝不能拿 slug
   * 顶替。这正是本项目在 `tags-table.tsx` 已经钉过的补偿式 UI 红线，同一条
   * 原则延伸到 Canonical Tag 的展示名列。
   */
  it("没有 zh 译名的行，展示名单元格是「—」，且不包含 slug", () => {
    const view = projectAdminCanonicalTagList(canonicalTagList([TAG_NO_ZH]));
    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    const cell = screen.getByTestId(`canonical-tag-zh-${TAG_ID_B}`);
    expect(cell.textContent).toBe("—");
    expect(cell.textContent).not.toContain("scifi");
  });
});

describe("P2-06.5 Canonical Tag 编辑 · 请求体与 header requestId", () => {
  it("set_status：header 与 body 的 requestId 完全一致，字段集精确", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock
      .mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))))
      .mockResolvedValueOnce(
        okResponse(
          projectAdminTagMutationResult({ id: item.id, updatedAt: "2026-08-12T00:00:00.000Z", replayed: false }),
        ),
      );

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const statusForm = within(screen.getByTestId(`canonical-tag-status-form-${item.id}`));
    fireEvent.change(statusForm.getByLabelText(`Canonical Tag 状态 · ${item.slug}`), {
      target: { value: "inactive" },
    });
    fireEvent.click(statusForm.getByRole("button", { name: "更新状态" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/admin/canonical-tags");
    expect((init as RequestInit).method).toBe("PUT");
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(headers["x-request-id"]).toBe(body.requestId);
    expect(body).toEqual({
      action: "set_status",
      requestId: body.requestId,
      canonicalTagId: item.id,
      expectedUpdatedAt: item.updatedAt,
      status: "inactive",
    });

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("replace_translations：全量替换，header 与 body 的 requestId 一致", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock
      .mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))))
      .mockResolvedValueOnce(
        okResponse(projectAdminTagMutationResult({ id: item.id, updatedAt: UPDATED_AT_A, replayed: false })),
      );

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // P2-06.5 F3: the free-text "添加译名" row + "locale" input the request
    // body used to be filled through was replaced by the fixed-locale
    // `LocaleFieldEditor` (see the describe block below for that change's own
    // coverage). This test's job is the request-body/header contract, not
    // the interaction mechanics, so it's re-pointed at the new UI: "ja" is
    // not in the default-expanded set, so expand first, then fill its input
    // by its `译名 · ja` aria-label.
    const translationsForm = within(screen.getByTestId(`canonical-tag-translations-form-${item.id}`));
    fireEvent.click(translationsForm.getByRole("button", { name: /展开全部/ }));
    fireEvent.change(translationsForm.getByLabelText("译名 · ja"), { target: { value: "武侠もの" } });
    fireEvent.click(translationsForm.getByRole("button", { name: "保存译名" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(headers["x-request-id"]).toBe(body.requestId);
    expect(body).toEqual({
      action: "replace_translations",
      requestId: body.requestId,
      canonicalTagId: item.id,
      expectedUpdatedAt: item.updatedAt,
      // Rebuilt in `TAG_TRANSLATION_LOCALES` enumeration order (en, zh, ja),
      // not insertion order — see `LocaleFieldEditor`'s doc comment.
      translations: [
        { locale: "en", displayName: "Wuxia" },
        { locale: "zh", displayName: "武侠" },
        { locale: "ja", displayName: "武侠もの" },
      ],
    });
  });

  it("replace_aliases：全量替换，header 与 body 的 requestId 一致", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock
      .mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))))
      .mockResolvedValueOnce(
        okResponse(projectAdminTagMutationResult({ id: item.id, updatedAt: UPDATED_AT_A, replayed: false })),
      );

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const aliasesForm = within(screen.getByTestId(`canonical-tag-aliases-form-${item.id}`));
    // 两条别名各有一个「移除」按钮；移除第一个（"武侠"），留下 "wuxia"。
    fireEvent.click(aliasesForm.getAllByRole("button", { name: "移除" })[0]);
    fireEvent.click(aliasesForm.getByRole("button", { name: "保存别名" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1];
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(headers["x-request-id"]).toBe(body.requestId);
    expect(body).toEqual({
      action: "replace_aliases",
      requestId: body.requestId,
      canonicalTagId: item.id,
      expectedUpdatedAt: item.updatedAt,
      aliases: ["wuxia"],
    });
  });
});

describe("P2-06.5 Canonical Tag 编辑 · Keyword 只读块", () => {
  it("展开编辑后拉取 keyword 详情，且该区域没有任何写入控件", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(
      okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))),
    );

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));

    const keywordBlock = await screen.findByTestId(`canonical-tag-keywords-${item.id}`);
    await waitFor(() => expect(within(keywordBlock).getByText("武侠")).toBeTruthy());
    expect(within(keywordBlock).getByText("wuxia")).toBeTruthy();

    expect(keywordBlock.querySelectorAll("input").length).toBe(0);
    expect(keywordBlock.querySelectorAll("select").length).toBe(0);
    expect(keywordBlock.querySelectorAll('button[type="submit"]').length).toBe(0);
    expect(keywordBlock.querySelectorAll("button").length).toBe(0);

    const requested = new URL(String(fetchMock.mock.calls[0][0]), "https://admin.invalid");
    expect(requested.pathname).toBe("/api/admin/canonical-tags");
    expect(requested.searchParams.get("id")).toBe(item.id);
    // 读不是 mutation：不带 x-request-id
    const readInit = fetchMock.mock.calls[0][1] as (RequestInit & { headers?: Record<string, string> }) | undefined;
    expect(readInit?.headers?.["x-request-id"]).toBeUndefined();
  });
});

describe("P2-06.5 Canonical Tag 编辑 · 冲突不自动重试", () => {
  it("revision_conflict 显示真实中文文案，不自动重试，提供刷新入口", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock
      .mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))))
      .mockResolvedValueOnce(
        envelopeResponse({ ok: false, status: 409, code: "revision_conflict" }),
      );

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const statusForm = within(screen.getByTestId(`canonical-tag-status-form-${item.id}`));
    fireEvent.click(statusForm.getByRole("button", { name: "更新状态" }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("数据已被其他操作更新，请刷新后重试");

    // 冲突之后不会自动重放同一个请求：调用次数保持在 2（探测 GET + 一次失败的 PUT）
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(routerRefresh).not.toHaveBeenCalled();

    // 显式提供刷新入口，而不是静默覆盖
    expect(within(notice).getByRole("button", { name: "刷新" })).toBeTruthy();
  });
});

describe("P2-06.5 Canonical Tag 能力位闸门", () => {
  it("没有 tag:manage 时点名能力位，且写控件全部禁用", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))));
    render(<CanonicalTagsClient items={view.items} tagManage="denied" />);

    const blocked = screen.getByText(/缺少能力位/);
    expect(blocked.textContent).toContain("标签管理");
    expect(blocked.textContent).toContain("tag:manage");

    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${TAG_ID_A}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const statusForm = within(screen.getByTestId(`canonical-tag-status-form-${TAG_ID_A}`));
    expect((statusForm.getByRole("button", { name: "更新状态" }) as HTMLButtonElement).disabled).toBe(true);
    expect((statusForm.getByLabelText("Canonical Tag 状态 · wuxia") as HTMLSelectElement).disabled).toBe(true);
  });

  it("admin_two_factor_required 与 admin_capability_denied 的文案不同", () => {
    const view = projectAdminCanonicalTagList(canonicalTagList([canonicalTagItem()]));

    const { unmount } = render(<CanonicalTagsClient items={view.items} tagManage="two_factor_required" />);
    const twoFactorNotice = screen.getByText(/双重验证/);
    expect(twoFactorNotice.textContent).not.toContain("缺少能力位");
    unmount();

    render(<CanonicalTagsClient items={view.items} tagManage="denied" />);
    const deniedNotice = screen.getByText(/缺少能力位/);
    expect(deniedNotice.textContent).not.toContain("双重验证");
  });
});

describe("P2-06.5 Classifier Diagnostics 面板", () => {
  it("展示 30/30/30/3、eligibility 版本与 SHA，且没有任何配置类写入控件", () => {
    const authority = authorityFixture();
    const { container } = render(<ClassifierDiagnosticsPanel authority={authority} />);

    // titleWeight/descriptionWeight/threshold 都是 30，maxTextTags 是 3——用
    // getAllByText 而不是逐一 getByText，避免因命中三次而报错。
    expect(screen.getAllByText("30", { selector: "dd" }).length).toBe(3);
    expect(screen.getByText("3", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("keyword-eligibility-v2")).toBeTruthy();
    expect(
      screen.getByText("e796ba1ed79b344f790a70853d2e9773d6265e307615b2a60da28b90a6164854"),
    ).toBeTruthy();

    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll("select").length).toBe(0);
    expect(container.querySelectorAll('button[type="submit"]').length).toBe(0);
  });

  it("V1 登记数与数据库启用数不符时给出「与登记数量不符」提示", () => {
    const authority = authorityFixture({
      taxonomy: {
        status: "INCOMPLETE",
        canonicalV1Count: 123,
        canonicalV1Sha256: "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad",
        databaseActiveCount: 100,
        versions: ["v1"],
      },
    });
    render(<ClassifierDiagnosticsPanel authority={authority} />);
    expect(screen.getByTestId("taxonomy-count-mismatch").textContent).toBe("与登记数量不符");
  });

  it("数量一致时不显示不符提示", () => {
    render(<ClassifierDiagnosticsPanel authority={authorityFixture()} />);
    expect(screen.queryByTestId("taxonomy-count-mismatch")).toBeNull();
  });
});

/**
 * P2-06.5 F3：译名区从自由文本 locale 输入换成固定语种列表 + 渐进展开
 * （`LocaleFieldEditor`，移植自 CPS `tags/_components/locale-field-editor.tsx`）。
 *
 * 核心红线：不再有任何可以输入任意字符串当 locale 码的控件——旧的
 * `<input placeholder="locale">` 让运营手误一个字母就能静默产生一个没有校验
 * 拦截的孤儿语种译名，这正是本次改动要从结构上消灭的东西。
 */
describe("P2-06.5 Canonical Tag 译名 · 固定语种编辑器（F3）", () => {
  it("译名区不存在任何自由文本 locale 输入", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const translationsForm = within(screen.getByTestId(`canonical-tag-translations-form-${item.id}`));

    // 没有 placeholder="locale" 的自由文本输入了
    expect(translationsForm.queryByPlaceholderText("locale")).toBeNull();
    // 没有旧交互留下的痕迹："译名 locale N" 标签、"添加译名" 按钮
    expect(translationsForm.queryByLabelText(/^译名 locale/)).toBeNull();
    expect(translationsForm.queryByRole("button", { name: "添加译名" })).toBeNull();

    // 译名区里每一个文本输入的 aria-label 都精确对应
    // `TAG_TRANSLATION_LOCALES` 里的一个固定语种码，不存在别的形态
    const textInputs = translationsForm.getAllByRole("textbox");
    expect(textInputs.length).toBeGreaterThan(0);
    for (const input of textInputs) {
      const label = input.getAttribute("aria-label") ?? "";
      expect(label.startsWith("译名 · ")).toBe(true);
      const locale = label.slice("译名 · ".length);
      expect(TAG_TRANSLATION_LOCALES).toContain(locale);
    }
  });

  it("默认只显示 zh/en 加上已有值的语种；只有 zh 有值时不默认显示 ja", async () => {
    const item = canonicalTagItem({ translations: [{ locale: "zh", displayName: "武侠" }] });
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const translationsForm = within(screen.getByTestId(`canonical-tag-translations-form-${item.id}`));

    // zh 有值,en 是默认展开集里的第二项(即便这里没有值)
    expect((translationsForm.getByLabelText("译名 · zh") as HTMLInputElement).value).toBe("武侠");
    expect((translationsForm.getByLabelText("译名 · en") as HTMLInputElement).value).toBe("");

    // ja 既不在默认展开集,也没有值,默认不出现
    expect(translationsForm.queryByLabelText("译名 · ja")).toBeNull();
    expect(translationsForm.queryByLabelText("译名 · fr")).toBeNull();
  });

  it("点击展开后,20 个语位全部可见，且展开态可以再次收起", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const translationsForm = within(screen.getByTestId(`canonical-tag-translations-form-${item.id}`));

    expect(TAG_TRANSLATION_LOCALES.length).toBe(20);
    fireEvent.click(translationsForm.getByRole("button", { name: /展开全部 \d+ 种语言/ }));

    for (const locale of TAG_TRANSLATION_LOCALES) {
      expect(translationsForm.getByLabelText(`译名 · ${locale}`)).toBeTruthy();
    }

    // 展开后按钮变成"收起"而不是消失——能再收起,不是单向展开
    const collapseButton = translationsForm.getByRole("button", { name: "收起" });
    expect(collapseButton).toBeTruthy();
    fireEvent.click(collapseButton);
    expect(translationsForm.queryByLabelText("译名 · fr")).toBeNull();
    expect(translationsForm.getByLabelText("译名 · zh")).toBeTruthy();
  });

  it("某语种填了值再清空后,提交数组里不含该 locale（不是空字符串占位）", async () => {
    const item = canonicalTagItem(); // zh: 武侠, en: Wuxia
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock
      .mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))))
      .mockResolvedValueOnce(
        okResponse(projectAdminTagMutationResult({ id: item.id, updatedAt: UPDATED_AT_A, replayed: false })),
      );

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const translationsForm = within(screen.getByTestId(`canonical-tag-translations-form-${item.id}`));
    fireEvent.change(translationsForm.getByLabelText("译名 · zh"), { target: { value: "" } });
    fireEvent.click(translationsForm.getByRole("button", { name: "保存译名" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.translations).toEqual([{ locale: "en", displayName: "Wuxia" }]);
    expect(
      (body.translations as Array<{ locale: string }>).some((row) => row.locale === "zh"),
    ).toBe(false);
  });

  it("zh 语位始终存在且可编辑——resolver 的全局回退语种，不能被默认折叠挡住", async () => {
    // 刻意不给 zh 译名,验证它仍然默认展开、可编辑,而不是要等它先有值才出现
    const item = canonicalTagItem({ translations: [{ locale: "en", displayName: "Science Fiction" }] });
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const translationsForm = within(screen.getByTestId(`canonical-tag-translations-form-${item.id}`));
    const zhInput = translationsForm.getByLabelText("译名 · zh") as HTMLInputElement;
    expect(zhInput.disabled).toBe(false);
    expect(zhInput.value).toBe("");

    fireEvent.change(zhInput, { target: { value: "科幻" } });
    expect((translationsForm.getByLabelText("译名 · zh") as HTMLInputElement).value).toBe("科幻");
  });
});

/**
 * P2-06.5 CPS-parity F1: the frozen `audit` projection on the detail
 * response was reaching the browser but nothing rendered it. These tests
 * cover `TagAuditLog`/`TagAuditEntryRow` as wired into `CanonicalTagEditor`
 * — reusing the *same* `GET /api/admin/canonical-tags?id=...` request the
 * keyword block already issues, never a second one.
 */
describe("P2-06.5 Canonical Tag 编辑 · 变更历史（CPS-parity F1）", () => {
  const AUDIT_ACTOR_ID = "abcdef12-3456-4789-8abc-def012345678";

  function auditDetail(item: AdminCanonicalTagItem, audit: AdminTagAuditEntry[]): AdminCanonicalTagDetail {
    const base = canonicalTagDetail(item);
    return { ...base, tag: { ...base.tag, audit } };
  }

  it("展开行渲染 audit 多条记录，未知 action 原样显示，且没有为此多发一次 detail 请求", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    const audit: AdminTagAuditEntry[] = [
      {
        action: "tag.canonical.status",
        actorId: AUDIT_ACTOR_ID,
        requestId: "req-1",
        reason: null,
        before: { status: "inactive" },
        after: { status: "active" },
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      {
        // 尚未在 AUDIT_ACTION_LABELS 里登记的动作字符串——必须原样显示，不能
        // 抛错、也不能渲染成空白（见 content-view.ts `taskStatusLabel` 的同一条纪律）。
        action: "tag.canonical.future_action_not_yet_labelled",
        actorId: null,
        requestId: "req-2",
        reason: "补充说明",
        before: null,
        after: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    ];
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(auditDetail(item, audit))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));

    const auditLog = await screen.findByTestId(`canonical-tag-audit-log-${item.id}`);
    expect(within(auditLog).getByText("更改状态")).toBeTruthy();
    expect(within(auditLog).getByText("tag.canonical.future_action_not_yet_labelled")).toBeTruthy();

    // 两条记录各自都渲染出来了
    expect(within(auditLog).getByTestId(`canonical-tag-audit-log-${item.id}-item-0`)).toBeTruthy();
    expect(within(auditLog).getByTestId(`canonical-tag-audit-log-${item.id}-item-1`)).toBeTruthy();

    // 核心断言：audit 复用了展开时已经发出的那一次 detail 请求，没有多发一次。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reason 为 null 时渲染「—」——不是空白，也不是错误态；有值时原样显示", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    const audit: AdminTagAuditEntry[] = [
      {
        action: "tag.canonical.status",
        actorId: AUDIT_ACTOR_ID,
        requestId: "req-1",
        reason: null,
        before: null,
        after: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ];
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(auditDetail(item, audit))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));

    const auditLog = await screen.findByTestId(`canonical-tag-audit-log-${item.id}`);
    const reasonCell = within(auditLog).getByTestId(`canonical-tag-audit-log-${item.id}-item-0-reason`);
    expect(reasonCell.textContent).toContain("—");
    // 不是错误态：既不是红色文字，也不是"加载中/失败"一类的措辞。
    expect(reasonCell.className).not.toMatch(/text-red/);
    expect(reasonCell.textContent).not.toMatch(/加载|失败|错误/);
  });

  it("actorId 以 font-mono 截断显示——不是完整 UUID 明文，也不会拿审批人用户名顶替", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    const audit: AdminTagAuditEntry[] = [
      {
        action: "tag.canonical.status",
        actorId: AUDIT_ACTOR_ID,
        requestId: "req-1",
        reason: null,
        before: null,
        after: null,
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ];
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(auditDetail(item, audit))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));

    const auditLog = await screen.findByTestId(`canonical-tag-audit-log-${item.id}`);
    const actorCell = within(auditLog).getByTestId(`canonical-tag-audit-log-${item.id}-item-0-actor`);
    expect(actorCell.className).toContain("font-mono");
    // 截断——渲染出的文本不等于完整 UUID。
    expect(actorCell.textContent).not.toContain(AUDIT_ACTOR_ID);
    // 完整值仍留存于 title，供需要时查看，而不是彻底丢弃。
    expect(actorCell.getAttribute("title")).toBe(AUDIT_ACTOR_ID);
  });

  it("before/after 里的数组值（如 aliases）渲染成可读的顿号列表，不是整块 JSON", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    const audit: AdminTagAuditEntry[] = [
      {
        action: "tag.canonical.aliases.replace",
        actorId: AUDIT_ACTOR_ID,
        requestId: "req-1",
        reason: null,
        before: { aliases: ["武侠", "wuxia"] },
        after: { aliases: ["武侠", "wuxia", "新别名"] },
        createdAt: "2026-08-12T00:00:00.000Z",
      },
    ];
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(auditDetail(item, audit))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));

    const auditLog = await screen.findByTestId(`canonical-tag-audit-log-${item.id}`);
    const diff = within(auditLog).getByTestId(`canonical-tag-audit-log-${item.id}-item-0-diff`);
    expect(diff.textContent).toContain("武侠、wuxia");
    // 不是整块 JSON 糊上去——既没有方括号数组字面量，也没有带引号的 JSON 键。
    expect(diff.textContent).not.toContain('["武侠"');
    expect(diff.textContent).not.toContain('{"aliases"');
  });

  it("audit 为空数组时展示明确空态文案「暂无变更记录」", async () => {
    const item = canonicalTagItem();
    const view = projectAdminCanonicalTagList(canonicalTagList([item]));
    fetchMock.mockResolvedValueOnce(okResponse(projectAdminCanonicalTagDetail(canonicalTagDetail(item))));

    render(<CanonicalTagsClient items={view.items} tagManage="granted" />);
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${item.id}`));

    const auditLog = await screen.findByTestId(`canonical-tag-audit-log-${item.id}`);
    expect(within(auditLog).getByText("暂无变更记录")).toBeTruthy();
  });
});
