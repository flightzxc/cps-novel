# U6 backend 修复、签收与合入回执 · 2026-08-27

## 结论与提交

**本单 PASS：四项阻塞已修复，两项建议已完成，固定 U6 已合入本地 main，合并后门禁复跑通过。**
本结论不代表金丝雀候选成立或允许发布；真实 PostgreSQL、凭证与业务链验收仍按预备轮处理。

| 对象 | 提交 / 状态 |
|---|---|
| 合入前 main / U5 | `00867ce0af90fe81ef3191a328873bf5c739a87c` |
| 本轮固定 U6 | `30842b18f6789a0a9890a75d476f69b299e10d73` |
| 修复分支 | `fix/u6-backend-acceptance` |
| 修复与 custodian 登记 | `4f76cdb3195b32f085e22edef4056fd5306dbde7` |
| main merge commit / 复跑代码基线 | `457309df532f5c479b0da0285ae9cf76d5d70b3e` |
| 保留的金丝雀分支 | `feature/canary-preflight@41538bafd297ee857da441914f674229d0e39314`，未改动 |

merge commit 的两个父提交为 `00867ce`、`4f76cdb`；U5、固定 U6、修复提交的祖先检查均 PASS。
合并使用 `--no-ff`，本次无冲突；合并树与修复分支树一致
（`984df7e08bb1ca768506186e9a639e00f201245f`）。原 U6 提交未重写。
执行期间源分支另行推进到 `ce3cada`（U6b 注释修订），本单按固定输入 **未纳入该新提交**。

## 四项阻塞与两项建议

| 项目 | 结果与证据 |
|---|---|
| 1 · 空白名单 hreflang | PASS。测试改名为 `novel-hreflang-whitelist.test.ts`；真实 en 用例保留，查询一次且限定 en；新增空名单 spy，用例断言结果为空且零 DB 查询，afterEach 恢复 spy。 |
| 2 · 失效指针 | PASS。主 hreflang 测试准确指向新文件，区分真实 en、模拟空集与模拟多语言；tests 下无旧文件名引用。 |
| 3 · 零 URL sitemap 闸 | PASS。合法非空子文件数组的 entries 全为空，经真实 refresh → generator 链得到精确错误 `Generated sitemap contains no public URLs`；旧 current 指向不变，锁已释放。原空 routeLocales / 无子文件测试保留。 |
| 4 · 越界登记与签收 | PASS。development-log 逐项登记 U6 触及的六个 backend 测试文件、固定提交与 Codex custodian accept；沿用 X12 / 5459e0b 先例。 |
| 5 · outbox seed 去重 | PASS。helper 新增默认 en 的 locale 参数；en / es 使用相同 helper 和其他字段，真实默认白名单下分别入队 / ineligible，原负向精确断言保留。 |
| 6 · 陈旧说明 | PASS。更新 IndexNow eligibility、promo 发布测试、sitemap 多语言测试及 locale route guard 用例理由；未改变对应生产执行语句或路由断言。 |

相对固定 U6 净增 **3 个测试场景**：空白名单零查询、零 URL 拒绝 promotion、真实 en outbox 入队。
原 hreflang 文件中的测试迁移到新文件，没有删除覆盖；未增加 skip、没有通过注入生产依赖放行。

本单重点回归在合并前后均实跑 **10 files / 100 tests PASS**。完整测试同时确认：

- 不传发布 evaluator 依赖覆盖时，其他条件齐备的 en facts 可发布，es 仍被 locale 闸拒绝。
- content-creation 的真实 evaluator 测试仍返回
  `["preview_chapter_missing", "promo_link_missing"]`，不会因 D-7 放行自动补齐业务条件。
- 所有 locale 前缀仍不可路由；en 因默认语种使用裸路径，`/en/...` 仍被结构性 guard 拒绝。

以上是测试证据，不是运行拓扑中的候选发布或 `/go` 验收。

## 门禁全表

Node `20.20.2`、npm `11.6.2`、Prisma `6.19.2`、Vitest `3.2.7`。
Node project 使用已获 Claude accept 的 CLI `--testTimeout=15000`；UI 使用默认超时。
`vitest.config.ts` 未改，其正式 15s 配置仍随 X8 合入。

