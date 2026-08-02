# 海外阅读 P1 · 后台 UI 复刻清单

> 原则：**尽可能保持 CPS 的菜单、字段与安全交互。** 运营的肌肉记忆是资产，不要为"更好看"重排。
> 后台**保持浅色**（CPS 现状），深色只用于用户端前台——见 `P1_DARK_DESIGN_BRIEF.md`。
> CPS 只读参照：`d77c3b9`（v8.1.1）。全部 `文件:行号` 本轮实读。

---

## 1. 菜单树（对照 CPS `sidebar.tsx:39-72`）

```
仪表盘              /dashboard
书目管理            /novels                    ← CPS 剧集管理 /dramas
目录同步            /catalog-sync              ← CPS 数据同步 /sync
推广链接            /promo-links               ← 合并 CPS 推广链接 + 畅读链接
试读管理            /previews                  ← ORIGINAL（CPS 无对应物）
首页轮播            /home-carousel
模板管理            /templates
文章管理            /articles
分类管理            /categories
标签管理            /tags
任务中心            /tasks
数据看板            /revenue                   ← 占位，子项待 P4
站点设置            /settings
渠道账户            /channel-accounts
API 配置            /settings/api-config
账号安全            /settings/security
```

**不建的 CPS 菜单项**：批量导入（表格通道已废弃）、分类规则（Post-V1）、畅读链接（并入推广链接）。

### 菜单实现细节（照搬）

| 细节 | CPS 证据 | 处理 |
| --- | --- | --- |
| `NAV_ITEMS` 常量数组 + lucide 图标 | `sidebar.tsx:39-72` | 照搬结构 |
| 子菜单折叠 + 活跃组自动展开 | `:89-98` | 照搬 |
| 侧栏折叠（15rem ↔ 4rem） | `:110-113` | 照搬 |
| 顶部显示版本号（低调灰、非品牌名） | `:116-129` | 照搬——CPS v6.1.0 品牌隐私收口的做法 |
| flag 驱动的菜单可见性 | `:76-79,133,169-170` | 照搬；北斗相关项**可见但禁用** |
| 活跃态 `bg-blue-50 text-blue-700` | `:148-151` | 照搬配色 |

---

## 2. 路由保护（`proxy.ts:21-37`）

CPS `PROTECTED_PREFIXES` 16 项。海外阅读清单：

```
/dashboard  /novels  /catalog-sync  /promo-links  /previews
/home-carousel  /templates  /articles  /categories  /tags
/tasks  /revenue  /settings  /channel-accounts
```

🔴 **两条强化（CPS 现状是缺陷，`ORIGINAL_REQUIRED`）**：
1. **默认拒绝**——新增 admin 路由不显式登记即不可访问（CPS 是"靠每个 route 自觉调 `requireAdminSession()`"，立项书 §9.4 明列不要继承）；
2. **proxy 层禁止查库**——CPS `proxy.ts:80-136` 每次公开详情页打 1–2 次库，改由页面层 `notFound()` / `gone()`。

---

## 3. 逐页复刻清单

### 3.1 书目管理 `/novels`（对照 `/dramas`）

| 项 | CPS 形态 | 海外阅读 |
| --- | --- | --- |
| 列表列 | 复选/剧集/平台/题材/分类/分类状态/集数/状态/上次推广抓取/创建时间/操作（`dramas-list-client.tsx:200-223`） | 复选/**书名**/来源应用/**语种**/题材标签/**分成比例**/**章数**/**收费起始章**/状态/上次同步/创建时间/操作 |
| 表头样式 | `border-b border-gray-200 bg-gray-50`，列名 `text-gray-500` | 照搬 |
| 全选复选框 | 有 | 照搬 |
| 子页 | `[id]/edit`、`new` | 照搬（`new` = 应急人工录入） |
| 分成比例列 | — | 🔴 **只作运营筛选/排序维度，不是准入门槛**（`ACCEPT_CHANNEL_CONTENT`） |

**新增筛选**：来源应用、语种、状态、有无推广资源、分成比例区间。

### 3.2 目录同步 `/catalog-sync`（对照 `/sync`）

发起表单（对应 `CatalogScanTask`）：

