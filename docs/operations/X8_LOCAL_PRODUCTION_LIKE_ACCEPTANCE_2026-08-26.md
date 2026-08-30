# X8 本地 Production-like 验收报告（2026-08-27 复验）

## 结论

- 基础设施与安全拓扑：**PASS**。`setup` 已完成系统 CA 信任和 `/etc/hosts`；六服务隔离拓扑、TLS/nginx、PostgreSQL hardening、备份恢复与统一 CLI 通过。
- credential、真实 catalog、sourceLocale 与内容创建：**PASS**。Owner JWT 仅经 `/channel-accounts` 正式入口导入；validation 完成后依次执行 page 1 / page size 20 的 dry-run、apply、linked refresh，三项任务均单次尝试成功。
- §3.9 同步侧证据边界：**PASS**。20 条真实 source 的 promo 字段和 `promotionalText` 全部为 sentinel；`onlineUrl` 未映射到 `appUrl`；公开码只由唯一生成入口负责。
- C2b parser 定位：**PASS（诊断完成，parser 未修改）**。严格一次 `getchapterinfo` 找到唯一失败点：`data.bookId` 为 number，而冻结 parser 仍要求 string。详见 [C2b 形态诊断](../governance/C2B_GETCHAPTERINFO_SHAPE_DIAGNOSTIC_2026-08-27.md)。
- 真实 promo→发布→`/go` 五段：**FAIL**。本次 page-1 实时样本三次均未返回可聚合 promo，linked refresh 后 PromoLink 仍为 0；按约定未使用 fixture、未把 unknown/ru 创建为 en、未伪造发布或跳转 PASS。

## 验收身份与纪律

| 项目 | 值 |
|---|---|
| 分支 | `feature/x8` |
| 代码基线 | `main@5459e0b` |
| 业务验收代码提交 | `3c4659f` |
| 应用 | `cps-novel` 0.1.0，固定 digest Node 20 Alpine 基镜像 |
| 本地入口 | `https://novel.test` |
| 时区 | Asia/Tokyo |

Playwright CLI 只用于 UI 操作和 DOM snapshot；未生成 screenshot、trace、video 或 storage state。DOM 临时文件不入 Git/镜像。Owner token、请求坐标和原始 `getchapterinfo` 响应均不进入报告、命令输出或持久化产物。

## 真实链路结果

### setup、凭证与调用预算

| 验收项 | 结果 | 实测摘要 |
|---|---|---|
| hosts | PASS | `novel.test` 系统 hosts 条目生效。 |
| mkcert 系统信任 | PASS | 本地 CA 已进入系统 trust store。 |
| 渠道账户 | PASS | 仅通过 UI 创建 MoboReader 账户。 |
| JWT 导入 | PASS | token 文件 mode 0600；经正式 credential replacement 入口保存，页面只回显指纹前缀。 |
| credential validation | PASS | worker 任务完成；未访问真实 catalog。 |
| `getlistpc` | PASS | 计划内三次：dry-run、首次 apply、linked refresh；三项均 `attempt_count=1`、`returned_count=20`、item success。 |
| `getchapterinfo` | PASS | Owner 严格授权 `1/1`；无重试、无 redirect，HTTP 200。 |
| credential 收尾 | PASS | supersede 任务完成；活动凭证 0、已作废凭证 1。 |

### catalog 与证据边界

首次 apply 的 20 条 source 分布如下：

| 上游 language | sourceLocale | 数量 | 结果 |
|---:|---|---:|---|
| 3 | en | 16 | registry 命中 |
| 5 | unknown | 4 | 未登记码按 fail-closed 预期落 unknown |

以下字段在 20/20 source 的递归 `rawPayload` 中均存在且值全部为 `[redacted]`：

- `kocCode`
- `publicUrl`
- `homeLink`
- `onlineUrl`
- `promotionalText`

20/20 行均带 `approved_raw_evidence` boundary。首次 apply 前后 PromoLink 均为 0；第三次 linked refresh 的 promoCapture 为 fetched 0、deferred 0、incomplete 0、articlesBound 0、articlesConflicted 0。

这说明 2026-08-27 的实时 page-1 样本已不同于 C2 当天的 5/20 promo 样本。该漂移只影响 X8 真实 promo 成功路径，不影响 §3.9 的脱敏前提取实现与 sentinel 验证。

### 内容创建

只对 `sourceLocale=en` 的 16 条 source 通过 UI 执行“两阶段 dry-run plan → 确认创建”；locale mismatch 警告为 0。最终状态：

| 对象 | 状态 | 数量 |
|---|---|---:|
| NovelSourceItem | en / linked | 16 |
| NovelSourceItem | unknown / pending | 4 |
| Novel | en / draft | 16 |
| Article | en / draft | 16 |
| PromoLink | 任意 | 0 |

