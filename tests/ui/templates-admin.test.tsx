import "./setup-cleanup";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SITE_LOCALES, SITE_LOCALE_LABELS } from "@/lib/locale/locale-canonical";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";

/**
 * M6 admin UI bite tests (交接提示词 B-2), P2-02B UI parity pass. Same
 * discipline as `tests/ui/novels-batch-publish.test.tsx`: only the Server
 * Action module and `next/navigation` are replaced, the real
 * `TemplateManager` component (four-card CPS-parity form + `BlockEditor`)
 * drives the assertions.
 */

const actions = vi.hoisted(() => ({
  createTemplateAction: vi.fn(),
  updateTemplateAction: vi.fn(),
  setTemplateStatusAction: vi.fn(),
  deleteTemplateAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/templates/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import { TemplateManager, type TemplateRow } from "@/app/(admin)/templates/_components/template-manager";

const ROW: TemplateRow = {
  id: "template-1",
  templateKey: "tpl-1",
  templateName: "示例模板",
  locale: "en",
  version: 1,
  schemaVersion: 2,
  status: "active",
  applicableArticleType: "novel_article",
  bodyTemplate: "<p>{novel_title}</p>",
  contentTemplate: [{ type: "paragraph", content: "{novel_title}" }],
  seoTemplate: { title: "{novel_title}", metaTitle: "{novel_title}", metaDescription: "{novel_description}" },
  slugTemplate: "",
  metaKeywordsTemplate: "",
  articleCount: 0,
};

const SEED_ROW: TemplateRow = {
  ...ROW,
  id: "template-seed",
  templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY,
  templateName: "系统默认模板",
};

function fillBasicFields(templateKey: string, templateName = "测试模板") {
  fireEvent.change(screen.getByLabelText("模板 Key"), { target: { value: templateKey } });
  fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: templateName } });
}

function addBlock(typeLabel: "标题" | "段落" | "CTA 按钮" | "图片" | "分隔线") {
  fireEvent.click(screen.getByRole("button", { name: typeLabel }));
}

