import "./setup-cleanup";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  projectAdminCanonicalTag,
  projectAdminNovelTags,
  type AdminCanonicalTagView,
  type AdminCapabilityState,
  type AdminNovelTagsView,
} from "@/contracts";
import type {
  AdminCanonicalTagItem,
  AdminNovelTags,
  AdminResolvedTag,
  AdminTagAuditEntry,
} from "@/domain/tagging-admin";

import { installDialogShim } from "./jsdom-dialog";

/**
 * P2-06.5 Admin V1 — Novel tag panel (read-only) + manual takeover editor.
 *
 * Kernel-shaped fixtures only, pushed through the real `projectAdminNovelTags`
 * / `projectAdminCanonicalTag` — never hand-written view objects. That is
 * what makes "provenance is an array, both entries render" and "manual mode
 * ships empty mapped/auto arrays" assertions mean anything: they are testing
 * the real projection plus the real component, not a fixture someone already
 * shaped to make the assertion pass.
 *
 * `adminFetch` is not stubbed — `fetch` is — so envelope parsing is real.
 * `next/navigation`'s `useRouter` is mocked because jsdom has no router.
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { NovelTagsSummary } = await import("@/app/(admin)/novels/_components/novel-tags-panel");
const { NovelTagsEditor } = await import("@/app/(admin)/novels/_components/novel-tags-editor");

installDialogShim();

const NOVEL_ID = "24040000-0000-4000-8000-000000000900";

function resolvedTag(overrides: Partial<AdminResolvedTag> = {}): AdminResolvedTag {
  return {
    canonicalTagId: "24040000-0000-4000-8000-0000000000c1",
    stableId: "ct-v1-revenge",
    slug: "revenge",
    displayName: "复仇",
    provenance: ["mapped"],
    ...overrides,
  };
}

function novelTagsKernel(overrides: Partial<AdminNovelTags> = {}): AdminNovelTags {
  return {
    mode: "automatic",
    revision: "3",
    effective: [resolvedTag()],
    manual: [],
    mapped: [resolvedTag()],
    auto: [],
    lastManualMutation: null,
    ...overrides,
  };
}

function tagsView(overrides: Partial<AdminNovelTags> = {}): AdminNovelTagsView {
  return projectAdminNovelTags(novelTagsKernel(overrides));
}

function canonicalTagKernel(overrides: Partial<AdminCanonicalTagItem> = {}): AdminCanonicalTagItem {
  return {
    id: "canonical-0000-4000-8000-000000000001",
    stableId: "ct-v1-revenge",
    slug: "revenge",
    active: true,
    canonicalDefinition: "Revenge-driven plot",
    facet: null,
    sortOrder: 1,
    taxonomyVersion: "v1",
    translations: [{ locale: "zh", displayName: "复仇" }],
    aliases: [],
    keywordSummary: { total: 0, active: 0, lexiconVersions: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMutation: null,
    ...overrides,
  };
}

const CANONICAL_TAGS: readonly AdminCanonicalTagView[] = [
  canonicalTagKernel(),
  canonicalTagKernel({
    id: "canonical-0000-4000-8000-000000000002",
    stableId: "ct-v1-romance",
    slug: "romance",
    canonicalDefinition: "Romance-driven plot",
    sortOrder: 2,
    translations: [{ locale: "zh", displayName: "言情" }],
  }),
].map(projectAdminCanonicalTag);

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

function renderEditor(overrides: {
  tagsView?: AdminNovelTagsView;
  canonicalTags?: readonly AdminCanonicalTagView[];
  capability?: AdminCapabilityState;
} = {}) {
  return render(
    <NovelTagsEditor
      novelId={NOVEL_ID}
      tagsView={overrides.tagsView ?? tagsView()}
      canonicalTags={overrides.canonicalTags ?? CANONICAL_TAGS}
      capability={overrides.capability ?? "granted"}
    />,
  );
}

function dialogs(): HTMLDialogElement[] {
  return Array.from(document.querySelectorAll("dialog"));
}

/**
 * A closed native `<dialog>` is correctly excluded from the accessibility
 * tree — `within(dialog).queryByRole("heading")` finds nothing once
 * `dialog.open` is false, exactly like a real browser/AT would report it.
 * So identifying *which* dialog is which has to read the raw DOM (`querySelector`,
 * `.textContent`), never a role query: only the one currently-open dialog is
 * ever role-queryable, and closed dialogs still need to be found (e.g. to
 * assert they closed) and read for their static heading text.
 */
