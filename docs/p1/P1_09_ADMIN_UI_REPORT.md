# P1-09 · 后台框架、菜单、字段与 CPS UI 复刻

**主责：Claude ｜ Reviewer：Codex（复核权限与 API 使用）**

**分支：`feature/v0.1.0-p1-09-admin-ui`**

**基线 main：`93537a054566405ca3b653038e383e112072b023`**

**CPS 只读参照：`d77c3b9`（v8.1.1），全程未改动**

---

## 1. 本轮交付

垂直切片：后台壳 + 基元 + 渠道账户页 + 读接口，真实消费已完成的 `src/contracts`、
Admin registry、Auth guards 与 Credential 后端服务。**未自行发明任何 Auth / Credential DTO。**

| 交付物 | 位置 |
| --- | --- |
| ① 后台布局 + 侧栏 + 菜单常量 | `src/app/(admin)/layout.tsx`、`_components/admin-shell.tsx`、`src/features/admin-ui/{nav-items,sidebar,icons}` |
| ② 浅色主题（沿用 CPS 视觉） | shell 自带浅色面，不改 `--novel-*` |
| ③ 渠道账户页（消费六操作） | `src/app/(admin)/channel-accounts/**` |
| ④ 通用列表 / 表单 / 弹窗基元 | `src/components/ui/{button,table,status-badge,confirm-dialog,copy-button}` |
| ⑤ 权限驱动的菜单可见性 | `sidebar.tsx` + `capability-view.ts` |
| ⑥ 敏感值掩码 + 能力位交互 | 全链路只出 `fingerprintPrefix`；三态能力位 |

六个操作的接入方式：

| 操作 | 入口 | 返回 |
| --- | --- | --- |
| create account | Server Action `admin.channel_account.create` | `ChannelAccountView` |
| disable / enable account | Server Action `admin.channel_account.disable|enable` | `ChannelAccountView` |
| add/replace credential | Server Action `admin.credential.replace` | `CredentialMetadataView`（同步） |
| validate / supersede | Server Action `admin.credential.validate|supersede` | `CredentialQueuedResultView`（异步） |
| 列表 / 元数据 / 任务状态 | Route Handler `GET /api/admin/**` ×3 | 对应 View |

---

## 2. 两个必须记录的发现

### 2.1 目录所有权文档自相矛盾（已按裁决更正）

`P1_MODULE_OWNERSHIP.md` 原把 `src/app/(admin)/**` 与 `src/app/api/**` 记为 Codex，
与 `P1_IMPLEMENTATION_ASSIGNMENT.md` §P1-09（主责 Claude，唯一写入目录含 `src/app/`）冲突。

裁决依据是分工表自身第 8 行：**「本文件是正式分工与目录所有权的唯一真源，
与 `P1_MODULE_OWNERSHIP.md` 冲突时以本文件为准」**。已据此更正 `P1_MODULE_OWNERSHIP.md`
§1 两行 + §7 速查表，并在 §1 留修订说明。`src/server/**` 仍归 Codex。

### 2.2 🔴 Route Handler 无法承载 Credential mutation（架构级，影响 P1-12）

`requireFreshAdminServiceMutation` 对 `entryId` 做**精确字符串比对**：

```ts
if (!authorization || authorization.entryId !== input.entryId || ...) throw ...
```

而两条入口发出的 entryId 命名空间不同：

| 入口 | 签发的 entryId |
| --- | --- |
| `requireAdminRouteAccess` | Route id，如 `admin.api.channel_account.disable` |
| `requireAdminActionAccess` | Action id，如 `admin.channel_account.disable` |

后端服务的入参类型只接受 **Action id**：

- `setChannelAccountStatus` — `entryId: "admin.channel_account.disable" | "admin.channel_account.enable"`
- `enqueueCredentialOperation` — `entryId: "admin.credential.validate" | "admin.credential.supersede"`
- `createChannelAccount` — 内部硬编码 `"admin.channel_account.create"`

唯一例外是 `addOrReplaceCredential`，它显式接受两种命名空间。

**因此把这些写操作放进 Route Handler 会在每次 mutation 上 403（binding mismatch）。**
本轮据此把 mutation 全部落为 Server Action，只把无 entry 绑定的读操作留在
`/api/admin/**`。registry 中另外 5 条 POST route 目前**没有 handler**，处于「已登记但未实现」
状态；这不是遗漏，是与后端契约一致的结果。

给 Codex 的选择题（P1-12 前需定）：
1. 维持现状 —— mutation 只走 Server Action，registry 里那 5 条 POST route 应删除或标注为保留；
2. 或放宽三个 service 的 `entryId` 入参，同 `addOrReplaceCredential` 一样接受两种命名空间。

---

## 3. CPS parity 分类

