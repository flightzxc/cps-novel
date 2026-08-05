# P2 开工输入包

> 输入基线：本地 `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668`
> P1 审计：`P1_14_FINAL_AUDIT_PASS` / `REQUIRED_FIXES=NONE`
> 文档状态：P1-15 本地输入包；尚待 GPT/Notion 更新与 Owner Gate
> 边界：本文件给出建议工作包，不创建正式任务编号

## 1. P2 目标

P2 应把 P1 已完成的技术底座与产品壳接到真实 PostgreSQL 内容和正式 SEO 发布链路：

```text
真实 Novel / Chapter / ChapterContent
→ 后台内容管理与发布门禁
→ 正式详情/章节/聚合页
→ canonical / sitemap / IndexNow
→ 可撤回、可下架、可恢复的发布闭环
```

P2 不是重做 P1 架构、Schema、页面设计、阅读器或 Worker 内核。上游渠道自动同步、主动推广
资源生成和收益归因仍受各自外部证据/后续阶段边界约束。

## 2. P1 已完成、可直接复用的基础

### 数据与任务

- PostgreSQL-only 的 37-model Prisma Schema、三条 migration、数据库字典与真实约束；
- `Novel` / `NovelChapter` / `NovelChapterContent`、发布/章节状态和正文分表；
- Web/Worker/Scheduler/migration/backup/analyst 角色与最小权限基础；
- 原子 claim、`SKIP LOCKED`、token+epoch fencing、stale recovery、Scheduler singleton；
- dry-run 零上游/零业务写入、apply 正常执行；
- backup/restore、project isolation 与 PostgreSQL 16.14 验收入口。

### 身份、凭证与后台

- Admin Auth、2FA、recovery、capability/default-deny 与 session invalidation；
- Credential 加密写入、Worker 解密消费、Web 持久化密文不可读、Scheduler 零凭证密钥；
- Admin shell、16 项导航、浅色后台风格与渠道账户纵切片；
- 六项账户/凭证操作的权限、2FA、requestId、审计与确认边界。

### 公共站与阅读器

- 深色公共站设计 token、首页、详情、章节、聚合、不可用/下架页面壳；
- D-12 已关闭：试读章节列表嵌入详情页，不建独立目录路由；
- 详情页章节只来自实际 `previewChapters`，不从总章数伪造；
- 阅读器 system/light/dark、字号/行高/页宽、localStorage、段落锚点位置恢复；
- 动态 dev-preview 章节导航、无整页刷新、返回/刷新位置恢复。

### Runtime 与可验证性

- postgres/web/worker/scheduler 四容器；不可变构建 metadata；Web loopback 暴露；
- `/api/health` 的 200/503、no-store、metadata mismatch 与 DB 故障恢复；
- P1-13：PG 71/71、Backend 185/185、UI 469/469、Full 725/725；
- P1-14 最终只读审计 PASS，无 required fix。

## 3. P2 不得重新设计的冻结边界

1. **数据库**：PostgreSQL-only；不得引入 SQLite 兼容主链。Schema/migration 变更必须走独立
   数据库变更治理，不能以 P2 页面接数为由重画 `Novel/Chapter/Content`。
2. **章节真源**：`chapterList[]` 的可信非空响应是当前试读集合；`allEpis` 只作总章数标量，
   不生成章节行、列表项或页面占位。
3. **章节缺失**：可信列表缺失立即 `stale` 并在公开面 hidden/退出 sitemap；重新出现自动恢复；
   失败/异常/异常空响应不改状态；正文不自动硬删。
4. **目录承载**：D-12 已 RESOLVED；试读章节嵌入详情页，不新建独立 catalog/chapters 路由。
5. **任务安全**：保留 `SKIP LOCKED`、exactly-once、token+epoch fencing、独立 stale recovery、
   dry-run 副作用为 0；不得用内存锁或应用层“先查后写”替代数据库原子性。
6. **locale**：`src/lib/locale/locale-canonical.ts` 是唯一 runtime 真源；只允许通过三个冻结 API
   消费；未登记值返回 `unknown`，发布白名单独立且 fail-closed。
7. **Credential/Auth**：默认拒绝、2FA/capability 双门、requestId/审计、Web 密文不可读、
   Scheduler 零 credential key 均不可放宽。
8. **公共 UI/阅读器**：复用已冻结的设计 token、页面组件和 reader state；P2 工作是接真实数据与
   正式路由，不是另做一套视觉或阅读器。
9. **构建与 Health**：镜像 baked metadata 是构建身份权威；runtime env 只能作为 mismatch claim；
   Health 不得反射未知 env 或 secret。

## 4. 尚未解决的产品/外部证据项

| 项 | 状态 | P2 影响 |
| --- | --- | --- |
| D-2 · `getlistpc` 服务端筛选 | OPEN | 不影响 P2 本地内容发布；影响未来渠道扫描效率，未证前只按页码区间设计 |
| D-7 · 首发公开语种白名单 | OPEN | 阻塞任何 locale 真正进入 publish whitelist |
| D-8 · 正式 URL locale 段 | OPEN | 阻塞正式路由、canonical、redirect 与 sitemap 形态冻结 |
| D-12 · 试读目录承载 | RESOLVED | 嵌入详情页，不建独立目录路由 |
| W6 · 品牌口径 | OPEN | 域名独立已定；品牌名/文案/视觉资产须在前台上线前定 |
| W9 · 有副作用接口首测授权 | OPEN | 不阻塞 P2；阻塞后续 `claimPromo` canary 与生成能力 |
| R3 · 收益书籍/推广码归因维度 | OPEN | 不阻塞 P2；阻塞后续归因键与收益看板 |