function dialogByHeading(text: string): HTMLDialogElement {
  const found = dialogs().find((dialog) => dialog.querySelector("h2")?.textContent === text);
  if (!found) throw new Error(`no <dialog> with heading "${text}"`);
  return found;
}

function takeoverDialog(): HTMLDialogElement {
  return dialogByHeading("手动接管标签");
}

function emptyConfirmDialog(): HTMLDialogElement {
  return dialogByHeading("确认设为 0 个标签？");
}

function exitDialog(): HTMLDialogElement {
  return dialogByHeading("确认恢复自动标签？");
}

function lastFetchBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("P2-06.5 书目详情 · 标签只读展示（NovelTagsSummary）", () => {
  it("自动模式下渲染 provenance，双重来源两个标签都要显示", () => {
    const both = resolvedTag({
      canonicalTagId: "24040000-0000-4000-8000-0000000000c2",
      displayName: "复仇·自动",
      provenance: ["mapped", "auto"],
    });
    // 真实场景下，一个 provenance 为 ["mapped","auto"] 的标签会同时出现在
    // effective / mapped / auto 三处（并集 + 两个明细区）——三处都要展示双重来源。
    render(<NovelTagsSummary tags={tagsView({ effective: [both], mapped: [both], auto: [both] })} />);

    const chips = screen.getAllByTestId(`novel-tag-chip-${both.canonicalTagId}`);
    expect(chips.length).toBe(3);
    for (const chip of chips) {
      // 双重 provenance 都要出现，不能只取 provenance[0]
      expect(chip.textContent).toContain("映射");
      expect(chip.textContent).toContain("自动");
    }
  });

  it("自动模式 0 个标签，与人工接管 0 个标签在文案上明确不同", () => {
    const { unmount } = render(
      <NovelTagsSummary tags={tagsView({ effective: [], mapped: [], auto: [] })} />,
    );
    expect(screen.getByTestId("novel-tags-mode-header").textContent).toBe("自动模式 · 0 个标签");
    unmount();

    render(<NovelTagsSummary tags={tagsView({ mode: "manual", manual: [], effective: [] })} />);
    expect(screen.getByTestId("novel-tags-mode-header").textContent).toBe("人工接管 · 0 标签");
  });

  it("人工模式渲染 manual 集合，且绝不把未计算的 mapped/auto 显示成「0 个」", () => {
    const manualTag = resolvedTag({ provenance: ["manual"], displayName: "人工标签" });
    render(
      <NovelTagsSummary
        tags={tagsView({ mode: "manual", manual: [manualTag], effective: [manualTag], mapped: [], auto: [] })}
      />,
    );

    expect(screen.getByTestId("novel-tags-mode-header").textContent).toBe("人工接管 · 1 个标签");
    expect(screen.getByText("人工标签")).toBeTruthy();
    // 明确说明「不计算」而不是暗示「渠道映射 0 个 / 自动分类 0 个」
    expect(screen.getByTestId("novel-tags-mode-explanation").textContent).toBe(
      "人工接管期间不计算自动结果",
    );
    expect(screen.queryByText("渠道映射 0 个")).toBeNull();
    expect(screen.queryByText("自动分类 0 个")).toBeNull();
  });
});

/**
 * P2-06.5 CPS-parity F1: `lastManualMutation` was already projected onto
 * `AdminNovelTagsView` but rendered as one bare line. These tests cover the
 * shared `TagAuditEntryRow` wiring — in particular that `null` (a novel that
 * has never been manually taken over) reads as "从未人工接管", not as a
 * loading/error state, and that a real entry renders through the same
 * compact-summary component the Canonical Tag / Mapping screens use.
 */
