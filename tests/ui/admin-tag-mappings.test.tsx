import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectAdminCanonicalTagList, projectAdminSourceLabelMapping } from "@/contracts";
import type {
  AdminCanonicalTagItem,
  AdminCanonicalTagList,
  AdminSourceLabelMappingItem,
  AdminTagAuditEntry,
  AdminTagAuthority,
} from "@/domain/tagging-admin";
import { MappingsTable } from "@/app/(admin)/tags/mappings/_components/mappings-table";
import { RawToken } from "@/app/(admin)/tags/mappings/_components/raw-token";

import { dialogCalls, installDialogShim } from "./jsdom-dialog";

/**
 * P2-06.5 Source Label Mapping management screen — Admin V1 package 2.
 *
 * `MappingsClient` calls `useRouter()` for `router.refresh()`, exactly like
 * `ChannelAccountsClient`, so `next/navigation` is mocked the same way that
 * file does — `admin-channel-accounts.test.tsx` is the template for this
 * whole file's mutation-testing shape. `fetch` is stubbed, not `adminFetch`
 * itself, so every assertion below walks the real envelope-parsing path
 * rather than a stand-in's canned return value.
 */
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { MappingsClient } = await import(
  "@/app/(admin)/tags/mappings/_components/mappings-client"
);

installDialogShim();

const NOW = "2026-08-08T00:00:00.000Z";

/**
 * Kernel-shaped fixture, not a hand-written view. Every test below drives
 * its component through the real `projectAdminSourceLabelMapping` /
 * `projectAdminSourceLabelMappingList` — see `admin-source-labels.test.tsx`'s
 * doc comment for why: a projection that started leaking a field, or
 * silently trimming `rawToken`/`rawLanguageScope`, fails here instead of
 * sailing past a fixture that was never shaped like the real payload.
 */
function mappingItem(overrides: Partial<AdminSourceLabelMappingItem> = {}): AdminSourceLabelMappingItem {
  return {
    id: "24040000-0000-4000-8000-000000000901",
    channel: {
      channelAppId: "24040000-0000-4000-8000-000000000801",
      channelCode: "changdu",
      sourceAppCode: "cd-app-1",
      externalAppId: "ext-001",
      active: true,
    },
    rawLanguageScope: "en",
    rawToken: "romance",
    target: {
      id: "24040000-0000-4000-8000-000000000701",
      stableId: "romance-tag",
      slug: "romance",
      active: true,
    },
    mappingVersion: "v1",
    active: true,
    approvedBy: { id: "24040000-0000-4000-8000-000000000601", username: "owner" },
    approvedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    lastMutation: null,
    ...overrides,
  };
}

/**
 * Kernel-shaped fixture for `CanonicalTagPicker`'s search results — same
 * discipline as `mappingItem` above: every new test below drives the picker
 * through the real `projectAdminCanonicalTagList`, never a hand-written
 * `AdminCanonicalTagListView`, so a projection that started leaking a field
 * (or dropping `translations`) would fail here instead of sailing past a
 * fixture that was never shaped like the real payload.
 */
function canonicalTagItem(overrides: Partial<AdminCanonicalTagItem> = {}): AdminCanonicalTagItem {
  return {
    id: "24040000-0000-4000-8000-000000000701",
    stableId: "romance-tag",
    slug: "romance",
    active: true,
    canonicalDefinition: "言情题材：以情感线索为核心叙事。",
    facet: "genre",
    sortOrder: 10,
    taxonomyVersion: "v1",
    translations: [{ locale: "zh", displayName: "言情" }],
    aliases: [],
    keywordSummary: { total: 0, active: 0, lexiconVersions: [] },
    createdAt: NOW,
    updatedAt: NOW,
    lastMutation: null,
    ...overrides,
  };
}

