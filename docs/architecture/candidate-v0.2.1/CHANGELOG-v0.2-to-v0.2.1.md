# CHANGELOG · candidate-v0.2 → candidate-v0.2.1

> 修订日期：2026-08-02
> 性质：**文档收口，不重新设计**。无新架构、无新实体、无新流程；只做定义收窄、待决关闭、旧口径清理与一处互斥修正。
> CPS 代码基线不变：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（v8.1.1，本轮未再读 CPS 代码，也未修改）
> candidate-v0.1（GitHub `cb94981`）与 candidate-v0.2（GitHub `11c8d80`）**均未修改**。

---

## 一、六项收口

### 1 · 「完整试读目录」定义收窄

| 项 | v0.2 | v0.2.1 |
| --- | --- | --- |
| 表述 | "详情页 + **完整试读目录** + 全部试读章节页全量进入 SEO"——"完整目录"有被读成"拥有全书章节目录"的风险 | `完整试读目录 = 展示 getchapterinfo.chapterList[] 当前实际返回的全部章节` |
| 新增硬约束 | — | ① **不宣称拥有全书完整章节目录**（文案/结构化数据/SEO 描述均不得暗示）；② **不得根据 `allEpis` 生成无标题章节占位**；③ 目录完整性只与当前权威列表一致，**不与 `allEpis` 比对** |
| 承载形式 | 未提 | 新增待决 **D-12**：独立目录路由 vs 嵌入详情页，由 Owner 选；两案下三条约束都成立 |

影响文件：架构 §6.1（新增定义小节 + 前台页面表 +「试读目录」行 + SEO 口径表 + 目录行）、契约 §3.3（物化产物即目录数据源）、证据 §8.3.1、计划 P2 前台任务与验收。

### 2 · D-10 关闭：缺失章节处置冻结

**v0.2**：`CANDIDATE` 推荐"连续 K 次（建议 3）缺失 → `stale` + 人工队列"，待 Owner 冻结。

**v0.2.1**（`OWNER_DECIDED`）——关键是把抗抖动从"计数器"移到"响应可信度前置判定"：

```
第一步 · 响应可信度
  请求失败 / 响应异常 / 异常空列表 → 不改变现有可见状态，本轮结束
  成功 + 结构完整 + chapterList 非空 → 该列表即当前权威试读集合
第二步 · 与权威集合比对
  同章 hash 未变 → 不重写；hash 变化 → 更新；新章 → 新增
  旧章未再返回   → 立即 stale（停展、退出 sitemap）
  stale 章重现   → 自动恢复 preview（写审计）
任何情况下：正文保留，不自动硬删
```

**删除的两条**：连续 K 次阈值（`consecutive_miss_count` 字段一并删除）、人工确认作为下架/恢复的必选环节（人工队列降为可选运维视图）。

影响文件：证据 §8.4、数据模型（`NovelChapter` 状态与转移、`NovelChapterSourceItem` 字段）、契约 §3.3 刷新块与 §3.14 场景表、parity §5、计划 P2 任务与 Owner Gate、开放决策 §4.5。

### 3 · D-11 关闭：推广值存储

```text
OWNER_DECIDED = CPS_PARITY_WITH_PUBLIC_CODE_SEPARATION
```

采用 CPS 方案 A（严格复用：raw 镜像保原文、PromoLink 存真实值、canonical 三把钥匙、后台明文、写路径锁、审计掩码），**唯一偏离是公开 URL 使用 `public_redirect_code`、不使用 `upstream_code`**。方案 B 不再是待决项。

影响文件：证据 §8.7、parity §4、开放决策 §4.5、计划 Owner Gate。

### 4 · 旧口径清理

| # | 清理项 | 处置 |
| ---: | --- | --- |
| 1 | "跨语种关系用 hreflang 表达" | **删除**（架构 §4 硬约束、开放决策多语言方案行）。V1 不存在需要表达的跨语种关系 |
| 2 | 发布白名单中的 hreflang 验收 | **删除**。五项改为：messages 无 fallback · 后台模板语种枚举已登记 · 模板已跑通真实渲染 · SEO 元数据齐全 · sitemap 分片已验证 |
| 3 | W2 证据等级 | 改为**技术 `PRODUCTION_READ_PROVEN` / 展示 `OWNER_CONFIRMED`**；不再把 Owner 声明标 `DOC_CONFIRMED`（后者留给渠道书面材料） |
| 4 | P1 Gate 的 D-1 | **删除**（D-1 已于 v0.2 关闭）。P1 Gate 保留 D-2、D-7 |
| 5 | P2 输入的 D-3 展示/索引阻塞 | **删除**（v0.2 已裁决试读整体进 SEO + 完整展示）；余下缓存细则降为一般运维项。P2 输入改为 D-7 + D-12 |

