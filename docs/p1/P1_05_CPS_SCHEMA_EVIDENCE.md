# P1-05A CPS Schema Evidence

**CPS baseline：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`**

**Access：READ_ONLY**

**Search tool：`rg` 不可用，使用 `grep -R/-E` 等价搜索**

## 1. 实际读取的正式证据

| 文件 | 关键行 | 用途 |
| --- | --- | --- |
| `docs/p1/P1_OWNER_MINIMUM_CORRECTIONS.md` | 48–71 | at-least-once、execution token、lease epoch、旧租约拒写 |
| 同上 | 75–107 | side-effect intent 与 operation audit 事务边界 |
| 同上 | 121–150 | Web/Worker/Scheduler 密钥边界和永久公开短码 |
| `docs/p1/P1_IMPLEMENTATION_ASSIGNMENT.md` | 102–115 | P1-05 交付物、目录和验收 |
| `docs/p1/P1_SHARED_CONTRACTS.md` | 16–31、35–56 | 公共读取、locale 与可见性 |
| 同上 | 81–99、141–152 | 短码和任务互斥；短码部分索引表述被 Owner 修正覆盖 |
| 同上 | 175–204 | 内容状态与渠道无关性 |
| `docs/architecture/candidate-v0.2.1/novel-v1-logical-data-model-v0.2.1.md` | 29–55 | 每语种版本一个 Novel；章节三表责任 |
| 同上 | 69–237 | Novel、SourceItem 和章节字段 |
| 同上 | 282–470 | 标签、Article、渠道、凭证、PromoLink 与审计 |
| 同上 | 472–590 | 三类任务、独立领取索引、IndexNow、Tracking |
| `novel-v1-adapter-and-workflow-v0.2.1.md` | 27–55、115–191 | 能力注册、chapterList 真源、未证推广能力禁用 |
| 同上 | 704–790 | claim、lease、active 互斥、Cron 与 retry 纪律 |
| `novel-v1-system-architecture-v0.2.1.md` | 237–310 | PostgreSQL 16、进程角色和 SQL 纪律 |

## 2. CPS `prisma/schema.prisma` 证据

| 搜索项 | 实际位置 | 结论与处理 |
| --- | --- | --- |
| `Channel` | 100–113 | 注册表形态可复刻；UUID 取代 cuid |
| `ChannelAccount` | 118–148 | 多账户关系可复刻；主键改 UUID，父级删除改 RESTRICT |
| `ChannelAccountCredential` | 150–168 | 密文、指纹、expires/status 可复刻；密文改 PostgreSQL `bytea` |
| `SourceApp` / `ChannelApp` | 205–246 | 绑定三元唯一可复刻；新增 `project_type` 配置 |
| `DramaSourceItem` | 251–287 | 来源/canonical 分离和三元唯一可复刻；字段改 Novel 语义，JSON text 改 jsonb |
| `DramaPromoLink` | 292–326 | 资产表与账号维度幂等可复刻；真实码拆为 upstream/public 两码 |
| 推广审计 | 328–387 | 分段留痕和脱敏字段是证据；按 Owner 修正拆成两类事务表 |
| `ChannelSyncTask/Item` | 393–440 | 两级任务、item 唯一和 attempt 可复刻；PG lease/fencing 为重做项 |
| Article/Page ID | 532–587 | locale/slug/page ID/发布字段可适配；Drama switch 相关 DROP |
| `execution_token` | 656–658 | CPS 有单 token/lease expiry 形态，但没有 `lease_epoch` |
| `home_carousel_*` | 740–843 | 五表形态、候选 rank、serving 和 change log 可适配 |
| fingerprint latch | 1236–1258 | fingerprint 与 credential 双唯一的 DB 互斥模式可复刻 |
| Generic task | 1410–1455 | batch/item 形态可适配；固定 `drama_id` DROP |
| IndexNow | 1460–1519 | outbox/attempt、retry 元数据和七态运行时证据可适配 |
| `locked_until` | 1684 | CPS Schema 命中登录风控，不是 Worker item lease；不能冒充任务租约证据 |

## 3. CPS Migration 证据

| 文件与行 | 证据 | PostgreSQL 处置 |
| --- | --- | --- |
| `20260607100000_channel_account_credentials/migration.sql:25–48` | credential 表和 active partial unique | 复刻语义，类型/删除策略改 PG |
| `20260705090000_v770_home_carousel_pr1b/migration.sql:7–31` | manual slot 两个 enabled partial unique | 谓词改为 `enabled IS TRUE` 并排除软删 |
| 同文件 `33–111` | auto batch/candidate/serving/change log | Drama→Novel，JSON text→jsonb，时间→timestamptz |
| `20260717090000_v793_indexnow_outbox/migration.sql:4–60` | durable outbox/attempt | 幂等键冻结为 `(url, revision)` |
| `20260721180000_v797_batch_switch_durable/migration.sql:1–27` | execution token、lease、heartbeat | 只借鉴形态；新增 item 级 `lease_epoch` |
| 同文件 `88–98` | active partial unique | 用于任务 active 互斥模式证据 |
| `20260711130000_v780_changdu_preview_catalog/migration.sql:23–27` | 少量显式 CHECK | 证明 CPS 后期使用过 CHECK，但 CPS 大部分状态仍无约束 |

## 4. 搜索关键词结果

已实际搜索：`Channel`、`ChannelApp`、`ChannelAccount`、`ChannelAccountCredential`、`DramaSourceItem`、`DramaPromoLink`、`fingerprint`、`IndexNow`、`home_carousel`、`@@unique`、`CHECK`、`locked_until`、`execution_token`。

未找到可直接复刻的证据：

- `lease_epoch`：CPS 无完整实现。
- 章节三表：CPS 只有视频/集数语义，无小说正文三表。
- CatalogScanTask：CPS 首扫没有等价结构。
- `side_effect_intent` 与 `operation_audit` 双表双事务边界：CPS 没有通用实现。
- 任务 Item 的 `locked_until`：Schema 中未找到可用的 Worker item lease。
- 未证北斗或 claim Promo 协议：没有可靠 Endpoint/Body/幂等合同。

## 5. 明确 DROP 的 SQLite 逻辑

- datasource `provider = "sqlite"`、`file:` URL。
- `AUTOINCREMENT`、`DATETIME`、文本 JSON、SQLite boolean/int 假设。
- `PRAGMA`、busy timeout、WAL、`BEGIN IMMEDIATE`。
- `UPDATE ... id=-1` 伪写锁。
- `WHERE enabled = 1`。
- 未加引号的 `AS camelCase` 原生 SQL。

本文件只记录证据，没有从 CPS 复制代码或修改 CPS 文件。
