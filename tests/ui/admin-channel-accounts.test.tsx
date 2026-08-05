import "./setup-cleanup";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectCredentialOperationAvailability } from "@/contracts";
import type { CredentialMetadataView } from "@/contracts";
import { CHANNEL_ACCOUNT_STATUSES, CREDENTIAL_STATUSES } from "@/domain/database-statuses";

import { dialogCalls, fireDialogCancel, installDialogShim } from "./jsdom-dialog";

/**
 * 渠道账户页的**渲染与接线**验收（P1-09 验收 ②③④⑤⑥）。
 *
 * 既有测试都停在这一屏之外：`admin-nav-parity` 验菜单树，`admin-sidebar` 验侧栏，
 * `admin-secret-boundary` 扫源码字符串与错误文案表，`tests/backend/auth/
 * admin-registry-parity.test.ts` 验六个 Action 的登记与 orphan POST 为零。
 * **没有任何一个用例把 `ChannelAccountsClient` 渲染出来过**——于是"表格只展示
 * 指纹前缀""破坏性操作有二次确认""六项操作各自连到哪个 Server Action"这些
 * 断言在源码扫描层面成立，在实际组件行为层面从未被验证。这个文件补的就是这段。
 *
 * 🔴 只替换两样东西：Server Action 模块与 `next/navigation`。前者带
 * `"use server"` 且 import `next/headers` 与 Prisma，jsdom 里加载不了；替身只
 * 记录"哪个 Action 被调、参数是什么"，**不改组件自己的判断**——按钮该不该出现、
 * 确认框开不开、reason 空了要不要拦，全走真实组件逻辑。
 * `adminFetch` 不替身，改 stub `fetch`，让任务面板走真实的 envelope 解析路径。
 */

const actions = vi.hoisted(() => ({
  createChannelAccountAction: vi.fn(),
  setChannelAccountStatusAction: vi.fn(),
  replaceCredentialAction: vi.fn(),
  enqueueCredentialAction: vi.fn(),
}));

const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/(admin)/channel-accounts/_actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const { ChannelAccountsClient } = await import(
  "@/app/(admin)/channel-accounts/_components/channel-accounts-client"
);
type ChannelAccountRow = Parameters<typeof ChannelAccountsClient>[0]["rows"][number];

installDialogShim();

const CHANNELS = [{ id: "ch-1", code: "changdu", name: "畅读" }] as const;

function credential(
  status: CredentialMetadataView["status"],
  id: string,
  prefix: string,
): CredentialMetadataView {
  return {
    credentialId: id,
    channelAccountId: `acct-${status}`,
    credentialType: "jwt",
    status,
    expiresAt: "2026-12-31T00:00:00.000Z",
    lastValidatedAt: "2026-08-01T00:00:00.000Z",
    fingerprintPrefix: prefix,
  };
}