状态来源与详细证据见 `docs/governance/P1_CLOSEOUT_REPORT.md`。

## 5. 多语发布前置

D-7 关闭前继续保持 `UPSTREAM_LANGUAGE_REGISTRY=[]` 与 `PUBLISHABLE_LOCALES=[]`。每个拟发布
locale 必须同时满足：

1. 有可追溯的上游 `language` 数字枚举/名称证据，并登记到唯一真源；
2. 前台 messages 完整且无 fallback；
3. 后台模板/字段的语种枚举已登记；
4. 该语种模板已用真实内容跑通渲染；
5. title/description/结构化数据等 SEO metadata 完整；
6. 该语种 sitemap 分片已验证；
7. Owner 明确把该 locale 加入首发 publish whitelist。

任一项缺失时必须继续 fail-closed；不得因为 `SITE_LOCALES` 含 `en` 就默认允许发布。

## 6. 正式 URL 与 SEO 前置

P1 的 `/dev-preview/**` 明确是 noindex、无 canonical 的预览表面。建立正式页面前必须：

- 由 Owner 关闭 D-8，确定默认语种与非默认语种的路径形态；
- 冻结小说详情 URL、章节 URL、非规范 URL 的 404/redirect 策略；
- 保留详情与每章 self-canonical 的既定边界；
- 设计正式 metadata、结构化数据、robots 与聚合页索引边界；
- 设计 sitemap 分片与增量更新；
- 设计发布、正文实质变更、stale、恢复、撤回、下架对应的 IndexNow/outbox 行为；
- 保证 stale/withdrawn/takedown 不继续出现在 sitemap 或公开查询中；
- 把 dev-preview 与正式路由彻底隔离，不能给 preview 页面补 canonical 后冒充生产页。

## 7. 上游 language probe 前置

上游 language 枚举未有可在本仓库引用的正式证据，因此 P2 不得猜码。需要单独安排受控、只读、
可审计的 probe 窗口：

- 只捕获自然发生或 Owner 明确操作产生的请求/响应；
- 记录脱敏的 numeric code、language name、projectType、样本 book/chapter 对应关系；
- 不枚举未知接口、不猜 path、不测试有副作用接口；
- 证据经过 Owner 确认后才更新 `locale-canonical.ts` 的 registry；
- registry 证据与 publish whitelist 决策分开，取得映射不等于允许发布；
- 可在同一证据窗口补查 D-2 的服务端筛选能力，但未证前仍使用页码区间 fallback。

渠道 Adapter、自动目录扫描和章节抓取不因本输入包自动进入 P2 范围；如阶段台账仍将其放在后续
阶段，必须维持该边界。

## 8. 运维、CI、保留期与权限硬化

以下来自 `docs/governance/P1_RISK_AND_DEBT_REGISTER.md`，不是 P1 required fix：

- 首次正式远端 CI 配置前显式运行 `scripts/p1-13-postgres-verification.sh` 或等价 PostgreSQL 16
  门禁；默认 `npm test` 不足以代表 PG 71/71；
- 启用 365 天 `operation_audit` 清理前，设计受控特权清理路径，不给普通应用角色 DELETE；
- 正式任务后台开放前收紧 `web_app` 对 `catalog_scan_task_item` 的 SELECT 列面；
- 将未知内部错误从 403 capability denied 中区分，接入可观测的 5xx 分类；
- 评估 static drift 对 migration-only CHECK/index/trigger 的覆盖；
- 把 Worker/Scheduler health 从仅进程存活升级为能发现卡死/无推进；
- 发布候选中核对 Admin 展示版本与 baked metadata；
- 2FA challenge UI 前区分 expired 与 consumed reason。

## 9. P2 首批建议任务包（非正式编号）

以下名称只是 Owner 排期输入，不是正式任务编号：

- **决策收口包**：关闭 D-7、D-8、W6；确认 D-12 已解决且无需重开。
- **真实内容查询层**：为 Novel/Chapter/Content 建立最小列投影、状态过滤与事务边界，替换 fixtures。
- **内容后台纵切片**：小说列表/详情、章节/正文查看、发布检查、批量发布/撤回与异常原因。
- **正式详情与章节路由**：复用现有组件和阅读器，接真实数据；详情页内嵌实际试读章节。
- **发布准入服务**：将 locale、内容完整性、状态、URL 冲突、SEO metadata 与模板渲染检查组成
  fail-closed gate。
- **SEO 发布闭环**：canonical、robots、metadata、sitemap、IndexNow/outbox、撤回/恢复行为。
- **多语证据包**：完成受控 language probe，形成 registry 变更候选；publish whitelist 仍由 Owner 决。
- **运行门禁包**：把 PostgreSQL 16 验收接入首次正式 CI，并处理发布前高优先级运维债务。
- **真实内容 E2E**：至少一部受控小说从后台/导入到详情、章节、索引、stale、恢复、撤回全链路。

## 10. P2 启动 Gate

P1-15 本地文档提交不等于 P2 自动开工。启动前必须同时满足：

- GPT/Notion 已把 P1-04～P1-14 状态和 P1-15 交付物更新到正式治理台账；
- Owner 已审阅本输入包、待决项和风险登记；
- Owner 明确给出 P2 release Gate；
- P2 第一批正式任务编号和 Owner 在正式台账中创建，而不是从本文件名称推导；
- 远端同步/PR/发布/部署另行授权。

```text
P2_START=BLOCKED_PENDING_OWNER_GATE
NEXT_GATE=GPT_NOTION_UPDATE_THEN_OWNER_RELEASE
```