describe("P2-06.5 书目详情 · 最近人工变更（NovelTagsSummary, CPS-parity F1）", () => {
  it("lastManualMutation 为 null 时显示「从未人工接管」，不是加载中或错误文案", () => {
    render(<NovelTagsSummary tags={tagsView({ lastManualMutation: null })} />);
    const empty = screen.getByTestId("novel-tags-last-manual-mutation-empty");
    expect(empty.textContent).toBe("从未人工接管");
    expect(screen.queryByTestId("novel-tags-last-manual-mutation")).toBeNull();
  });

  it("lastManualMutation 非空时渲染紧凑摘要（动作 chip + 时间 + actorId + reason）", () => {
    const lastManualMutation: AdminTagAuditEntry = {
      action: "tag.manual.replace",
      actorId: "99999999-8888-4777-8666-555555555555",
      requestId: "req-1",
      reason: null,
      before: null,
      after: { mode: "manual", revision: "4" },
      createdAt: "2026-08-15T00:00:00.000Z",
    };
    render(<NovelTagsSummary tags={tagsView({ lastManualMutation })} />);

    expect(screen.queryByTestId("novel-tags-last-manual-mutation-empty")).toBeNull();
    const row = screen.getByTestId("novel-tags-last-manual-mutation");
    expect(within(row).getByText("人工设置标签")).toBeTruthy();
    // reason 为 null 时渲染「—」，不是空白或报错文案。
    const reasonCell = within(row).getByTestId("novel-tags-last-manual-mutation-reason");
    expect(reasonCell.textContent).toContain("—");
  });

  /**
   * `lastManualMutation` is independent of the novel's *current* `mode` — a
   * novel that has since exited manual mode back to automatic still carries
   * its manual history here. Null still means "never taken over," even when
   * automatic mode has other reasons to look empty.
   */
  it("即使当前是自动模式，只要 lastManualMutation 有值就照常渲染摘要", () => {
    const lastManualMutation: AdminTagAuditEntry = {
      action: "tag.manual.exit",
      actorId: null,
      requestId: "req-2",
      reason: null,
      before: null,
      after: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    render(<NovelTagsSummary tags={tagsView({ mode: "automatic", lastManualMutation })} />);
    expect(within(screen.getByTestId("novel-tags-last-manual-mutation")).getByText("退出人工接管")).toBeTruthy();
  });
});

describe("P2-06.5 手动接管编辑器 · 零预填", () => {
  it("打开接管弹窗时，所有 checkbox 都是未选中状态", () => {
    renderEditor({ tagsView: tagsView({ effective: [resolvedTag()], mapped: [resolvedTag()] }) });
    fireEvent.click(screen.getByRole("button", { name: "手动接管标签" }));

    const dialog = takeoverDialog();
    expect(dialog.open).toBe(true);
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((box) => box.checked === false)).toBe(true);
    expect(within(dialog).getByTestId("takeover-selected-count").textContent).toBe("已选 0 个");
  });

  it("弹窗里没有「一键使用当前标签」之类的预填入口", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "手动接管标签" }));
    const dialog = takeoverDialog();

    for (const forbidden of ["使用当前标签", "一键导入", "预填当前标签", "复制当前标签", "导入自动结果"]) {
      expect(screen.queryByRole("button", { name: forbidden })).toBeNull();
    }
    // 弹窗内按钮只有「清空已选标签」加 ConfirmDialog 自带的取消/确认——没有第四个按钮。
    const buttons = within(dialog).getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["清空已选标签", "取消", "确认接管并保存"]);
  });

  it("弹窗文案是 FULL_SNAPSHOT 措辞", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "手动接管标签" }));
    const dialog = takeoverDialog();

    expect(dialog.textContent).toContain(
      "手动接管后，你当前选择的标签集合将成为这本小说的完整最终标签集合。",
    );
    expect(dialog.textContent).toContain("自动标签和渠道映射不会继续叠加到最终结果。");
  });
});