function row(
  id: string,
  accountName: string,
  accountStatus: "active" | "disabled",
  credentials: readonly CredentialMetadataView[],
): ChannelAccountRow {
  return {
    account: {
      channelAccountId: id,
      channelId: "ch-1",
      businessId: `biz-${id}`,
      accountName,
      status: accountStatus,
      lastValidatedAt: "2026-08-01T00:00:00.000Z",
      lastSyncedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    channelCode: "changdu",
    channelName: "畅读",
    credentials,
  };
}

/** 五行刻意覆盖四种 credential 状态 + 完全没有凭证。 */
const ROWS: readonly ChannelAccountRow[] = [
  row("acct-active", "有效账户", "active", [credential("active", "cred-active", "a1b2c3d4")]),
  row("acct-superseded", "已作废账户", "active", [
    credential("superseded", "cred-superseded", "e5f6a7b8"),
  ]),
  row("acct-expired", "已过期账户", "active", [credential("expired", "cred-expired", "c9d0e1f2")]),
  row("acct-invalid", "校验失败账户", "active", [
    credential("invalid", "cred-invalid", "0a1b2c3d"),
  ]),
  row("acct-disabled", "待启用账户", "disabled", []),
];

const GRANTED_AVAILABILITY = projectCredentialOperationAvailability({ credentialManage: "granted" });
const DENIED_AVAILABILITY = projectCredentialOperationAvailability({ credentialManage: "denied" });

function renderPage(
  options: {
    rows?: readonly ChannelAccountRow[];
    credentialManage?: "granted" | "denied" | "two_factor_required";
  } = {},
) {
  const credentialManage = options.credentialManage ?? "granted";
  return render(
    <ChannelAccountsClient
      rows={options.rows ?? ROWS}
      channels={CHANNELS}
      availability={credentialManage === "granted" ? GRANTED_AVAILABILITY : DENIED_AVAILABILITY}
      credentialManage={credentialManage}
    />,
  );
}

/** 找到某个账户名所在的表格行。 */
function rowOf(accountName: string): HTMLElement {
  const cell = screen.getByText(accountName);
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${accountName}`);
  return tr as HTMLElement;
}

function confirmDialog(): HTMLDialogElement {
  return document.querySelector("dialog") as HTMLDialogElement;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function submitForm(element: Element): Promise<void> {
  const form = element.closest("form");
  if (!form) throw new Error("element is not inside a form");
  await act(async () => {
    fireEvent.submit(form);
  });
}

async function type(input: Element, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
}

function okResult<T>(data: T) {
  return { ok: true as const, data };
}

const QUEUED = {
  code: "credential_validation_queued" as const,
  state: "queued" as const,
  taskId: "task-77",
  credentialId: "cred-active",
  channelAccountId: "acct-active",
  enqueuedAt: "2026-08-05T00:00:00.000Z",
  mutationRequestId: "req-1",
};

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  routerRefresh.mockReset();
  actions.createChannelAccountAction.mockResolvedValue(okResult(null));
  actions.setChannelAccountStatusAction.mockResolvedValue(okResult(null));
  actions.replaceCredentialAction.mockResolvedValue(
    okResult(credential("active", "cred-new", "99887766")),
  );
  actions.enqueueCredentialAction.mockResolvedValue(okResult(QUEUED));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: null }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("渠道账户表格 · 列与状态取值", () => {
  it("列顺序与 CPS 一致，有能力位时多一列操作", () => {
    renderPage();
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "渠道",
      "业务ID",
      "账户名",
      "账户状态",
      "凭证",
      "过期时间",
      "最近验证",
      "操作",
    ]);
  });

  it("没有 credential:manage 时操作列整列消失，只剩只读七列", () => {
    renderPage({ credentialManage: "denied" });
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toHaveLength(7);
    expect(headers).not.toContain("操作");
  });

  it("账户状态只有启用/停用两种呈现——冻结集合就是两个值", () => {
    // 集合本身是冻结的两值；这里验的是"渲染出来的账户状态标签不超出这两个"。
    expect([...CHANNEL_ACCOUNT_STATUSES]).toEqual(["active", "disabled"]);

    renderPage();
    const labels = ROWS.map((entry) => {
      const cells = within(rowOf(entry.account.accountName)).getAllByRole("cell");
      return cells[3].textContent?.trim();
    });
    expect(new Set(labels)).toEqual(new Set(["启用", "停用"]));
    expect(labels[0]).toBe("启用");
    expect(labels[4]).toBe("停用");
  });

  it("凭证状态只有四种，且四种各有不同的中文标签", () => {
    expect([...CREDENTIAL_STATUSES]).toEqual(["active", "superseded", "expired", "invalid"]);

    renderPage();
    const rendered = new Map(
      ROWS.filter((entry) => entry.credentials.length > 0).map((entry) => {
        const cells = within(rowOf(entry.account.accountName)).getAllByRole("cell");
        return [entry.credentials[0].status, cells[4].textContent ?? ""];
      }),
    );

    expect([...rendered.keys()]).toEqual([...CREDENTIAL_STATUSES]);
    expect(rendered.get("active")).toContain("有效");
    expect(rendered.get("superseded")).toContain("已作废");
    expect(rendered.get("expired")).toContain("已过期");
    expect(rendered.get("invalid")).toContain("校验失败");
    // 四个标签互不相同，否则运营分不清两种坏法。
    const labels = [...rendered.values()].map((text) => text.replace(/[a-f0-9]{8}.*/i, "").trim());
    expect(new Set(labels).size).toBe(4);
  });

  it("完全没有凭证时显示未配置，而不是空白格", () => {
    renderPage();
    const cells = within(rowOf("待启用账户")).getAllByRole("cell");
    expect(cells[4].textContent).toContain("未配置");
  });

  it("空表渲染空状态，colspan 随操作列在不在而变", () => {
    const granted = renderPage({ rows: [] });
    expect(screen.getByText("暂无渠道账户").getAttribute("colspan")).toBe("8");
    granted.unmount();

    renderPage({ rows: [], credentialManage: "denied" });
    expect(screen.getByText("暂无渠道账户").getAttribute("colspan")).toBe("7");
  });
});

describe("渠道账户表格 · 密文永不进 DOM", () => {
  it("凭证列只出现指纹前缀", () => {
    renderPage();
    const cells = within(rowOf("有效账户")).getAllByRole("cell");
    expect(cells[4].textContent).toContain("a1b2c3d4");
    expect(within(cells[4] as HTMLElement).getByTitle("指纹前缀").textContent).toBe("a1b2c3d4");
  });

  it("整棵树不出现密文列名或完整凭证字段名", () => {
    renderPage();
    const html = document.body.innerHTML;
    for (const forbidden of [
      "encrypted_secret",
      "encryptedSecret",
      "secret_fingerprint",
      "secretFingerprint",
      "keyVersion",
      "key_version",
    ]) {
      expect(html, `DOM 里出现了 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("粘贴的 JWT 交给 Action 后不落在 DOM 里，输入框也被清空", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcHMifQ.SIGNATURE-NEVER-RENDERED";
    renderPage();

    const secretInput = within(rowOf("有效账户")).getByPlaceholderText("粘贴新 JWT");
    // 肩窥与浏览器自动填充历史都靠这两个属性挡住。
    expect(secretInput.getAttribute("type")).toBe("password");
    expect(secretInput.getAttribute("autocomplete")).toBe("off");

    await type(secretInput, jwt);
    await type(within(rowOf("有效账户")).getByPlaceholderText("原因"), "密钥轮换");
    await submitForm(secretInput);

    expect(actions.replaceCredentialAction).toHaveBeenCalledTimes(1);
    expect(actions.replaceCredentialAction.mock.calls[0][0]).toMatchObject({
      channelAccountId: "acct-active",
      secret: jwt,
      reason: "密钥轮换",
    });

    // Action 拿到了明文，页面没有。
    expect(document.body.textContent ?? "").not.toContain(jwt);
    expect(document.body.innerHTML).not.toContain(jwt);
    expect((secretInput as HTMLInputElement).value).toBe("");
  });

  it("Action 回传的凭证元数据里也只有前缀可渲染", async () => {
    renderPage();
    const secretInput = within(rowOf("有效账户")).getByPlaceholderText("粘贴新 JWT");
    await type(secretInput, "eyJ.new.jwt");
    await type(within(rowOf("有效账户")).getByPlaceholderText("原因"), "轮换");
    await submitForm(secretInput);

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("更新 JWT成功"));
    const returned = actions.replaceCredentialAction.mock.results[0].value;
    await expect(returned).resolves.toMatchObject({ ok: true });
    expect(document.body.textContent ?? "").not.toContain("eyJ.new.jwt");
  });
});