| 字段 | 约束 |
| --- | --- |
| 渠道账户 | 必选 |
| 来源应用 | 必选（MoboReader / PlotNovel） |
| `projectType` | 从 ChannelApp 配置带出，**只读展示** |
| 页区间起 / 止 | 🔴 **必填**，拒绝"同步全部" |
| pageSize | 有上限（参照 CPS 的 100） |
| 模式 | `dry_run` / `apply`，**默认 dry_run** |
| canary | 可选，强制只处理第 1 页第 1 条 |

🔴 **拒绝输入必须给明确文案**（CPS 的"只支持显式勾选剧目，不支持当前筛选全量领取"是事故后加的，照搬这个做法）：
- 不填区间 → "必须指定页码区间，不支持全量同步"
- 区间超上限 → 提示上限值
- **同账户 × 应用 × projectType 已有 active scan** → "该渠道目录扫描进行中，请等待完成"

### 3.3 试读管理 `/previews` 🆕 `ORIGINAL_REQUIRED`

**CPS 无对应物**（只有 `Drama.episodeCount` 标量；`DramaPreviewAsset` 是视频语义、行数被 `freeEpisodeCount` 卡死，形状不可参照）。

| 区块 | 内容 |
| --- | --- |
| 章节列表 | 章号 / 标题 / 字符数 / hash 前缀 / 状态（`preview`/`stale`/`withdrawn`）/ 最近出现时间 |
| 状态徽标 | `stale` 需醒目——它表示"已停止展示但正文仍在" |
| 操作 | 重新拉取（单本）、查看正文（**需能力位**）、人工撤回（**二次确认 + 能力位**） |
| 异常队列入口 | 超长正文、结构异常、物化失败 |

🔴 **正文查看是敏感操作**：需能力位，且**查看行为本身写审计**。

### 3.4 推广链接 `/promo-links`

| 列 | 说明 |
| --- | --- |
| 书名 / 语种 / 来源应用 | — |
| **公开短码** | `public_redirect_code`，可复制（复用 `copy-value-button.tsx`） |
| **渠道真实码** | `upstream_code`，**掩码显示 + 能力位展开** |
| 落地 URL | 掩码 host + 能力位展开 |
| 来源 | `origin`：`upstream_existing` / `claimed` |
| 状态 | `pending` / `fetched` / `failed` |
| 获取时间 | — |
| 操作 | 重新读取；**生成推广资源（P3，禁用态）** |

🔴 **公开短码与渠道真实码必须在 UI 上视觉可区分**，避免运营复制错。公开短码是给外部用的，真实码是内部凭据。

### 3.5 任务中心 `/tasks`

| 项 | CPS 形态 | 处理 |
| --- | --- | --- |
| 列表 6 列 | `tasks/page.tsx:54-71` | 照搬 |
| 详情页 | `tasks/[id]/page.tsx`，两级任务 + item 明细 | 照搬 |
| 自动刷新 | `task-auto-refresh.tsx` | 照搬 |
| 控制按钮 | `task-control-buttons.tsx` | 照搬 |
| 重试失败项 | `retry-failed-promo-button.tsx` | 照搬（换小说语义） |
| 排序 | active 优先，再按归一化 `created_at DESC`（CPS v5.2.5 修过混合存储排序 bug） | 照搬 |

**item 明细必须展示**：状态、attempt 次数、失败原因码、租约持有者、`claim_retry_blocked` 标记。

### 3.6 文章管理 `/articles`

| 子页 | CPS | 处理 |
| --- | --- | --- |
| 列表 | `articles/page.tsx` | 照搬 |
| 编辑 | `[id]/edit` | 照搬 |
| 单条生成 | `generate` | 照搬 |
| **批量生成** | `batch-generate` + `batch-wizard.tsx` **三步向导**（筛选 → 预览 → 结果，`:182,665,699`） | 🔴 **整体照搬**——已验证的批量交互 |
| 换租客批量切换 | `batch-drama-switch` | **不建**（CPS 特有历史包袱） |
| Blog | `new-blog` | **不建**（V1 无 blog） |

🔴 **`publishType` 默认 `draft`**（`batch-wizard.tsx:212`）——默认保守、显式放开，照搬。