beforeEach(() => {
  actions.createTemplateAction.mockReset();
  actions.updateTemplateAction.mockReset();
  actions.setTemplateStatusAction.mockReset();
  actions.deleteTemplateAction.mockReset();
  routerRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TemplateManager · 列表", () => {
  it("渲染每一行的 key / 语种（中文标签）/ 模板名称 / 文章类型 / 版本 / 状态 / 使用数", () => {
    render(<TemplateManager rows={[ROW]} canWrite />);
    expect(screen.getByText("tpl-1")).toBeTruthy();
    expect(screen.getByText("英文")).toBeTruthy(); // locale "en" 渲染中文标签，不是裸码
    expect(screen.queryByText("en")).toBeNull();
    expect(screen.getByText("示例模板")).toBeTruthy();
    expect(screen.getByText("小说文章")).toBeTruthy();
    expect(screen.getByText("启用")).toBeTruthy(); // status "active" 渲染中文，不是裸码
    expect(screen.queryByText("active")).toBeNull();
  });

  it("locale 为 null 时显示「全部」", () => {
    render(<TemplateManager rows={[{ ...ROW, locale: null }]} canWrite />);
    expect(screen.getByText("全部")).toBeTruthy();
  });

  it("空列表显示提示文案", () => {
    render(<TemplateManager rows={[]} canWrite />);
    expect(screen.getByText(/暂无模板/)).toBeTruthy();
  });

  it("canWrite=false 时新建/启停/删除按钮全部禁用", () => {
    render(<TemplateManager rows={[ROW]} canWrite={false} />);
    expect((screen.getByText("新建模板") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("停用") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("删除") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("TemplateManager · 基本信息表单", () => {
  it("表单里不存在「版本」字段或文案——version 已从写入契约中移除", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    expect(screen.queryByLabelText("版本")).toBeNull();
    expect(screen.queryByText("版本")).toBeNull();
  });

  it("语种下拉渲染 15 个 SITE_LOCALES 选项 + 「全部语种」，选「英文」提交的是 en", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));

    const localeSelect = screen.getByLabelText("模板语种") as HTMLSelectElement;
    expect(localeSelect.options.length).toBe(SITE_LOCALES.length + 1);
    expect(within(localeSelect).getByRole("option", { name: "全部语种" })).toBeTruthy();
    for (const locale of SITE_LOCALES) {
      expect(within(localeSelect).getByRole("option", { name: SITE_LOCALE_LABELS[locale] })).toBeTruthy();
    }

    fillBasicFields("tpl-locale");
    fireEvent.change(localeSelect, { target: { value: "en" } });
    addBlock("段落");
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(actions.createTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.createTemplateAction.mock.calls[0];
    expect(input.template.locale).toBe("en");
  });

  it("选「全部语种」提交的 locale 是 null", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    fillBasicFields("tpl-locale-all");
    fireEvent.change(screen.getByLabelText("模板语种"), { target: { value: "" } });
    addBlock("段落");
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(actions.createTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.createTemplateAction.mock.calls[0];
    expect(input.template.locale).toBeNull();
  });

  it("适用文章类型下拉渲染 5 个中文选项", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    const select = screen.getByLabelText("适用文章类型") as HTMLSelectElement;
    expect(select.options.length).toBe(5);
    for (const label of ["小说文章", "普通博客", "榜单文章", "阅读指南", "通用模板"]) {
      expect(within(select).getByRole("option", { name: label })).toBeTruthy();
    }
  });

  it("状态下拉是中文（草稿/启用/停用），提交值仍是英文码", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    const statusSelect = screen.getByLabelText("状态") as HTMLSelectElement;
    for (const label of ["草稿", "启用", "停用"]) {
      expect(within(statusSelect).getByRole("option", { name: label })).toBeTruthy();
    }
    fillBasicFields("tpl-status");
    fireEvent.change(statusSelect, { target: { value: "active" } });
    addBlock("段落");
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(actions.createTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.createTemplateAction.mock.calls[0];
    expect(input.template.status).toBe("active");
  });

  it("新建模板时模板 Key 可编辑，编辑既有模板时 disabled", () => {
    const { unmount } = render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    expect((screen.getByLabelText("模板 Key") as HTMLInputElement).disabled).toBe(false);
    unmount();

    render(<TemplateManager rows={[ROW]} canWrite />);
    fireEvent.click(screen.getByText("编辑"));
    expect((screen.getByLabelText("模板 Key") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("TemplateManager · 内容区块编辑器", () => {
  it("增：点击「添加区块」按钮追加对应类型的区块，计数更新", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    expect(screen.getByText("0 个区块")).toBeTruthy();
    addBlock("标题");
    expect(screen.getByText("1 个区块")).toBeTruthy();
    addBlock("段落");
    expect(screen.getByText("2 个区块")).toBeTruthy();
    expect((screen.getByLabelText("区块 1 类型") as HTMLSelectElement).value).toBe("heading");
    expect((screen.getByLabelText("区块 2 类型") as HTMLSelectElement).value).toBe("paragraph");
  });

  it("改：编辑区块内容文本", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    addBlock("段落");
    fireEvent.change(screen.getByLabelText("区块 1 内容"), { target: { value: "Hello world" } });
    expect((screen.getByLabelText("区块 1 内容") as HTMLTextAreaElement).value).toBe("Hello world");
  });

  it("排：点击「上移」交换相邻区块顺序", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    addBlock("标题");
    addBlock("段落");
    fireEvent.change(screen.getByLabelText("区块 2 内容"), { target: { value: "Hello" } });

    const upButtons = screen.getAllByRole("button", { name: "上移" });
    fireEvent.click(upButtons[1]!); // move block #2 (paragraph) up

    expect((screen.getByLabelText("区块 1 类型") as HTMLSelectElement).value).toBe("paragraph");
    expect((screen.getByLabelText("区块 1 内容") as HTMLTextAreaElement).value).toBe("Hello");
    expect((screen.getByLabelText("区块 2 类型") as HTMLSelectElement).value).toBe("heading");
  });

  it("删：点击「删除区块」移除对应区块，计数更新", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    addBlock("标题");
    addBlock("段落");
    expect(screen.getByText("2 个区块")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "删除区块" })[0]!);
    expect(screen.getByText("1 个区块")).toBeTruthy();
    expect((screen.getByLabelText("区块 1 类型") as HTMLSelectElement).value).toBe("paragraph");
  });

  it("快速插入落在光标位置，不是末尾追加", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    addBlock("段落");
    const textarea = screen.getByLabelText("区块 1 内容") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "ABCD" } });
    textarea.setSelectionRange(2, 2);

    // The title card has its own "{书名}" chip too — scope to this block's
    // own variable toolbar (the textarea's parent) to avoid ambiguity.
    const blockScope = within(textarea.parentElement as HTMLElement);
    fireEvent.click(blockScope.getByRole("button", { name: "{书名}" }));

    expect(textarea.value).toBe("AB{novel_title}CD");
  });

  it("标题模板卡片的快速插入同样落在光标位置（不是 append）", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    const titleInput = screen.getByLabelText("标题模板") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "AABB" } });
    titleInput.setSelectionRange(2, 2);

    fireEvent.click(screen.getByRole("button", { name: "{简介}" }));

    expect(titleInput.value).toBe("AA{novel_description}BB");
  });

  it("条件渲染 chip 只提供给 required:false 的三个字段", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    addBlock("段落");
    expect(screen.getByRole("button", { name: "{if cover_url}…{endif}" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "{if total_chapter_count}…{endif}" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "{if preview_chapter_count}…{endif}" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "{if novel_title}…{endif}" })).toBeNull();
    expect(screen.queryByRole("button", { name: "{if promo_redirect_url}…{endif}" })).toBeNull();
  });

  it("图片区块不渲染可编辑文本框——content 字段在编译期被忽略", () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    addBlock("图片");
    expect(screen.queryByLabelText("区块 1 内容")).toBeNull();
    expect(screen.getByText(/图片区块固定输出封面图/)).toBeTruthy();
  });

  it("空区块列表被前端拦截：不调用 action，回显中文错误", async () => {
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    fillBasicFields("tpl-empty-blocks");
    // 有意不添加任何区块
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("区块");
    expect(screen.getByRole("alert").textContent).not.toBe("template_content_invalid");
    expect(actions.createTemplateAction).not.toHaveBeenCalled();
  });
});