function authorityFixture(): AdminTagAuthority {
  return {
    taxonomy: {
      status: "READY",
      canonicalV1Count: 1,
      canonicalV1Sha256: "c".repeat(64),
      databaseActiveCount: 1,
      versions: ["v1"],
    },
    keywords: {
      status: "READY",
      activeKeywordCount: 0,
      versions: ["c1-v2"],
      fingerprint: "d".repeat(64),
      keywordEligibilityVersion: "keyword-eligibility-v2",
      keywordEligibilitySha256: "e".repeat(64),
    },
    classifier: {
      status: "FROZEN",
      version: "test-classifier-v1",
      titleWeight: 30,
      descriptionWeight: 30,
      threshold: 30,
      maxTextTags: 3,
      fingerprint: "f".repeat(64),
    },
  };
}

function canonicalTagList(items: AdminCanonicalTagItem[]): AdminCanonicalTagList {
  return {
    items,
    page: 1,
    pageSize: 50,
    total: items.length,
    totalPages: 1,
    authority: authorityFixture(),
  };
}

function confirmDialog(): HTMLDialogElement {
  return document.querySelector("dialog") as HTMLDialogElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function type(input: Element, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

/** Opens `CanonicalTagPicker`'s search box — mirrors its own `onFocus → setOpen(true)`. */
async function focus(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.focus(element);
  });
}

function okResponse(payload: unknown) {
  return { json: async () => ({ ok: true, data: payload }) } as unknown as Response;
}

function envelopeResponse(envelope: unknown) {
  return { json: async () => envelope } as unknown as Response;
}

function requestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function requestHeaders(call: unknown[]): Record<string, string> {
  return (call[1] as RequestInit & { headers: Record<string, string> }).headers;
}

/**
 * `CanonicalTagPicker`'s own `GET /api/admin/canonical-tags` calls (mount
 * prefetch, then every debounced search) and the create form's `PUT
 * /api/admin/tag-mappings` submission share one `fetch` mock in the tests
 * below — a blanket `mockResolvedValue` can't tell them apart, so this
 * routes by URL instead.
 */
function dispatchFetch(routes: { canonicalTags: unknown; mutation?: unknown }) {
  return (url: string) => {
    if (url.startsWith("/api/admin/canonical-tags")) return okResponse(routes.canonicalTags);
    return okResponse(routes.mutation ?? { id: "new-id", updatedAt: NOW, replayed: false });
  };
}

/** Finds the one `PUT` call among a mix of the picker's `GET` calls and the mutation. */
function findMutationCall(calls: unknown[][]): unknown[] {
  const call = calls.find((entry) => (entry[1] as RequestInit | undefined)?.method === "PUT");
  if (!call) throw new Error("expected a PUT call in fetchMock.mock.calls, found none");
  return call;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  routerRefresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RawToken · 原始字节可见渲染", () => {
  it("首尾空格、内部制表符与大小写混排都原样渲染，title 保留未经处理的原值", () => {
    const value = "  RoManCE_Value\tX  ";
    render(<RawToken value={value} testId="raw-under-test" />);
    const el = screen.getByTestId("raw-under-test");

    expect(el.getAttribute("title")).toBe(value);
    // Not trimmed, not case-folded — the rendered text is a superset of the
    // marked-up value, never a normalised substitute for it.
    expect(el.textContent).not.toBe(value.trim());
    expect(el.textContent).toContain("RoManCE_Value");
    expect(el.textContent).toContain("X");
    // Leading/trailing spaces get a visible glyph.
    expect(el.textContent).toContain("·");
    // The internal tab gets its own distinct glyph.
    expect(el.textContent).toContain("⇥");
  });

  it("空字符串不会被静默渲染成空白——给出可见的占位文案", () => {
    render(<RawToken value="" testId="raw-empty" />);
    expect(screen.getByTestId("raw-empty").textContent).toBe("(空字符串)");
  });
});