没有创建 unknown→en 或 ru→en 错配内容。

真实 X8 同时发现并修复两处生产角色边界缺口：

1. 内容创建计划查询原先让 Prisma 读取整行 `NovelSourceItem`，触碰 web_app 无权读取的 `raw_payload`。现已显式 `select` 仅 10 个已授权列。
2. 内容创建事务需要把 source 链到 Novel。现仅授予 web_app 对 `novel_id/status/updated_at` 的列级 UPDATE；`raw_payload` UPDATE 仍为 false。

### C2b parser 诊断

正式 parser 与形态诊断读取同一内存响应。envelope、data、chapterList、3 个章节 row、`i`、D-1 `chapterID`、`chapterContent`、`currentLanguage` 和复合 `(i, chapterID)` 去重均通过；唯一失败点为：

```text
$.data.bookId: present=1, null=0, typeof number=1
```

建议仅把 `bookId: requiredString(data.bookId)` 改为 `requiredIdentifier("bookId", data.bookId)`，继续输出规范化 string。本单未修改 parser，也未放宽任何冻结字段。

## 未闭环的真实业务段

由于真实 PromoLink 为 0，以下项目必须保持 FAIL：

| 验收项 | 结果 | 原因 |
|---|---|---|
| linked promo 写入 | FAIL | 当前真实 page-1 样本无完整 promo evidence。 |
| Article promo 绑定补偿 | FAIL | 无 PromoLink 可绑定。 |
| 发布双门禁动态验收 | FAIL | 约定要求在取得真实 PromoLink 后验证；未用 fixture 替代。 |
| `/go/{public_redirect_code}` 302/Location/no-store | FAIL | 无真实公开短码与目标。 |
| TrackingEvent 增量 | FAIL | 未执行虚构跳转。 |

## 代码与测试结果

| 检查 | 结果 |
|---|---|
| §3.9 raw promo 旧读路 | PASS；已删除 `readExistingPromoFromRawPayload`、`already_available`、`existing_evidence_redacted` 新写路径；历史 UI 文案保留。 |
| fetched PromoLink 绑定补偿 | PASS；先补偿 Article binding，再走 capability 分支。 |
| X8 grants 幂等 | PASS；grants 由 postgres 执行，可在 `pg_stat_statements` 已存在时重跑。 |
| node project timeout | PASS；显式 `testTimeout=15000`，UI project 不变。 |
| S12 八组 PostgreSQL | PASS；当前套件实际为 91/91，不过滤新增测试伪造 85/85。 |
| Node 20.20.2 `npm ci` | PASS。 |
| `npm run typecheck` | PASS。 |
| `npm run lint` | PASS（0 error；3 条既存 IndexNow unused-arg warning）。 |
| 完整 Vitest | PASS；209 files passed、10 skipped；2490 tests passed、95 skipped。 |
| `npm run build` | PASS。 |
| X8 `accept` | PASS；topology、limiters、logical backup、restore smoke、五组 launch-day SQL 全通过。 |
| token 精确扫描 | PASS；工作树/Playwright 临时产物 0 命中，六服务日志 0 命中。 |
| C2b Lane B | PASS；shape artifact 与 durable report 均 0 finding。 |

S12 回执按内容等价确认：main 已含 lockfile、port-registry 与 P1-07 `--config vitest.config.ts` 修法，无需重复 cherry-pick。

## 最终安全状态

```text
FEATURE_NOVEL_CATALOG_SYNC=false
NOVEL_CATALOG_SYNC_ALLOW_WRITE=false
FEATURE_PROMO_LINK_CLAIM=false
PROMO_LINK_CLAIM_ALLOW_WRITE=false
getbydataid=registered_disabled
getchapterinfo=registered_disabled
claimPromo=registered_disabled
active credential count=0
```

Owner token 在 exact scan 与 credential supersede 完成后删除。C2b harness、坐标文件、shape artifact 和原始响应引用均已删除。

## 残余项

- 需要新的真实 page-1 promo 样本，或 Owner 明确批准其他真实页范围，才能重跑 promo→发布→`/go` 五段；不得用 fixture 改写本次 FAIL。
- C2b `bookId` 窄修法待 Owner 裁定；修复时不得回退 D-1 或放宽其他字段。
- `/` 在默认 OG image 未配置时返回 500（`OG image is required`）；不影响本次 `/api/health`、管理后台和获批链路，但属于生产开闸前独立配置/兜底项。
- U5 已由审核方确认并字面快进到 `main@00867ce`；本 X8 分支仍按获批的 `main@5459e0b` 基线执行，不把 U5 混入本次镜像。