describe("TemplateManager · 新建/编辑提交", () => {
  it("提交新建表单调用 createTemplateAction 并在成功后刷新", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));

    fillBasicFields("tpl-new");
    addBlock("段落");
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(actions.createTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.createTemplateAction.mock.calls[0];
    expect(input.template.templateKey).toBe("tpl-new");
    expect(input.template.templateName).toBe("测试模板");
    expect(input.template.contentTemplate).toEqual([{ type: "paragraph", content: "" }]);
    expect(input.template).not.toHaveProperty("version");
    expect(input.template).not.toHaveProperty("bodyTemplate");
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("创建失败时表单保持打开，错误码回显为中文而不是英文码", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: false, code: "template_schema_invalid" });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    fillBasicFields("tpl-bad");
    addBlock("段落");
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const message = screen.getByRole("alert").textContent ?? "";
    expect(message).not.toBe("template_schema_invalid");
    expect(message).toContain("模板结构未通过校验");
    // Form is still open — the "模板 Key" field is still on screen.
    expect(screen.getByLabelText("模板 Key")).toBeTruthy();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("已登记的十个 template_* 错误码全部渲染为中文", async () => {
    const codes = [
      "template_key_invalid",
      "template_name_invalid",
      "template_locale_invalid",
      "template_article_type_invalid",
      "template_content_invalid",
      "template_status_invalid",
      "template_title_invalid",
      "template_body_invalid",
      "template_schema_invalid",
      "template_write_failed",
    ];
    for (const code of codes) {
      actions.createTemplateAction.mockResolvedValue({ ok: false, code });
      const { unmount } = render(<TemplateManager rows={[]} canWrite />);
      fireEvent.click(screen.getByText("新建模板"));
      fillBasicFields("tpl-code");
      addBlock("段落");
      fireEvent.click(screen.getByText("保存并校验"));
      await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      const message = screen.getByRole("alert").textContent ?? "";
      expect(message, `code=${code}`).not.toBe(code);
      expect(/[一-鿿]/.test(message), `code=${code} should render Chinese, got: ${message}`).toBe(true);
      unmount();
    }
  });

  it("点击编辑打开表单并预填现有值（含内容区块），提交调用 updateTemplateAction", async () => {
    actions.updateTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[ROW]} canWrite />);
    fireEvent.click(screen.getByText("编辑"));
    expect((screen.getByLabelText("模板 Key") as HTMLInputElement).value).toBe("tpl-1");
    expect((screen.getByLabelText("模板名称") as HTMLInputElement).value).toBe("示例模板");
    expect((screen.getByLabelText("标题模板") as HTMLInputElement).value).toBe("{novel_title}");
    expect(screen.getByText("1 个区块")).toBeTruthy();
    expect((screen.getByLabelText("区块 1 类型") as HTMLSelectElement).value).toBe("paragraph");
    expect((screen.getByLabelText("区块 1 内容") as HTMLTextAreaElement).value).toBe("{novel_title}");

    fireEvent.click(screen.getByText("保存并校验"));
    await vi.waitFor(() => expect(actions.updateTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.updateTemplateAction.mock.calls[0];
    expect(input.id).toBe("template-1");
    expect(input.template.contentTemplate).toEqual([{ type: "paragraph", content: "{novel_title}" }]);
  });

  it("打开内置默认模板（system-default-v1）时显示正文将被重新编译的提示", () => {
    // The warning text is split across a `<strong>` child, so `getByText`
    // would ambiguously match both the wrapping `<p>` and the `<strong>` —
    // check the rendered document text directly instead.
    render(<TemplateManager rows={[SEED_ROW]} canWrite />);
    fireEvent.click(screen.getByText("编辑"));
    expect(document.body.textContent).toContain("按区块重新编译的版本");
  });

  it("非内置模板不显示该提示", () => {
    render(<TemplateManager rows={[ROW]} canWrite />);
    fireEvent.click(screen.getByText("编辑"));
    expect(document.body.textContent).not.toContain("按区块重新编译的版本");
  });
});

describe("TemplateManager · 启停/删除", () => {
  it("点击停用对 active 行调用 setTemplateStatusAction(status: inactive)", async () => {
    actions.setTemplateStatusAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[ROW]} canWrite />);
    fireEvent.click(screen.getByText("停用"));
    await vi.waitFor(() => expect(actions.setTemplateStatusAction).toHaveBeenCalledTimes(1));
    expect(actions.setTemplateStatusAction.mock.calls[0]![0]).toMatchObject({ id: "template-1", status: "inactive" });
  });

  it("使用数 > 0 时删除按钮禁用", () => {
    render(<TemplateManager rows={[{ ...ROW, articleCount: 3 }]} canWrite />);
    expect((screen.getByText("删除") as HTMLButtonElement).disabled).toBe(true);
  });

  it("使用数为 0 时点击删除调用 deleteTemplateAction", async () => {
    actions.deleteTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[ROW]} canWrite />);
    fireEvent.click(screen.getByText("删除"));
    await vi.waitFor(() => expect(actions.deleteTemplateAction).toHaveBeenCalledTimes(1));
    expect(actions.deleteTemplateAction.mock.calls[0]![0]).toMatchObject({ id: "template-1" });
  });
});