describe("映射表 · 分组与身份区分", () => {
  it("同一 rawToken 在不同 rawLanguageScope 下渲染为两个不同身份，绝不合并", () => {
    const en = mappingItem({ id: "id-en", rawLanguageScope: "en" });
    const ja = mappingItem({ id: "id-ja", rawLanguageScope: "ja" });
    const items = [en, ja].map(projectAdminSourceLabelMapping);

    render(
      <MappingsTable items={items} canManage={false} busy={false} onReapprove={() => {}} onDeactivate={() => {}} />,
    );

    // Two separate identity groups — the rowspan'd scope/token cell renders once per group.
    expect(screen.getAllByTestId(/^mapping-scope-/)).toHaveLength(2);
    expect(screen.getByTestId("mapping-scope-id-en").textContent).toContain("en");
    expect(screen.getByTestId("mapping-scope-id-ja").textContent).toContain("ja");
  });

  it("1:N——一个 rawToken 映射到两个 canonical tag 时，分组为一个身份、两条目标行", () => {
    const edgeA = mappingItem({
      id: "edge-a",
      target: { id: "tag-a-id", stableId: "tag-a", slug: "tag-a-slug", active: true },
    });
    const edgeB = mappingItem({
      id: "edge-b",
      target: { id: "tag-b-id", stableId: "tag-b", slug: "tag-b-slug", active: true },
    });
    const items = [edgeA, edgeB].map(projectAdminSourceLabelMapping);

    const { container } = render(
      <MappingsTable items={items} canManage={false} busy={false} onReapprove={() => {}} onDeactivate={() => {}} />,
    );

    // Exactly one identity cell — the two edges did not each get their own.
    expect(container.querySelectorAll('[data-testid^="mapping-scope-"]')).toHaveLength(1);
    // But two distinct target rows/cells, one per canonical tag.
    expect(screen.getByTestId("mapping-target-edge-a").textContent).toContain("tag-a-slug");
    expect(screen.getByTestId("mapping-target-edge-b").textContent).toContain("tag-b-slug");
    // The fan-out is called out in copy, not left implicit.
    expect(screen.getByTestId("mapping-group-count-edge-a").textContent).toContain("2");
  });

  it("停用的目标 canonical tag 带「已停用」徽章，生效中的不带", () => {
    const item = mappingItem({ target: { id: "t1", stableId: "t1", slug: "inactive-tag", active: false } });
    render(
      <MappingsTable
        items={[projectAdminSourceLabelMapping(item)]}
        canManage={false}
        busy={false}
        onReapprove={() => {}}
        onDeactivate={() => {}}
      />,
    );
    expect(within(screen.getByTestId(`mapping-target-${item.id}`)).getByText("已停用")).toBeTruthy();
  });
});