| 项 | 分类 | 证据 |
| --- | --- | --- |
| 菜单常量数组形态、16 项顺序与文案 | `CPS_PARITY` | `sidebar.tsx:39-72` |
| 子菜单折叠 + 活跃组自动展开 | `CPS_PARITY` | `:89-98` |
| 侧栏折叠（15rem ↔ 4rem） | `CPS_PARITY` | `:110-113`（本实现 `w-60` ↔ `w-16`） |
| 版本号低调灰、非品牌名 | `CPS_PARITY` | `:116-129` |
| 活跃态 `bg-blue-50 text-blue-700` | `CPS_PARITY` | `:148-151` |
| 表头 `border-b border-gray-200 bg-gray-50` + `text-gray-500` | `CPS_PARITY` | `dramas-list-client.tsx:200-223` |
| 二次确认弹窗、复制按钮 | `CPS_PARITY` | `copy-value-button.tsx` |
| 渠道账户列字段 | `CPS_PARITY_ADAPTED` | 去掉 CPS 的 `jwtStatus` 第二维，改用契约四态 |
| 图标 | **`ORIGINAL_REQUIRED`** | CPS 用 `lucide-react`，本项目无该依赖且 P1-09 无权新增；改为同网格内联 SVG |
| 能力位三态（含 `two_factor_required`） | **`ORIGINAL_REQUIRED`** | CPS 只有 `hasAdminCapability` 布尔 |
| 默认拒绝的页面登记 | **`ORIGINAL_REQUIRED`** | 立项书 §9.4 明列不继承 CPS「靠每个 route 自觉」 |

---

## 4. 验收标准逐条证据

| # | 标准 | 证据 |
| --- | --- | --- |
| ① | 菜单与 §1 逐项一致（含「为什么不建」） | `tests/ui/admin-nav-parity.test.tsx` 冻结 14 个顶级项顺序 + 2 个子项；`OMITTED_CPS_NAV_ITEMS` 记录三项落选原因并被测试要求非空 |
| ② | 凭证 UI **从不回显密文** | `tests/ui/admin-secret-boundary.test.tsx` 递归扫 `src/app/(admin)`、`src/features/admin-ui`、`src/components/ui`，禁 `encryptedSecret` / `secret_fingerprint` / `keyVersion` / `tokenHash` / `passwordHash` / `sessionVersion` / `codeHash`；并断言 `fingerprint` 只以 `fingerprintPrefix` 形式出现 |
| ③ | 破坏性操作有二次确认 | 停用账户、作废凭证走 `ConfirmDialog`，且原因必填后才允许提交 |
| ④ | 批量入口默认 draft / dry_run | 本轮无批量页，N/A |
| ⑤ | 公开短码可复制、渠道真实码掩码 | 本轮无推广页；`CopyButton` 已就位，当前只喂 `fingerprintPrefix` |
| ⑥ | 权限不足文案指出缺哪个能力 | `capabilityBlockReason` 输出「缺少能力位 凭证管理（credential:manage）」；`two_factor_required` 单独文案。测试断言 title 同时含中文名与能力位标识 |
| ⑦ | Codex 签字 | **待办** |

补充：默认拒绝由 `requireAdminPage(pathname)` 承载，`admin-nav-parity.test.ts` 强制
`(admin)` 下每个 `page.tsx` 都调用它、路径在 `ADMIN_PAGE_ROOTS` 内、**且声明路径与文件实际位置一致**
（防止页面守错路由）。

---

## 5. 安全边界落地方式

- **页面只 AuthN**：`requireAdminPage` 只做会话校验；授权在 Route Handler / Action，
  并由 mutation service 的 `requireFreshAdminServiceMutation` 二次重读会话再校验。
- **错误文案全由前端拥有**：`error-copy.ts` 按稳定 code 出文案，
  测试断言 admin UI 全域不出现 `error.message` / `envelope.message`。
- **`idle_timeout` / `absolute_timeout` / `idempotency_conflict`** 三个 reason 有独立文案，
  否则运营无法区分「重登即可」与「已到 24h 上限」。
- **JWT 输入框 `type="password"` + `autoComplete="off"`**，明文不进浏览器自动填充历史。
- **每次 mutation 生成新的 `x-request-id`**：requestId 是幂等键，跨不同提交复用会被后端
  以 409 `idempotency_conflict` 拒绝，前端因此按提交生成而非按表单生成。

---

## 6. 门禁

```
npm run build      PASS
npm run typecheck  PASS
npm run lint       PASS
npm run test:backend  143/143 (21 files)
npm test           173 passed | 55 skipped (0 failed)
```

55 skipped 全为 PostgreSQL 集成套件（本地无实例），本轮未改 DB / migration / grants。

---

## 7. 移交 Codex 的待办

1. **§2.2 的架构选择题**（阻断 P1-12 前必须定）。
2. `getCredentialTaskResult` 在任务不存在时抛 `new Error("credential_missing")` —— 裸 `Error`，
   没有 `code`，被 `toErrorEnvelope` 兜底成通用 403。建议改抛 `CredentialLifecycleError`，
   前端即可显示「未找到对应凭证」。
3. registry 的 5 条无 handler 的 POST route 如何处置（删除 / 保留 / 补 handler）。
4. `ADMIN_CANONICAL_ORIGIN` 需要在生产配置：未配置时 `canonicalOrigin()` 在生产返回空串，
   所有 mutation 会被 `requireSameOrigin` 拒绝（fail-closed，符合预期但需运维知晓）。
