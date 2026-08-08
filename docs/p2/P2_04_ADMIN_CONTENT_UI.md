# P2-04 · 后台内容管理 UI 与 HTTP 读取面

本轮只做**只读纵切**：书目列表 → 书目详情 → 章节列表 → 章节正文查看。
不实现任何 mutation，也不为将来的 mutation 预留控件。

- 后端基线：`feature/p2-04-admin-content-backend` @ `526a401`（Codex 冻结，未改动）
- 本轮分支：`feature/p2-04-admin-content-ui`

---

## 1. 分层

```
页面 (src/app/(admin)/novels/**)      ──┐
                                        ├─→ src/server/admin-content（Codex 冻结）
Route (src/app/api/admin/novels/**)  ──┘        ↓
                                        src/contracts/admin-content.ts（投影）
```

页面直接调 service 而不是 fetch 自己的 HTTP 路由：Server Component 打自己的 origin
会多一次往返、多一次 cookie 传递、多一种失败模式，收益为零。两条入口共用同一个
service 与同一组 `project*`，所以不会各自漂出一套字段。

章节正文是唯一例外——它**只**走 HTTP，由浏览器显式点击触发（见 §4）。

## 2. 契约（`src/contracts/admin-content.ts`）

投影函数的**入参是 kernel 的 domain 类型**，因此 kernel 改形状会直接编译失败，
契约不可能悄悄漂移。契约做的事是**减法**，逐字段构造、不 spread：

| 丢弃字段 | 原因 |
| --- | --- |
| `author` / `completionStatus` / `country` / `region` | 只存在于上游官网，分销接口不提供，非本期设计输入 |
| `coverUrl` | 需要图片 host 白名单决策，不在 P2-04 范围 |
| `paidFromChapter` / `splitRatio` | 商业字段，与内容管理无关；`splitRatio` 全站禁渲染 |
| `contentHash` | 只给 12 位前缀，够肉眼比对，不够当键用 |

新增错误码与状态（`src/contracts/errors.ts`，Claude 为 custodian）：

- `AdminContentQueryErrorCode` 以 `import type` 引自 kernel，浏览器分支表不会与
  kernel 实际抛出的码脱节；
- 新增 `admin_content_not_found`（合法 UUID 但无存活行，404）；
- `AdminErrorStatus` 新增 `400`。凭证路由只收一个不透明 id，产生不了「入参非法」
  这一类；内容路由从 query string 收 page/pageSize/status/locale/search，被拒的
  `page=0` 既不是「无权」也不是「不存在」。

## 3. 路由与登记

| id | path | 能力位 |
| --- | --- | --- |
| `admin.api.novel.list` | `/api/admin/novels` | `content:view` |
| `admin.api.novel.detail` | `/api/admin/novels/detail` | `content:view` |
| `admin.api.novel_chapter.list` | `/api/admin/novels/chapters` | `content:view` |
| `admin.api.novel_chapter.content` | `/api/admin/novels/chapters/content` | `content:read` |

**路径为什么是扁平的**：`resolveAdminRoute` 做整串 pathname 比对，没有动态段匹配器。
登记 `/api/admin/novels/[novelId]` 会永远匹配不上真实请求，即每次调用都 404。
标识改走 query 参数——`/api/admin/credentials/metadata` 的 `channelAccountId`
已经是这个做法。

登记表在 `src/app/api/admin/_lib/registry.ts`：`P1_08B_ADMIN_REGISTRY` 原样保留、
P2-04 在其上组合，凭证面仍然单一 owner。

## 4. 权限

| 面 | 要求 |
| --- | --- |
| 书目/章节元数据 | 有效 Admin Session + `content:view`，**不要求 2FA** |
| 章节正文 | 有效 Admin Session + `content:read`，**不要求 2FA**，每次读取后端写一条 `operation_audit` |

正文在 UI 上必须**点击**才请求：挂载即取会让每次导航都要求更强的能力位，也会把审计
写成「页面被打开过」而不是「有人选择读了它」。

### 🔴 Owner 裁决（2026-08-08）：能力位保留，内核改动交 Codex