describe("六项操作各自连到正确的 Server Action", () => {
  it("新增渠道账号 → createChannelAccountAction", async () => {
    renderPage();
    await type(screen.getByLabelText("业务ID"), "biz-new");
    await type(screen.getByLabelText("账户名"), "新账户");
    await submitForm(screen.getByRole("button", { name: "新增渠道账号" }));

    expect(actions.createChannelAccountAction).toHaveBeenCalledTimes(1);
    expect(actions.createChannelAccountAction.mock.calls[0][0]).toMatchObject({
      channelId: "ch-1",
      businessId: "biz-new",
      accountName: "新账户",
    });
    expect(actions.setChannelAccountStatusAction).not.toHaveBeenCalled();
    expect(actions.enqueueCredentialAction).not.toHaveBeenCalled();
  });

  it("更新 JWT → replaceCredentialAction，且不误入 enqueue", async () => {
    renderPage();
    const secretInput = within(rowOf("有效账户")).getByPlaceholderText("粘贴新 JWT");
    await type(secretInput, "eyJ.a.b");
    await type(within(rowOf("有效账户")).getByPlaceholderText("原因"), "轮换");
    await submitForm(secretInput);

    expect(actions.replaceCredentialAction).toHaveBeenCalledTimes(1);
    expect(actions.enqueueCredentialAction).not.toHaveBeenCalled();
  });

  it("验证 → enqueueCredentialAction(operation=validate)，带的是 active 凭证 id", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "验证" }));

    expect(actions.enqueueCredentialAction).toHaveBeenCalledTimes(1);
    expect(actions.enqueueCredentialAction.mock.calls[0][0]).toMatchObject({
      channelAccountId: "acct-active",
      credentialId: "cred-active",
      operation: "validate",
    });
    // validate 不要求 reason，别顺手塞一个进去。
    expect(actions.enqueueCredentialAction.mock.calls[0][0].reason).toBeUndefined();
  });

  it("没有有效凭证时验证与作废都不可点——凭证已作废的行不该还能校验", () => {
    renderPage();
    for (const name of ["已作废账户", "已过期账户", "校验失败账户"]) {
      const scope = within(rowOf(name));
      expect((scope.getByRole("button", { name: "验证" }) as HTMLButtonElement).disabled).toBe(true);
      expect(
        (scope.getByRole("button", { name: "作废凭证" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(
      (within(rowOf("有效账户")).getByRole("button", { name: "验证" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("停用账户 → setChannelAccountStatusAction(nextStatus=disabled)", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));
    await type(screen.getByPlaceholderText("例如：密钥疑似泄漏，立即轮换"), "疑似泄漏");
    await click(screen.getByRole("button", { name: "停用" }));

    expect(actions.setChannelAccountStatusAction).toHaveBeenCalledTimes(1);
    expect(actions.setChannelAccountStatusAction.mock.calls[0][0]).toMatchObject({
      channelAccountId: "acct-active",
      nextStatus: "disabled",
      reason: "疑似泄漏",
    });
  });

  it("启用账户 → setChannelAccountStatusAction(nextStatus=active)", async () => {
    renderPage();
    const reasonInput = within(rowOf("待启用账户")).getByPlaceholderText("启用原因");
    await type(reasonInput, "误停用，恢复");
    await submitForm(reasonInput);

    expect(actions.setChannelAccountStatusAction).toHaveBeenCalledTimes(1);
    expect(actions.setChannelAccountStatusAction.mock.calls[0][0]).toMatchObject({
      channelAccountId: "acct-disabled",
      nextStatus: "active",
      reason: "误停用，恢复",
    });
  });

  it("作废凭证 → enqueueCredentialAction(operation=supersede)", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "作废凭证" }));
    await type(screen.getByPlaceholderText("例如：密钥疑似泄漏，立即轮换"), "凭证泄漏");
    await click(screen.getByRole("button", { name: "作废" }));

    expect(actions.enqueueCredentialAction).toHaveBeenCalledTimes(1);
    expect(actions.enqueueCredentialAction.mock.calls[0][0]).toMatchObject({
      channelAccountId: "acct-active",
      credentialId: "cred-active",
      operation: "supersede",
      reason: "凭证泄漏",
    });
  });

  it("每次提交都带一个新的 requestId——它就是幂等键，复用等于让后端拒绝", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "验证" }));
    await click(within(rowOf("有效账户")).getByRole("button", { name: "验证" }));

    const [first, second] = actions.enqueueCredentialAction.mock.calls.map((call) => call[0]);
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.requestId).not.toBe(first.requestId);
  });
});

