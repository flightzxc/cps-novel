import "./setup-cleanup";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceItemRow } from "@/app/(admin)/catalog-sync/_lib/read-source-items";

import { installDialogShim } from "./jsdom-dialog";

/**
 * `BatchCreateContentDialog` never had its own test file before L10N P5
 * (`tests/ui/catalog-sync-client.test.tsx`'s own header comment names
 * `create-content-dialog.tsx` as the "no独立测试文件" precedent this dialog
 * used to follow too). This file is scoped narrowly to the P5 §1.D /
 * P2 复核 C5-b change — the template picker's locale filtering/grouping and
 * React key uniqueness — not a full re-test of the dry-run/apply flow
 * (`dryRunContentCreationBatchAction` is left permanently pending in every
 * test here; the picker itself renders unconditionally, before the preview
 * stage resolves, so these assertions do not need it to settle).
 */

const actions = vi.hoisted(() => ({
  dryRunContentCreationBatchAction: vi.fn(),
  applyContentCreationBatchAction: vi.fn(),
}));

vi.mock("@/app/(admin)/catalog-sync/_actions", () => actions);
const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { BatchCreateContentDialog } = await import(
  "@/app/(admin)/catalog-sync/_components/batch-create-content-dialog"
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
    promoClaimEligible: false,
    promoClaimIneligibleReason: "source_not_linked",
    ...overrides,
  };
}

type TemplateOption = { readonly id: string; readonly templateKey: string; readonly locale: string; readonly version: number };

function template(overrides: Partial<TemplateOption> & Pick<TemplateOption, "templateKey" | "locale">): TemplateOption {
  return { id: `${overrides.templateKey}-id`, version: 1, ...overrides };
}

function renderDialog(options: { selectedItems: readonly SourceItemRow[]; templateOptions?: readonly TemplateOption[] }) {
  // Never resolves — the picker renders before any dry-run result lands.
  actions.dryRunContentCreationBatchAction.mockReturnValue(new Promise(() => {}));
  return render(
    <BatchCreateContentDialog
      selectedItems={options.selectedItems}
      maxBatchSize={50}
      contentPublishGranted
      contentPublishBlockedReason={null}
      onClose={() => {}}
      onSubmitted={() => {}}
      templateOptions={options.templateOptions ?? []}
    />,
  );
}

function templateSelect(): HTMLSelectElement {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

beforeEach(() => {
  actions.dryRunContentCreationBatchAction.mockReset();
  actions.applyContentCreationBatchAction.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("模板下拉按所选来源条目的派生语种过滤（P2 复核 C5-b）", () => {
  it("单一语种：过滤掉其它语种的模板，不分组（无 optgroup）", () => {
    renderDialog({
      selectedItems: [row({ id: "src-1", sourceLocale: "en" })],
      templateOptions: [
        template({ templateKey: "tpl-en", locale: "en" }),
        template({ templateKey: "tpl-ru", locale: "ru" }),
      ],
    });
    const select = templateSelect();
    const options = within(select).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("tpl-en");
    expect(select.querySelectorAll("optgroup")).toHaveLength(0);
    expect(within(select).queryByText(/tpl-ru/)).toBeNull();
  });

  it("单一语种：仍显示语种标签（不是裸模板名）", () => {
    renderDialog({
      selectedItems: [row({ id: "src-1", sourceLocale: "ja" })],
      templateOptions: [template({ templateKey: "tpl-ja", locale: "ja" })],
    });
    expect(templateSelect().textContent).toContain("ja");
    expect(templateSelect().textContent).toContain("日文");
  });

  it("模板语种与所选条目语种都不匹配时，回退到 system-default-v1 占位项", () => {
    renderDialog({
      selectedItems: [row({ id: "src-1", sourceLocale: "ru" })],
      templateOptions: [template({ templateKey: "tpl-en", locale: "en" })],
    });
    const select = templateSelect();
    expect(within(select).getByText(/system-default-v1/)).toBeTruthy();
    expect(within(select).queryByText(/tpl-en/)).toBeNull();
  });
});

describe("跨语种选择：下拉按语种分组（P2 复核 C5-b）", () => {
  it("所选条目跨 en/ru 两个语种时，下拉按语种分组为两个 optgroup", () => {
    renderDialog({
      selectedItems: [row({ id: "src-1", sourceLocale: "en" }), row({ id: "src-2", sourceLocale: "ru" })],
      templateOptions: [
        template({ templateKey: "tpl-en", locale: "en" }),
        template({ templateKey: "tpl-ru", locale: "ru" }),
        template({ templateKey: "tpl-ja", locale: "ja" }), // ja was never selected — must not appear at all.
      ],
    });
    const select = templateSelect();
    const groups = select.querySelectorAll("optgroup");
    expect(groups).toHaveLength(2);
    expect(Array.from(groups).map((group) => group.getAttribute("label"))).toEqual([
      "en（英文）",
      "ru（俄文）",
    ]);
    expect(within(select).queryByText(/tpl-ja/)).toBeNull();
  });

  it("跨语种时展示提示文案，说明单一语种选择保持不变", () => {
    renderDialog({
      selectedItems: [row({ id: "src-1", sourceLocale: "en" }), row({ id: "src-2", sourceLocale: "ru" })],
      templateOptions: [template({ templateKey: "tpl-en", locale: "en" }), template({ templateKey: "tpl-ru", locale: "ru" })],
    });
    expect(screen.getByTestId("batch-create-multi-locale-hint")).toBeTruthy();
  });

  it("单一语种时不展示跨语种提示文案", () => {
    renderDialog({
      selectedItems: [row({ id: "src-1", sourceLocale: "en" })],
      templateOptions: [template({ templateKey: "tpl-en", locale: "en" })],
    });
    expect(screen.queryByTestId("batch-create-multi-locale-hint")).toBeNull();
  });
});

describe("React key 唯一性：templateKey:version:locale（消除重复 key）", () => {
  it("同一 templateKey 在不同语种各出现一次也不会触发 React 重复 key 警告", () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderDialog({
        selectedItems: [row({ id: "src-1", sourceLocale: "en" }), row({ id: "src-2", sourceLocale: "ru" })],
        // Same templateKey+version text across two locales — legitimate
        // under this repo's schema (`@@unique([templateKey, version])` is
        // NOT scoped by locale) and exactly the shape a bare
        // `${templateKey}:${version}` key would collide on.
        templateOptions: [
          template({ templateKey: "shared-key", locale: "en", version: 1 }),
          template({ templateKey: "shared-key", locale: "ru", version: 1 }),
        ],
      });
      const duplicateKeyWarning = warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("Encountered two children with the same key")),
      );
      expect(duplicateKeyWarning).toBe(false);
      const select = templateSelect();
      expect(within(select).getAllByText(/shared-key/)).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