Codex 复核给出 `AUTH_SINGLE_SOURCE=FAIL`，要求删除 `content:view` / `content:read`
改为「有效 Admin Session 即可」。该项与任务书 §6 冻结的「章节正文：必须
`content:read`」冲突，已提请 Owner 裁决。**裁决结果：能力位保留**，内核收编由 Codex
执行。

Codex 的诊断分两条，本轮处理如下：

| 诊断 | 状态 |
| --- | --- |
| route→capability 绑定仅由源码扫描测试关联，运行时 registry 不持有 | ✅ 本轮已修 |
| `content-capabilities.ts` 重复实现 roles/userIds/env/default-deny | ⏳ 需 Codex 内核改动 |

**已修部分**：能力位现在挂在 registration 上（`ADMIN_CONTENT_ROUTES[].readCapability`），
`guardContentRead(request)` **不再接受能力位参数**——它用内核的 `resolveAdminRoute`
匹配出本次路由，再从 registry 取绑定。于是 handler 没有参数可传，也就没有传错的可能；
未登记为内容路由的请求取不到能力位，直接 404 而不是借用别人的授权。
`CONTENT_ROUTE_CAPABILITIES` 改为从 registration 派生，不再是手写的第二份副本。

**待 Codex 执行的内核收编**（三处，全在 Codex 目录）：

1. `src/lib/auth/capabilities.ts`：`CapabilityConfig.requiresTwoFactor` 由字面量
   `true` 放宽为 `boolean`；
2. 同文件：`AdminCapability` 增加 `content:view` / `content:read`，
   `ADMIN_CAPABILITY_CONFIG` 补两条（`CONTENT_VIEW_*` / `CONTENT_READ_*`，
   `defaultRoles: []`，`requiresTwoFactor: false`）；
3. `src/server/auth/guards.ts`：`enforceCapability` 改为尊重
   `ADMIN_CAPABILITY_CONFIG[capability].requiresTwoFactor`，而不是无条件调
   `requireAdminTwoFactor`。

收编完成后，Claude 侧删除 `_lib/content-capabilities.ts`，内容路由的
`readCapability` 直接填进 registration 的 `capability` 字段，`guardContentRead`
退化为 `guardRead`。届时授权源恢复为单一真源，且读仍不要求 2FA。

⚠️ 第 3 条是内核语义变更，会影响所有既有路由的判定路径，因此必须由 Codex 做并自行
回归 P1-08B 凭证面——这也是本轮不代做的原因。

### 🔴 交给 Codex 的一处后端约束（未改代码，仅报告）

`src/server/auth/guards.ts` 的 `enforceCapability` 在看到 `route.capability` 时
无条件调用 `requireAdminTwoFactor`；`src/lib/auth/capabilities.ts` 的
`CapabilityConfig.requiresTwoFactor` 也被硬编码为字面量 `true`。对现存四个能力位
（都守写入或密钥）这是对的，但它使得**「要能力位、但不要 2FA」在 `AdminCapability`
体系内无法表达**。

本轮的选择是不动 Codex 内核：读能力位定义在 Claude 侧的
`src/app/api/admin/_lib/content-capabilities.ts`，沿用同样的 `*_ROLES` /
`*_USER_IDS` env allowlist 与默认拒绝，只是不耦合 2FA；内容路由在登记表里**刻意
不填 `capability`**，改由 `guardContentRead` 在 Route 层强制。

为避免退化成「谁记得检查谁检查」，route→能力位的绑定以数据形式登记在
`CONTENT_ROUTE_CAPABILITIES`，并由 `tests/ui/admin-content-registry.test.ts` 同时断言：
磁盘上的 route 全部登记、登记表无 orphan、每个 route 源码真的调用了它被绑定的那个
能力位。

若 Codex 认为读能力位应当收编进 `AdminCapability`，需要一并调整 `CapabilityConfig`
的类型与 `enforceCapability` 的分支——那是内核改动，属于 Codex 的决定，本轮不代做。

### 🔴 边界：不得波及公开阅读链路（Owner 裁决 2026-08-08）