| 门禁 | 修复分支 | 合并后 main |
|---|---|---|
| npm ci | PASS，491 added / 492 audited，重跑 10s | PASS，491 added / 492 audited，10s |
| Prisma generate / validate | PASS / PASS | PASS / PASS |
| typecheck | PASS | PASS |
| lint | 0 error / 3 warning | 0 error / 3 warning |
| 重点回归 | 10 files / 100 passed / 0 failed / 0 skipped | 10 files / 100 passed / 0 failed / 0 skipped |
| 完整 Node | 123 files passed / 10 skipped；1137 tests passed / 0 failed / 95 skipped | 同左，已实际复跑 |
| 完整 UI | 85 files passed；1369 tests passed / 0 failed / 0 skipped | 同左，已实际复跑 |
| 完整 Vitest 合计 | 208 files passed / 10 skipped；2506 tests passed / 0 failed / 95 skipped | 同左，已实际复跑 |
| build | PASS | PASS |
| 静态数据库字典 | PASS：44 models / 952 records / 950 active | PASS，同计数 |
| 项目隔离 | PASS | PASS |
| diff / 领土检查 | PASS | PASS |

两轮测试各自计数，不将重复运行累加为更多独立用例。95 条条件跳过全部属于未启用的真实数据库套件：

| 套件 | 本轮每次完整 Node 运行的 skipped |
|---|---:|
| P1-05B | 10 |
| P1-06 | 7 |
| P1-07 | 16 |
| P1-08B auth | 8 |
| P1-08B credential | 15 |
| P1-13 | 6 |
| P2-04 | 4 |
| P2-05 | 22 |
| X6 site-setting | 4 |
| X9 task-admin | 3 |

这些套件没有被本轮改成 skip，也不计作真实 PostgreSQL 通过；X8/金丝雀原有的 PG 复跑仍待后续。

### 执行过程中的说明

- 首次默认 npm ci 在安装 / postinstall 完成后，最后可见阶段为 registry 元数据读取，
  约七分钟未结束后主动终止，exit 143；这次不计 PASS。
  随后及合并后均使用 `npm ci --prefer-offline --fetch-timeout=30000 --fetch-retries=1` 成功，
  未跳过安装脚本或 audit，锁文件未变。
- npm audit 仍报告已登记的 **8 high**；未执行 audit fix 或依赖升级。
- lint 的三条 warning 均为既存 IndexNow unused-arg：delivery-handler 两条、fake-db 一条。
- 可复查日志位于仓库内 `.tmp/u6-backend-acceptance/`，区分 pre/post；不包含真实上游 token。

## 影响、边界与金丝雀衔接

- **D-7**：本地 main 代码的白名单为 `["en"]`。本轮未重建或替换运行镜像，因此不声称
  当前 Docker 拓扑已采用该代码；金丝雀须在最终 main 镜像上调用正式 evaluator，按实际 reasons 判定发布。
- **容量登记**：触达 hreflang loader 的小说页/章节页请求，相比空白名单短路新增一次
  `article.findMany`；外层 React `cache` 按 novelId 复用同次渲染的调用。仅登记影响，未作压测、
  未增加缓存或改查询；后续评估须计入详情页总查询数。
- **Sitemap**：已有正式 worker → refresh → generator 调用链；业务运行闸按既定关闭状态处理。
  本轮只在测试临时目录执行生成链，没有触发业务拓扑任务或打开任何闸门。
- **language=5**：仍 unknown，未登记新映射、未读取已删除探针材料、未发送新探针。
- 修复相对 `30842b1` 只涉及 backend 测试、docs 与 IndexNow 块注释；去除该块注释后源码文本
  逐字一致。未改 Claude 实现路径、schema、migration、grants、依赖或 Vitest 配置。
- CPS 参考库保持 clean@`d77c3b968285698529cf97c7f0f97b286d7a2a9c`；隔离脚本确认无
  symlink、submodule 或 CPS runtime 引用。改动文件 JWT / 私钥模式扫描 0 命中。
- 未 push、打 tag、部署生产、重建本地运行镜像、清理 Docker、导入 token、发布内容，
  未开放 claimPromo / Sitemap / IndexNow；不触及本轮未获授权的 Docker 清理。
- 切换离开 X8 后，既存 `.playwright-cli/` 因其忽略规则尚未合入而显示 untracked；
  本轮未读取、修改或提交该目录。tracked 代码保持提交完整。
- 金丝雀分支、单项 preview 优先顺序、扩页预算、TTL 独立发现、C5 定向预览 UI、X11、R1/R2
  后续清单均保留。Docker 空间与新 token 仍是金丝雀实跑前置条件，U6 合入不替代其验收。
- 后续合并 X8/金丝雀时须保留 U5、U6 和金丝雀 development-log 全部条目；本单未提前合入这些分支。