### 5 · CatalogScanTask 互斥修正

| 项 | v0.2 | v0.2.1 |
| --- | --- | --- |
| 目录扫描互斥 | 与其他任务统一：`(task_type, channel_account_id, channel_app_id, operation_scope_hash)`——page-range hash 不同即放行 | `UNIQUE(channel_account_id, channel_app_id, project_type) WHERE status IN ('pending','processing')`——**同账户 × 应用 × 品类单 active，不用 page-range hash** |
| 其他任务类型 | `operation_scope_hash` | **不变**，仍用 `operation_scope_hash` |

理由：page-range hash 会允许同一账户对同一目录并发重叠扫描——争抢上游配额、互相覆盖 `NovelSourceItem` upsert、污染 `catalog_observed_total` 水位与批次统计。分页区间不是真正独立的作用域。要扫更多页就排队跑下一批。

影响文件：数据模型 §2.13（`CatalogScanTask` 专属规则 + 通用规则划清边界）、契约 §3.1 幂等行与拒绝输入清单 + §4.6、验收新增一条。

### 6 · 文档、outbox 与 CHANGELOG 更新

六份架构文档 + open decisions + parity + 两份 outbox + 本 CHANGELOG，共 10 个文件。

---

## 二、验收口径变化

**契约文档 §6：12 条 → 15 条**

| 变化 | 内容 |
| --- | --- |
| ⛔ 删除 | 原 #11「模拟某章连续缺失，第 K 次后转 stale」——K 次阈值已随 D-10 关闭删除 |
| ✅ 新增 #11 | 响应不可信（失败/结构异常/异常空列表）时已展示章节**保持展示**，无 stale、无下架、无删除 |
| ✅ 新增 #12 | 可信且非空响应中旧章缺席 → **立即** stale、退出 sitemap，`NovelChapterContent` 行仍在 |
| ✅ 新增 #13 | `stale` 章重新返回 → **自动**恢复展示与收录，无需人工确认 |
| ✅ 新增 #14 | **目录扫描单 active**：同账户×应用×projectType 已有 active scan 时，另一页区间扫描入队被拒 |

**计划文档 P2 验收：16 条 → 20 条**（新增响应不可信保持、立即 stale 保留正文、自动恢复、目录扫描单 active、目录无 `allEpis` 占位）。

---

## 三、待决状态总览

| ID | v0.2 | v0.2.1 |
| --- | --- | --- |
| D-1 跨语种关联 | 已关闭 | 关闭（并移出 P1 Gate） |
| D-2 服务端筛选 | OPEN | OPEN（影响面已缩小） |
| D-3 展示/索引/缓存 | 大部关闭 | **完全关闭**（缓存降为运维项，移出 P2 输入） |
| D-5 `GetReportMaxTime` | OPEN | OPEN |
| D-6 / R3 归因维度 | OPEN | OPEN |
| D-7 首发语种白名单 | OPEN | OPEN |
| D-8 URL locale 段 | OPEN | OPEN |
| D-9 作者列 | 已按立项书采纳 | 不变 |
| **D-10 缺失章节处置** | OPEN（CANDIDATE） | ✅ **关闭** |
| **D-11 推广值存储** | OPEN（CANDIDATE） | ✅ **关闭** |
| **D-12 目录承载形式** | — | 🆕 **新增 OPEN**（P2 开工前需定） |
| W6 品牌 / W9 首测授权 / D6 工期 | OPEN | 不变 |

---

## 四、本轮未做

未创建正式项目 / 代码 / Prisma Schema / Migration / 数据库 / Worker / Adapter / 页面；未调用渠道接口；未连接生产；未修改 CPS 工作区；**未修改 candidate-v0.2 与 candidate-v0.1**；未写回 Notion（无 MCP，仅生成 outbox）。本轮亦**未重新读取 CPS 代码**——parity 报告的事实结论沿用 v0.2 的实读结果，仅更新其下游裁决状态。