P2-04 的 Admin Session、`content:view`、`content:read` **只适用于管理员后台与
`/api/admin/*` 内容读取链路**，绝不扩散到公开阅读链路。站点没有面向读者的登录体系，
公开试读章节必须支持匿名游客直读。本轮不得新增、也不得为将来铺路：

- 用户登录要求 / public reader authentication；
- `content:read` 对公开 Route 的校验；
- 未登录跳登录；
- 任何降低公开试读转化的访问门槛。

公开 Route 是否允许返回某章节，由「该内容是否属于允许公开/试读范围」的
public-content contract 决定，**不由 Admin capability 决定**。P2-04 不改变任何
public reading contract。

这条边界由 `tests/ui/public-reading-no-auth.test.ts` 强制：`src/app` 中非后台文件
与 `src/features/public-ui/**` 一旦引用任何后台权限设施即失败。公开屏幕上不出现
「登录 / 注册 / 会员」文案另由 `tests/ui/forbidden-fields.test.tsx` 覆盖。

之所以现在就下闸：公开阅读 Route 尚未落地，等它落地时顺手 import 一个
`requireContentPage` 是最自然的动作，而后果是给匿名读者加了一道登录墙。

### 需要配置的环境变量

四项默认全空（与 `promo:claim` / `revenue:view` 一致），未配置即无人可读：

```
CONTENT_VIEW_ROLES=       CONTENT_VIEW_USER_IDS=
CONTENT_READ_ROLES=       CONTENT_READ_USER_IDS=
```

## 5. 页面

| 路由 | 内容 |
| --- | --- |
| `/novels` | 列表：筛选（search/status/locale）、分页、状态徽章、章节标量、实际落地试读数、同步与异常摘要、更新时间 |
| `/novels/[novelId]` | 详情：身份/生命周期、试读授权（策略 vs 实际）、同步与异常、上游来源 + 章节列表（分页） |
| `/novels/[novelId]/chapters/[chapterId]` | 章节元信息、上游来源、正文查看器（按需） |

页面向 `requireContentPage` 声明的是**路由模式**（`/novels/[novelId]`），不是解析后的
URL——这样 `tests/ui/admin-nav-parity.test.tsx` 能把字面量与文件实际所在目录对上，
而用 params 拼出来的路径是无法校验的。

## 6. CPS 对照

| 面 | 判定 |
| --- | --- |
| 列表表格外观、筛选栏、分页页脚、状态徽章形态、日期格式 | `CPS_PARITY` |
| 列表列本身 | `CPS_PARITY_ADAPTED`（CPS 是平台/题材/分类/集数；小说问的是落地数与同步异常） |
| 章节列表 | `CPS_PARITY_ADAPTED`（CPS 的集数是标量，没有可枚举的分集列表） |
| 正文查看器 | `ORIGINAL_REQUIRED`（CPS 的试看是视频跳转，语义不可平移） |
| 勾选列 / 批量工具条 / 编辑删除图标 | 刻意不做——本期零 mutation |

搬运登记见 `docs/governance/port-registry.md`。

## 7. 本轮改动的既有测试

两处是随功能推进必然要动的台账，不是放宽断言：

- `tests/ui/admin-sidebar-collapse.test.tsx`：`/novels` 成为真实页面，链接数 +1；
  改用 `目录同步` 作为「本期未建」的样本。
- `tests/ui/admin-nav-parity.test.tsx`：接受 `requireContentPage` 与
  `requireAdminPage` 两种守卫调用，声明路径校验规则不变。
- `tests/backend/auth/admin-registry-parity.test.ts`：该用例用文件系统扫描比对
  `src/app/api/admin` 下**所有** GET route，因此任何新增后台路由都会命中。改为与
  运行时真正使用的 `P2_04_ADMIN_REGISTRY` 比对，并新增
  `EXPECTED_CONTENT_GET_ROUTES`；P1-08B 专属断言仍旧只作用于
  `P1_08B_ADMIN_REGISTRY.routes`，凭证面的守护强度不变。