describe("破坏性操作的二次确认", () => {
  it("停用账户先开确认框，点按钮那一下不写任何东西", async () => {
    renderPage();
    const dialog = confirmDialog();
    expect(dialog.open).toBe(false);

    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));

    expect(dialog.open).toBe(true);
    // 组件真的走了平台模态，而不是自己搭了个 div 假装。
    expect(dialogCalls(dialog).showModal).toBe(1);
    expect(within(dialog).getByRole("heading").textContent).toBe("确认停用该渠道账户？");
    expect(actions.setChannelAccountStatusAction).not.toHaveBeenCalled();
  });

  it("作废凭证先开确认框，并把要作废的指纹前缀写进正文", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "作废凭证" }));

    const dialog = confirmDialog();
    expect(dialog.open).toBe(true);
    expect(within(dialog).getByRole("heading").textContent).toBe("确认作废该凭证？");
    expect(dialog.textContent).toContain("a1b2c3d4");
    expect(actions.enqueueCredentialAction).not.toHaveBeenCalled();
  });

  it("取消就是取消：关框、不调 Action、reason 不残留到下一次", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));
    await type(screen.getByPlaceholderText("例如：密钥疑似泄漏，立即轮换"), "先不停了");
    await click(screen.getByRole("button", { name: "取消" }));

    expect(confirmDialog().open).toBe(false);
    expect(actions.setChannelAccountStatusAction).not.toHaveBeenCalled();

    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));
    expect(
      (screen.getByPlaceholderText("例如：密钥疑似泄漏，立即轮换") as HTMLInputElement).value,
    ).toBe("");
  });

  it("Escape 触发的 cancel 也走取消分支，不是被忽略", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));

    await act(async () => {
      fireDialogCancel(confirmDialog());
    });

    expect(confirmDialog().open).toBe(false);
    expect(actions.setChannelAccountStatusAction).not.toHaveBeenCalled();
  });
});