describe("P2-06.5 手动接管编辑器 · 空快照二次确认", () => {
  it("0 个选择时点确认不会直接提交，而是弹出第二次确认；确认后 body 是 canonicalTagIds: []", async () => {
    fetchMock.mockResolvedValue(okResponse({ mode: "manual", revision: "4", replayed: false }));
    renderEditor({ tagsView: tagsView({ revision: "4" }) });

    fireEvent.click(screen.getByRole("button", { name: "手动接管标签" }));
    fireEvent.click(within(takeoverDialog()).getByRole("button", { name: "确认接管并保存" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(takeoverDialog().open).toBe(false);
    const secondDialog = emptyConfirmDialog();
    expect(secondDialog.open).toBe(true);
    expect(secondDialog.textContent).toContain("你正在把最终标签设为 0 个。该小说将不带任何题材标签。");

    fireEvent.click(within(secondDialog).getByRole("button", { name: "确认设为 0 个" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastFetchBody().canonicalTagIds).toEqual([]);
  });
});

describe("P2-06.5 手动接管编辑器 · 恢复自动标签", () => {
  it("自动模式下不出现「恢复自动标签」按钮", () => {
    renderEditor({ tagsView: tagsView({ mode: "automatic" }) });
    expect(screen.queryByRole("button", { name: "恢复自动标签" })).toBeNull();
  });

  it("人工模式下点击并确认会发起 exit_manual", async () => {
    fetchMock.mockResolvedValue(okResponse({ mode: "automatic", revision: "5", replayed: false }));
    renderEditor({
      tagsView: tagsView({ mode: "manual", manual: [resolvedTag()], effective: [resolvedTag()], revision: "4" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "恢复自动标签" }));
    const dialog = exitDialog();
    expect(dialog.open).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认恢复" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = lastFetchBody();
    expect(body).toEqual({
      action: "exit_manual",
      requestId: body.requestId,
      novelId: NOVEL_ID,
      expectedRevision: "4",
    });
  });
});

describe("P2-06.5 手动接管编辑器 · 修订冲突不重试", () => {
  it("409 revision_conflict 显示真实中文文案，只发一次请求，不自动重试", async () => {
    fetchMock.mockResolvedValue(
      envelopeResponse({ ok: false, status: 409, code: "revision_conflict" }),
    );
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "手动接管标签" }));
    const dialog = takeoverDialog();
    const [firstBox] = within(dialog).getAllByRole("checkbox");
    fireEvent.click(firstBox);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认接管并保存" }));

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("数据已被其他操作更新，请刷新后重试");

    // 等一轮 microtask，确认没有静默重试
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 刷新按钮存在，但点击只调用 router.refresh，不会再发请求
    fireEvent.click(within(notice).getByRole("button", { name: "刷新" }));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("P2-06.5 手动接管编辑器 · requestId 与 expectedRevision", () => {
  it("expectedRevision 以字符串发送；requestId 在 header 与 body 中一致", async () => {
    fetchMock.mockResolvedValue(okResponse({ mode: "manual", revision: "43", replayed: false }));
    renderEditor({ tagsView: tagsView({ revision: "42" }) });

    fireEvent.click(screen.getByRole("button", { name: "手动接管标签" }));
    const dialog = takeoverDialog();
    fireEvent.click(within(dialog).getAllByRole("checkbox")[0]);
    fireEvent.click(within(dialog).getByRole("button", { name: "确认接管并保存" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    const body = lastFetchBody();

    expect(body.expectedRevision).toBe("42");
    expect(typeof body.expectedRevision).toBe("string");
    expect(init.headers["x-request-id"]).toBe(body.requestId);
    expect(String(body.requestId)).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("P2-06.5 手动接管编辑器 · 能力位门禁", () => {
  it("没有 tag:manage 时禁用写入控件，并点名能力位", () => {
    renderEditor({
      capability: "denied",
      tagsView: tagsView({ mode: "manual", manual: [resolvedTag()], effective: [resolvedTag()] }),
    });

    const blockedText = screen.getByText(/标签管理（tag:manage）/).textContent ?? "";
    expect(blockedText).toContain("缺少能力位");

    const takeoverButton = screen.getByRole("button", { name: "手动接管标签" }) as HTMLButtonElement;
    const exitButton = screen.getByRole("button", { name: "恢复自动标签" }) as HTMLButtonElement;
    expect(takeoverButton.disabled).toBe(true);
    expect(exitButton.disabled).toBe(true);
  });

  it("admin_two_factor_required 与 admin_capability_denied 文案不同", () => {
    const { unmount } = renderEditor({ capability: "denied" });
    const deniedText = screen.getByText(/标签管理（tag:manage）/).textContent;
    unmount();

    renderEditor({ capability: "two_factor_required" });
    const twoFactorText = screen.getByText(/标签管理（tag:manage）/).textContent;

    expect(deniedText).not.toBe(twoFactorText);
    expect(twoFactorText).toContain("双重验证");
    expect(deniedText).toContain("联系管理员");
  });

  it("granted 时不显示阻塞提示，且写入按钮可用", () => {
    renderEditor({ capability: "granted" });
    expect(screen.queryByText(/标签管理（tag:manage）/)).toBeNull();
    expect((screen.getByRole("button", { name: "手动接管标签" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