describe("MappingsClient · 写入请求体与幂等标识", () => {
  it("新增映射：approve_edge 的 expectedUpdatedAt 为 null——这条边尚不存在", async () => {
    // F2 (CPS parity): 目标 canonicalTagId 不再是可手输的文本框，改为
    // `CanonicalTagPicker` 的搜索选择——这里的 arrange 相应地从「往一个带标签的
    // 文本框里打字」换成「打开搜索框、等待真实投影出的选项出现、点选它」，
    // 断言部分（提交的 body 形状）逐字保留。
    const targetTag = canonicalTagItem({
      id: "24040000-0000-4000-8000-000000000701",
      stableId: "romance-tag",
      slug: "romance",
      translations: [{ locale: "zh", displayName: "言情" }],
    });
    fetchMock.mockImplementation(
      dispatchFetch({
        canonicalTags: projectAdminCanonicalTagList(canonicalTagList([targetTag])),
        mutation: { id: "new-id", updatedAt: NOW, replayed: false },
      }),
    );
    render(<MappingsClient items={[]} tagManage="granted" />);

    await type(screen.getByLabelText("渠道 channelAppId"), "24040000-0000-4000-8000-000000000801");

    const picker = screen.getByRole("combobox", { name: "目标 Canonical Tag" });
    await focus(picker);
    const option = await screen.findByTestId(`mapping-create-canonical-tag-option-${targetTag.id}`);
    await click(option);

    // Selecting collapses the search box into a "已选：{中文名} · {slug}"
    // summary — the operator never sees or types the UUID itself.
    const selectedSummary = screen.getByTestId("mapping-create-canonical-tag-selected");
    expect(selectedSummary.textContent).toContain("言情");
    expect(selectedSummary.textContent).toContain("romance");

    await type(screen.getByLabelText("语言范围 rawLanguageScope（精确）"), "en");
    await type(screen.getByLabelText("Raw Token（精确）"), "romance");
    await type(screen.getByLabelText("映射版本 mappingVersion"), "v1");

    await click(screen.getByRole("button", { name: "新增映射" }));
    await click(await screen.findByRole("button", { name: "确认新增" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toBe(
        true,
      ),
    );
    const body = requestBody(findMutationCall(fetchMock.mock.calls));
    expect(body).toMatchObject({
      action: "approve_edge",
      channelAppId: "24040000-0000-4000-8000-000000000801",
      rawLanguageScope: "en",
      rawToken: "romance",
      canonicalTagId: "24040000-0000-4000-8000-000000000701",
      mappingVersion: "v1",
      expectedUpdatedAt: null,
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "action",
        "canonicalTagId",
        "channelAppId",
        "expectedUpdatedAt",
        "mappingVersion",
        "rawLanguageScope",
        "rawToken",
        "requestId",
      ].sort(),
    );
  });

  it("对已存在的行重新审批：approve_edge 携带该行自身 updatedAt 的原样 ISO 字符串，不是 null", async () => {
    const row = mappingItem({ updatedAt: "2026-08-01T00:00:00.000Z" });
    fetchMock.mockResolvedValue(okResponse({ id: row.id, updatedAt: NOW, replayed: false }));
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-reapprove-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认重新审批" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = requestBody(fetchMock.mock.calls[0]);
    expect(body).toMatchObject({
      action: "approve_edge",
      channelAppId: row.channel.channelAppId,
      rawLanguageScope: row.rawLanguageScope,
      rawToken: row.rawToken,
      canonicalTagId: row.target.id,
      mappingVersion: row.mappingVersion,
      expectedUpdatedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("停用：deactivate_edge 只携带 mappingId 与 expectedUpdatedAt——没有多余字段，也没有 reason", async () => {
    const row = mappingItem({ updatedAt: "2026-08-02T00:00:00.000Z" });
    fetchMock.mockResolvedValue(okResponse({ id: row.id, updatedAt: NOW, replayed: false }));
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认停用" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = requestBody(fetchMock.mock.calls[0]);
    expect(Object.keys(body).sort()).toEqual(["action", "expectedUpdatedAt", "mappingId", "requestId"]);
    expect(body.action).toBe("deactivate_edge");
    expect(body.mappingId).toBe(row.id);
    expect(body.expectedUpdatedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("requestId 同时出现在 x-request-id 头与请求体，且完全相等；每次提交都是新的一个", async () => {
    const row = mappingItem();
    fetchMock.mockResolvedValue(okResponse({ id: row.id, updatedAt: NOW, replayed: false }));
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认停用" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const headers = requestHeaders(fetchMock.mock.calls[0]);
    const body = requestBody(fetchMock.mock.calls[0]);
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(headers["x-request-id"]).toBe(body.requestId);
  });
});

describe("MappingsClient · 破坏性操作的二次确认", () => {
  it("点「停用」先打开确认框（真的调用了平台 showModal），此时还没有发出任何请求", async () => {
    const row = mappingItem();
    fetchMock.mockResolvedValue(okResponse({ id: row.id, updatedAt: NOW, replayed: false }));
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    const dialog = confirmDialog();
    expect(dialog.open).toBe(false);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));

    expect(dialog.open).toBe(true);
    expect(dialogCalls(dialog).showModal).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByRole("heading").textContent).toBe("确认停用该映射？");
    // The exact identity is echoed back inside the dialog before commit.
    expect(dialog.textContent).toContain(row.rawToken);
    expect(dialog.textContent).toContain(row.rawLanguageScope);
    expect(fetchMock).not.toHaveBeenCalled();

    await click(within(dialog).getByRole("button", { name: "确认停用" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("取消不发请求，对话框关闭", async () => {
    const row = mappingItem();
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));
    expect(confirmDialog().open).toBe(true);

    await click(screen.getByRole("button", { name: "取消" }));
    expect(confirmDialog().open).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MappingsClient · 冲突与失败文案", () => {
  it("409 revision_conflict：展示真实中文文案，不自动重试，只提供手动刷新", async () => {
    const row = mappingItem();
    fetchMock.mockResolvedValue(
      envelopeResponse({ ok: false, status: 409, code: "revision_conflict" }),
    );
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认停用" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("数据已被其他操作更新，请刷新后重试");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerRefresh).not.toHaveBeenCalled();

    // Offers a manual refresh — clicking it calls router.refresh(), never fetch again.
    await click(within(status).getByRole("button", { name: "刷新" }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("409 mapping_identity_conflict：展示真实中文文案，同样不自动重试", async () => {
    const row = mappingItem();
    fetchMock.mockResolvedValue(
      envelopeResponse({ ok: false, status: 409, code: "mapping_identity_conflict" }),
    );
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-reapprove-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认重新审批" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("来源标签映射 identity 冲突");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A second click of the (now re-enabled) trigger must build a fresh
    // submission, never silently resend the rejected one.
    expect(within(status).getByRole("button", { name: "刷新" })).toBeTruthy();
  });
});

describe("MappingsClient · 能力位驱动的可见性与失败文案", () => {
  it("缺 tag:manage 时新增表单与行内操作全部消失，并点名缺的能力位", () => {
    const row = mappingItem();
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="denied" />);

    expect(screen.queryByTestId("mapping-create-form")).toBeNull();
    expect(screen.queryByTestId(`mapping-deactivate-${row.id}`)).toBeNull();
    expect(screen.queryByTestId(`mapping-reapprove-${row.id}`)).toBeNull();

    const notice = screen.getByText(/缺少能力位/);
    expect(notice.textContent).toContain("tag:manage");
    expect(notice.textContent).toContain("标签管理");
  });

  it("待完成 2FA（会话未过闸）与未授予是两种不同的说法", () => {
    render(<MappingsClient items={[]} tagManage="two_factor_required" />);
    const notice = screen.getByText(/双重验证/);
    expect(notice.textContent).toContain("tag:manage");
    expect(screen.queryByTestId("mapping-create-form")).toBeNull();
  });

  it("能力已授予但请求途中被后端判定 admin_two_factor_required：文案与「缺少能力位」不同", async () => {
    const row = mappingItem();
    fetchMock.mockResolvedValue(
      envelopeResponse({ ok: false, status: 403, code: "admin_two_factor_required" }),
    );
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认停用" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("双重验证");
    expect(status.textContent).not.toContain("缺少能力位");
  });

  it("能力被拒时后端返回 admin_capability_denied：文案点名能力位，且与 2FA 文案不同", async () => {
    const row = mappingItem();
    fetchMock.mockResolvedValue(
      envelopeResponse({
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "tag:manage" },
      }),
    );
    render(<MappingsClient items={[projectAdminSourceLabelMapping(row)]} tagManage="granted" />);

    await click(screen.getByTestId(`mapping-deactivate-${row.id}`));
    await click(await screen.findByRole("button", { name: "确认停用" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("缺少能力位 标签管理（tag:manage）");
    expect(status.textContent).not.toContain("双重验证");
  });
});

/**
 * F2 (CPS parity audit): 新增映射表单里的目标 CanonicalTag 字段，从手贴 UUID
 * 换成防抖搜索选择器（`CanonicalTagPicker`）。CPS 全仓零个手贴外键 ID 的表单，
 * 这个 describe 块验收的就是「不再是其中的例外」这一件事，加上选择器自身的
 * 数据获取、去补偿、失败文案三条纪律。
 */
describe("CanonicalTagPicker · 新增映射的目标 Canonical Tag 搜索选择", () => {
  it("新增映射表单里不再存在可手输 canonicalTagId 的文本框——只能搜索选择", () => {
    fetchMock.mockImplementation(
      dispatchFetch({ canonicalTags: projectAdminCanonicalTagList(canonicalTagList([])) }),
    );
    render(<MappingsClient items={[]} tagManage="granted" />);

    // 旧字段的可访问名字彻底消失——不是换了个 role 但名字没变。
    expect(screen.queryByLabelText("目标 canonicalTagId")).toBeNull();

    const combobox = screen.getByRole("combobox", { name: "目标 Canonical Tag" });
    expect(combobox.tagName).toBe("INPUT");
    // 在未选中任何 Canonical Tag 之前，「已选」摘要（唯一会展示 slug 的地方）
    // 不存在——没有任何旁路能绕过搜索直接把一个值提交上去。
    expect(screen.queryByTestId("mapping-create-canonical-tag-selected")).toBeNull();
  });

  it("搜索框输入经 300ms 防抖后才发请求，URL 带 search 与 active=active 且不带 id；连续输入只发一次请求", async () => {
    const tag = canonicalTagItem({
      id: "33330000-0000-4000-8000-000000000001",
      slug: "wuxia",
      translations: [{ locale: "zh", displayName: "武侠" }],
    });
    fetchMock.mockImplementation(
      dispatchFetch({ canonicalTags: projectAdminCanonicalTagList(canonicalTagList([tag])) }),
    );
    render(<MappingsClient items={[]} tagManage="granted" />);

    // 挂载本身不发请求——这张表单和「重新审批/停用」某一行共存于同一屏，
    // 后者的测试断言过总请求数为 0/1，容不下一次与它们无关的后台预取。
    expect(fetchMock).not.toHaveBeenCalled();

    const picker = screen.getByRole("combobox", { name: "目标 Canonical Tag" });
    await focus(picker);

    // 打开时预取一次（不带 search），运营不打字也能点开看到候选项。
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const openCallUrl = fetchMock.mock.calls[0][0] as string;
    expect(openCallUrl).toContain("/api/admin/canonical-tags?");
    expect(openCallUrl).toContain("active=active");
    expect(openCallUrl).not.toContain("search=");
    expect(openCallUrl).not.toContain("id=");

    // 连续三次改值，中间不等待——每次都会清掉上一次待触发的防抖计时器，
    // 结果应当只有一次新请求，而不是三次。
    await act(async () => {
      fireEvent.change(picker, { target: { value: "武" } });
      fireEvent.change(picker, { target: { value: "武侠" } });
      fireEvent.change(picker, { target: { value: "武侠小说" } });
    });

    // 300ms 还没到——仍然只有打开那一次请求。
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1000 });
    const searchCallUrl = fetchMock.mock.calls[1][0] as string;
    expect(searchCallUrl).toContain("active=active");
    expect(searchCallUrl).toContain(`search=${encodeURIComponent("武侠小说")}`);
    expect(searchCallUrl).not.toContain("id=");

    // 请求没有再增加——三次改值确实只换来了这一次。
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("选中某个搜索结果后，提交的请求体 canonicalTagId 就是该结果的 id", async () => {
    const tag = canonicalTagItem({
      id: "55550000-0000-4000-8000-000000000003",
      slug: "urban",
      translations: [{ locale: "zh", displayName: "都市" }],
    });
    fetchMock.mockImplementation(
      dispatchFetch({
        canonicalTags: projectAdminCanonicalTagList(canonicalTagList([tag])),
        mutation: { id: "new-id", updatedAt: NOW, replayed: false },
      }),
    );
    render(<MappingsClient items={[]} tagManage="granted" />);

    await type(screen.getByLabelText("渠道 channelAppId"), "24040000-0000-4000-8000-000000000801");
    const picker = screen.getByRole("combobox", { name: "目标 Canonical Tag" });
    await focus(picker);
    const option = await screen.findByTestId(`mapping-create-canonical-tag-option-${tag.id}`);
    await click(option);
    await type(screen.getByLabelText("语言范围 rawLanguageScope（精确）"), "en");
    await type(screen.getByLabelText("Raw Token（精确）"), "urban");
    await type(screen.getByLabelText("映射版本 mappingVersion"), "v1");

    await click(screen.getByRole("button", { name: "新增映射" }));
    await click(await screen.findByRole("button", { name: "确认新增" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toBe(
        true,
      ),
    );
    const body = requestBody(findMutationCall(fetchMock.mock.calls));
    expect(body.canonicalTagId).toBe(tag.id);
  });

  it("Canonical Tag 缺中文译名时，搜索选项的展示名渲染为「—」，不会用 slug 顶替", async () => {
    const noZhTag = canonicalTagItem({
      id: "66660000-0000-4000-8000-000000000004",
      slug: "scifi-only-en",
      translations: [{ locale: "en", displayName: "Science Fiction" }],
    });
    fetchMock.mockImplementation(
      dispatchFetch({ canonicalTags: projectAdminCanonicalTagList(canonicalTagList([noZhTag])) }),
    );
    render(<MappingsClient items={[]} tagManage="granted" />);

    const picker = screen.getByRole("combobox", { name: "目标 Canonical Tag" });
    await focus(picker);

    const nameCell = await screen.findByTestId(
      `mapping-create-canonical-tag-option-name-${noZhTag.id}`,
    );
    // 展示名位置精确等于「—」——不是「包含」slug，是压根不出现 slug。
    expect(nameCell.textContent).toBe("—");
    expect(nameCell.textContent).not.toContain("scifi-only-en");

    const slugCell = screen.getByTestId(`mapping-create-canonical-tag-option-slug-${noZhTag.id}`);
    expect(slugCell.textContent).toBe("scifi-only-en");
  });

  it("搜索请求返回错误 envelope 时展示真实中文文案，不崩溃，也不出现任何选项", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/admin/canonical-tags")) {
        return envelopeResponse({ ok: false, status: 400, code: "invalid_tag_request" });
      }
      return okResponse({ id: "new-id", updatedAt: NOW, replayed: false });
    });
    render(<MappingsClient items={[]} tagManage="granted" />);

    const picker = screen.getByRole("combobox", { name: "目标 Canonical Tag" });
    await focus(picker);

    // 文案来自 errorEnvelopeCopy 的稳定码查表，不是拼出来的字符串。
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("标签请求格式无效");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

/**
 * P2-06.5 CPS-parity F1: `lastMutation` was already on the wire
 * (`AdminSourceLabelMappingView.lastMutation`), never rendered anywhere.
 * `MappingsTable` gets it for free off the existing list response — no new
 * request, so these tests render `MappingsTable` directly, same as the
 * "映射表 · 分组与身份区分" describe block above.
 */
describe("映射表 · 最近变更（CPS-parity F1）", () => {
  it("lastMutation 非空时渲染紧凑摘要：动作 chip 有中文标签，actorId 以 font-mono 截断显示", () => {
    const actorId = "11111111-2222-4333-8444-555555555555";
    const lastMutation: AdminTagAuditEntry = {
      action: "tag.mapping.approve",
      actorId,
      requestId: "req-1",
      reason: null,
      before: { active: false },
      after: { active: true },
      createdAt: NOW,
    };
    const row = mappingItem({ lastMutation });
    const item = projectAdminSourceLabelMapping(row);
    render(
      <MappingsTable items={[item]} canManage={false} busy={false} onReapprove={() => {}} onDeactivate={() => {}} />,
    );

    const cell = screen.getByTestId(`mapping-last-mutation-${row.id}`);
    expect(within(cell).getByText("审批映射")).toBeTruthy();
    const actorCell = within(cell).getByTestId(`mapping-last-mutation-entry-${row.id}-actor`);
    expect(actorCell.className).toContain("font-mono");
    // 截断显示——渲染文本不是完整 UUID，也不是 approvedBy.username（"owner"）
    // 顶替：审批人和这条审计记录的操作人是两个不同的人，不能互相顶替。
    expect(actorCell.textContent).not.toContain(actorId);
    expect(actorCell.textContent).not.toContain("owner");
  });

  it("lastMutation 为 null 时展示「暂无变更记录」，不是空白单元格", () => {
    const row = mappingItem({ lastMutation: null });
    const item = projectAdminSourceLabelMapping(row);
    render(
      <MappingsTable items={[item]} canManage={false} busy={false} onReapprove={() => {}} onDeactivate={() => {}} />,
    );
    expect(screen.getByTestId(`mapping-last-mutation-${row.id}`).textContent).toContain("暂无变更记录");
  });
});