describe("reason 必填", () => {
  it("停用：reason 为空时确认键点了也不提交，框留在原地", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));
    await click(screen.getByRole("button", { name: "停用" }));

    expect(actions.setChannelAccountStatusAction).not.toHaveBeenCalled();
    expect(confirmDialog().open).toBe(true);
  });

  it("停用：只打空格也不算填了原因", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));
    await type(screen.getByPlaceholderText("例如：密钥疑似泄漏，立即轮换"), "    ");
    await click(screen.getByRole("button", { name: "停用" }));

    expect(actions.setChannelAccountStatusAction).not.toHaveBeenCalled();
    expect(confirmDialog().open).toBe(true);
  });

  it("作废：reason 为空时同样不入队", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "作废凭证" }));
    await click(screen.getByRole("button", { name: "作废" }));

    expect(actions.enqueueCredentialAction).not.toHaveBeenCalled();
    expect(confirmDialog().open).toBe(true);
  });

  it("提交前 reason 会去掉首尾空白，审计里不留“ 泄漏 ”这种值", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "停用账户" }));
    await type(screen.getByPlaceholderText("例如：密钥疑似泄漏，立即轮换"), "  泄漏  ");
    await click(screen.getByRole("button", { name: "停用" }));

    expect(actions.setChannelAccountStatusAction.mock.calls[0][0].reason).toBe("泄漏");
  });

  it("启用与更新 JWT 的原因框都是 required，浏览器层就拦住空提交", () => {
    renderPage();
    expect(
      within(rowOf("待启用账户")).getByPlaceholderText("启用原因").hasAttribute("required"),
    ).toBe(true);
    const scope = within(rowOf("有效账户"));
    expect(scope.getByPlaceholderText("原因").hasAttribute("required")).toBe(true);
    expect(scope.getByPlaceholderText("粘贴新 JWT").hasAttribute("required")).toBe(true);
  });
});

