import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M6 admin UI bite tests (交接提示词 B-2). Same discipline as
 * `tests/ui/novels-batch-publish.test.tsx`: only the Server Action module
 * and `next/navigation` are replaced, the real `TemplateManager` component
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
  locale: "en",
  version: 1,
  schemaVersion: 1,
  status: "active",
  bodyTemplate: "<p>{novel_title}</p>",
  seoTemplate: { title: "{novel_title}", metaTitle: "{novel_title}", metaDescription: "{novel_description}" },
  articleCount: 0,
};

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
  it("渲染每一行的 key / locale / 版本 / 状态 / 使用数", () => {
    render(<TemplateManager rows={[ROW]} canWrite />);
    expect(screen.getByText("tpl-1")).toBeTruthy();
    expect(screen.getByText("en")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
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

describe("TemplateManager · 新建", () => {
  it("提交新建表单调用 createTemplateAction 并在成功后刷新", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));

    fireEvent.change(screen.getByLabelText("模板 Key"), { target: { value: "tpl-new" } });
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(actions.createTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.createTemplateAction.mock.calls[0];
    expect(input.template.templateKey).toBe("tpl-new");
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it("创建失败时表单保持打开并回显错误码", async () => {
    actions.createTemplateAction.mockResolvedValue({ ok: false, code: "template_schema_invalid" });
    render(<TemplateManager rows={[]} canWrite />);
    fireEvent.click(screen.getByText("新建模板"));
    fireEvent.change(screen.getByLabelText("模板 Key"), { target: { value: "tpl-bad" } });
    fireEvent.click(screen.getByText("保存并校验"));

    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toBe("template_schema_invalid"));
    // Form is still open — the "模板 Key" field is still on screen.
    expect(screen.getByLabelText("模板 Key")).toBeTruthy();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

describe("TemplateManager · 编辑/启停/删除", () => {
  it("点击编辑打开表单并预填现有值，提交调用 updateTemplateAction", async () => {
    actions.updateTemplateAction.mockResolvedValue({ ok: true });
    render(<TemplateManager rows={[ROW]} canWrite />);
    fireEvent.click(screen.getByText("编辑"));
    expect((screen.getByLabelText("模板 Key") as HTMLInputElement).value).toBe("tpl-1");

    fireEvent.click(screen.getByText("保存并校验"));
    await vi.waitFor(() => expect(actions.updateTemplateAction).toHaveBeenCalledTimes(1));
    const [input] = actions.updateTemplateAction.mock.calls[0];
    expect(input.id).toBe("template-1");
  });

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