### 3.7 渠道账户 `/channel-accounts`

CPS 六个操作（`channel-accounts/actions.ts`）**整体照搬**：

| 操作 | CPS 函数 | 能力位 |
| --- | --- | --- |
| 列表 | `getChannelAccounts` | 读 |
| 新建 | `createChannelAccount` | 🔴 `credential:manage` |
| 更新凭证 | `updateChannelAccountJwt` | 🔴 `credential:manage` |
| 校验凭证 | `validateChannelAccountJwt` | 🔴 `credential:manage` |
| 停用 | `disableChannelAccount` | 🔴 `credential:manage` |
| 启用 | `enableChannelAccount` | 🔴 `credential:manage` |
| 作废旧凭证 | `supersedeChannelAccountCredential` | 🔴 `credential:manage` |

**Server Action 双层**（业务函数 + `*FromForm` 包装，`:211-278`）照搬——干净的表单边界。

**安全交互（逐条照搬）**：
- 每个写操作首行 `requireAdminCapability(session, 'credential:manage')`（`:54`）；
- 凭证**只写不读**：UI 永不回显密文，只显示指纹前缀、过期时间、状态；
- 校验走 `validateJwtLocally`，**不调渠道接口**；
- `jwt_missing` / `jwt_expired` **二分显示**（运维动作不同）；
- 换证在事务内：旧证 superseded + 新证 active + ChangeLog；
- 指纹冲突由 DB 唯一约束兜底，UI 显示"该凭证已被其他账户使用"。

**多渠道支持**：账户列表带渠道列；**北斗选项可见但禁用**，hover 显示"接口未调研，二期开启"。

### 3.8 API 配置 `/settings/api-config`

CPS 现状：北斗配置 + 飞书配置，各带**二次确认弹窗**（`:374`、`:562`）。

| 项 | 处理 |
| --- | --- |
| 飞书区块 | **不建**（已冻结） |
| 北斗区块 | **占位可见、禁用**，说明"接口未调研，二期开启" |
| 小说渠道区块 | 新建（畅读/MoboReader 参数） |
| 清除配置的二次确认弹窗 | 🔴 **照搬**——破坏性操作必须二次确认 |

### 3.9 站点设置 `/settings`

| 卡片 | CPS | 处理 |
| --- | --- | --- |
| Sitemap 管理 | `sitemap-card.tsx` + `sitemap-actions.ts`（`getSitemapRefreshState` / `refreshSitemap`） | 照搬：手动生成、状态展示、失败保留 last known good |
| 页面身份状态 | `page-identity-v2-status-card.tsx` | 照搬形态（换公开短码覆盖率） |
| 站点基础设置 | `settings-form.tsx` | 照搬 |
| **IndexNow 卡片** | CPS 无独立卡片 | 🆕 新增：outbox 状态、投递结果、手动重推 |

### 3.10 账号安全 `/settings/security`

CPS：TOTP + 恢复码（`security/page.tsx:12-14`）。**整体照搬**——14 文件闭包、1,920 行、仅触达 4 个 model，是最干净的可搬资产。

### 3.11 数据看板 `/revenue`（占位）

V1 **只建占位页**：明确写"待接口归因维度确认（`PENDING_R3`）"，**不展示任何假数据**。CPS 的 8 个子项（收益总览/订单明细/剧集收益/推广码收益/漏斗/畅读收入/畅读总体收入/同步日志）在 P4 解冻后按需建。

### 3.12 首页轮播 `/home-carousel`

复用 CPS 五表形态（`schema.prisma:740-843`：`manual_slot` / `auto_batch` / `auto_candidate` / `serving` / `change_log`）与"人工位 + 自动打分 + 合并"三段语义。

🔴 **搬运警告**：`home-carousel-config.ts:101` 含 `AS camelCase` 别名，**PG 下静默折叠会让轮播回落默认配置且不报错**。必须改 Prisma 查询。

---

## 4. 全局安全交互（逐条照搬）