describe("任务面板与 credential_task_not_found", () => {
  function stubFetch(payload: unknown, status = 200) {
    // 显式标注签名，用例才能对"请求了哪个 URL"下断言。
    const spy = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => new Response(JSON.stringify(payload), { status }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  async function queueValidation() {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "验证" }));
  }

  it("入队后按 taskId 查询状态并显示生命周期", async () => {
    const spy = stubFetch({
      ok: true,
      data: { taskId: "task-77", state: "running", result: null, failureCode: null },
    });
    await queueValidation();

    await waitFor(() => expect(screen.getByText("执行中")).toBeTruthy());
    expect(screen.getByText("task-77")).toBeTruthy();
    expect(String(spy.mock.calls[0][0])).toBe(
      "/api/admin/credential-tasks/status?taskId=task-77",
    );
  });

  it("task missing 是独立分支：清掉面板，用前端自己的文案，不解析服务端文本", async () => {
    stubFetch({
      ok: true,
      data: { taskId: "task-77", state: "queued", result: null, failureCode: null },
    });
    await queueValidation();
    await waitFor(() => expect(screen.getByText("排队中")).toBeTruthy());

    // 后端把这条 task 判为不可查询：404 + 稳定 code，没有 message。
    stubFetch({ ok: false, status: 404, code: "credential_task_not_found" }, 404);
    await click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => expect(screen.queryByText("task-77")).toBeNull());
    expect(screen.queryByText("排队中")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("任务不存在或不可查询");
  });

  it("同为查询失败，非 404 的 code 保留面板——只有 task missing 才清", async () => {
    stubFetch({
      ok: true,
      data: { taskId: "task-77", state: "queued", result: null, failureCode: null },
    });
    await queueValidation();
    await waitFor(() => expect(screen.getByText("排队中")).toBeTruthy());

    stubFetch({ ok: false, status: 429, code: "admin_rate_limited" }, 429);
    await click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("操作过于频繁"),
    );
    expect(screen.getByText("task-77")).toBeTruthy();
  });
});

describe("能力位驱动的可见性与失败文案", () => {
  it("缺 credential:manage 时写入口全部消失，并说明缺的是哪个能力位", () => {
    renderPage({ credentialManage: "denied" });

    expect(screen.queryByRole("button", { name: "新增渠道账号" })).toBeNull();
    expect(screen.queryByRole("button", { name: "停用账户" })).toBeNull();
    expect(screen.queryByRole("button", { name: "验证" })).toBeNull();
    expect(screen.queryByPlaceholderText("粘贴新 JWT")).toBeNull();

    const notice = screen.getByText(/缺少能力位/);
    expect(notice.textContent).toContain("credential:manage");
    expect(notice.textContent).toContain("凭证管理");
  });

  it("待完成 2FA 与未授予是两种说法，运营据此知道该做什么", () => {
    renderPage({ credentialManage: "two_factor_required" });
    const notice = screen.getByText(/双重验证/);
    expect(notice.textContent).toContain("credential:manage");
    expect(screen.queryByRole("button", { name: "新增渠道账号" })).toBeNull();
  });

  it("失败提示由 envelope 的 code 生成，服务端没有可读文本可抄", async () => {
    // errorEnvelopeCopy 的映射表本身在 admin-secret-boundary.test.tsx 里逐条验过；
    // 这里验的是接线：组件确实把 envelope 交给了它，而不是显示了别的东西。
    actions.setChannelAccountStatusAction.mockResolvedValue({
      ok: false,
      envelope: {
        ok: false,
        status: 403,
        code: "admin_capability_denied",
        details: { capability: "credential:manage" },
      },
    });
    renderPage();
    const reasonInput = within(rowOf("待启用账户")).getByPlaceholderText("启用原因");
    await type(reasonInput, "恢复");
    await submitForm(reasonInput);

    await waitFor(() => {
      const status = screen.getByRole("status");
      expect(status.textContent).toContain("启用账户失败");
      expect(status.textContent).toContain("缺少能力位 凭证管理（credential:manage）");
    });
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("成功才刷新数据，失败不刷——否则失败后表格闪一下更迷惑", async () => {
    renderPage();
    await click(within(rowOf("有效账户")).getByRole("button", { name: "验证" }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });
});