| # | 交互 | CPS 证据 | 说明 |
| ---: | --- | --- | --- |
| 1 | 破坏性操作二次确认弹窗 | `api-config/page.tsx:374,562` | 清除配置、人工撤回、批量下架 |
| 2 | 双闸提示 | flag 关闭时按钮禁用 + 显示原因 | 不让用户点了才报错 |
| 3 | dry-run 优先 | `batch-wizard` 三步式；apply 缺省 false | 默认安全 |
| 4 | 显式勾选 | 拒绝"按当前筛选全量" | 批量误操作防线 |
| 5 | 敏感值掩码 + 能力位展开 | 审计侧 `[redacted_code:length=N]` | 推广真实码、凭证指纹 |
| 6 | 复制按钮 | `copy-value-button.tsx` | 减少手抄错误 |
| 7 | 能力不足的错误文案 | `ADMIN_FORBIDDEN_MESSAGE = "无 credential:manage 权限"` | 明确说缺哪个能力 |
| 8 | 任务自动刷新 | `task-auto-refresh.tsx` | 长任务无需手动刷 |
| 9 | 失败项可重试 | `retry-failed-promo-button.tsx` | 只重试失败项，不重跑整批 |
| 10 | 版本号低调展示 | `sidebar.tsx:119-127` | 品牌隐私（CPS v6.1.0） |

---

## 5. 视觉风格

**后台保持 CPS 现状**：浅色（`--background: #f9fafb`、`--foreground: #111827`）、蓝色活跃态（`bg-blue-50 text-blue-700`）、`gray-*` 中性色阶、lucide 图标、Tailwind + `@tailwindcss/typography`。

**不做的**：后台深色模式、后台品牌化改造、组件库替换。

**理由**：后台是内部工具，运营的肌肉记忆比视觉新鲜感重要；深色投入应该全部给用户端。

---

## 6. 北斗占位的后台形态

> Owner 2026-08-02：北斗接口未调研，表与流程先参照 CPS 短剧占位（含系统后台），二期开启。

| 位置 | 形态 |
| --- | --- |
| 渠道账户 | 渠道下拉含"北斗"，**可选但保存时提示未启用**；或直接禁用并 hover 说明 |
| API 配置 | 北斗区块可见、输入框禁用、标注"接口未调研，二期开启" |
| 目录同步 | 渠道选择中北斗**禁用** |
| 任务中心 | 北斗任务类型**注册但不在 allowlist**（worker 不消费） |
| 菜单 | 不为北斗单独加菜单项——复用同一批页面的渠道维度 |

🔴 **占位纪律**：结构预留 + 显式禁用 ≠ 可以凭 CPS 短剧协议猜写北斗请求体。北斗的 Endpoint / Body / 幂等规则一律 `UNPROVEN`，与 `claimPromo` 同口径。

---

## 7. P1 阶段实际要建的后台

P1 只到"地基"，页面在 P2。**P1 需要落地的后台部分**：

| 项 | 属于 P1 |
| --- | --- |
| 鉴权 / 2FA / 会话超时 | ✅ P1-05 |
| 能力位框架 | ✅ P1-05 |
| 路由保护清单 + 默认拒绝 | ✅ P1-05 |
| Feature Flag 双闸框架 | ✅ P1-06 |
| 渠道账户页（含凭证六操作） | ✅ P1-10 |
| 侧栏骨架 + 菜单常量 | ✅ 随 P1-05 |
| 任务中心页面 | ⏭ P2（P1 只建表与 worker） |
| 其余业务页面 | ⏭ P2 |

---

## 8. 复刻完整性自检

Codex 交付后应能回答：

1. 菜单项与 CPS 的对应关系是否逐项可查（含"为什么不建"）？
2. `PROTECTED_PREFIXES` 是否覆盖全部 admin 路由，未登记路由是否真的 404？
3. 六个凭证操作是否都有 `credential:manage` 门控？
4. 凭证 UI 是否**从不回显密文**？
5. 破坏性操作是否都有二次确认？
6. 批量入口是否默认 `draft` / `dry_run`？
7. 推广真实码是否掩码，公开短码是否可直接复制？
8. 轮播的 `AS camelCase` 别名是否已改 Prisma 查询？
9. 北斗占位是否只有"结构 + 禁用"，没有猜写的协议代码？
10. 每个搬入符号是否登记进 `docs/governance/port-registry.md`？
