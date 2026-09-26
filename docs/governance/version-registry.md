# 版本台账

记录本项目对外可辨识的版本号变更和阶段里程碑。阶段完成不等于发布或部署。

## 同步纪律

版本号需在 `package.json`、`Dockerfile` 构建参数（`APP_VERSION` / `NEXT_PUBLIC_BUILD_VERSION`）、
compose / 环境变量（`.env.example`、`infra/preproduction/preprod.env.example` 及目标机
`/opt/cps-novel/shared/env/preprod.env`）之间保持一致。P1-12 已落地不可变构建 metadata、
Compose runtime 与 Health 身份一致性验证（`/api/health` 的 `metadataConsistency`，见
`src/server/health/service.ts`）；正式远端 CI 和发布流程仍未配置，不得把本地门禁结果登记
为已发布。

> Notion 权威页：[海阅 版本管理与发版手账](https://app.notion.com/p/3e4601b5fd3481b5a39bcf48408015c2)。
> 本文件是仓库内镜像；v0.4.5 已直接同步到 Notion 并读回核对（发布、手动刷新及后台目测验收通过）。本文件变更不会自动写入 Notion。

## 当前快照

### v0.4.5 —— 已发布到预生产（2026-09-26 22:53:14 +0800，`RELEASE=PASS`）

- 身份：开发线 `integration/v0.4.5-2026-09-26`，基于 v0.4.4 收官线 `845ca02`，
  工单 1–4 与 7a 依次以 `--no-ff` 合入；集成基线 `d841df8`，五个合并提交均带 Claude Opus 5.5 复核 trailer。
  升版 `69765e1` 后 Opus 仅修正 catalog-batch 过时测试断言；Owner 指定 Final
  `ff1d2dd7c8d46dba8e9267687eafbb9347b55387`。annotated tag `v0.4.5` 指向该 Final，不指向治理提交。
- 镜像 `cps-novel:0.4.5-ff1d2dd`（linux/amd64）；归档 327,387,878 字节，
  SHA-256 `c195dfc04fdf170933884329e179d914012afe76d8f8a6dbfad14d03e2772d02`；
  config digest `sha256:9d7a837ea409108ab5770a0641303bfab0882467bf903d85a4ef4d19f9e5c229`；
  platform manifest digest `sha256:73174059d04c37a1eb4ddeaa07becf2fcb8896b2e834f25f2e3650c7b25a9106`。
  发布目录 `/opt/cps-novel/releases/ff1d2dd7c8d46dba8e9267687eafbb9347b55387`；
  commit/tree、归档与载入镜像核对通过。
- **已上线（预生产）**：文章发布后触发试读的逻辑；sitemap 写闸登记、后台手动刷新与命令行；
  数据库连接池合一、详情页去重复查询、侧栏二级菜单链接。试读仍不在 worker 白名单中，实际不执行。
  **仅设计完成**：7a ADR 已合入，前台自动标签代码未开发。无 schema、迁移或 grants 变更。
  不含工单 5/6/7、不取消 80,006 条旧试读积压、不补已发布文章试读。
- 本地门禁：tsc 0、生产构建通过；全量 `npm test -- --maxWorkers=4`：
  451 文件 / 6,760 项 passed，34 文件 / 337 项 skipped，0 failed、0 Unhandled Error。
  满载的两个已知超时文件各单独复跑两次通过；4 workers 无 onTaskUpdate 超时。
  迁移、数据库 schema、字典 drift 0。七组真实库运行器：publication-preview 12、sitemap-refresh 11、
  phase-d 83、catalog-batch 24、batch-control 18、release 18、add-admin-identity 2 项通过；
  B-8 分片枚举 4 项、页位置排序 1 项另行通过。Final 的四组复跑通过；
  按 Owner 指示，单个整文件默认跳过的真库测试断言修订后不重跑全量/build/tsc。
  B-14 及基线同样失败的 B-15/B-16 不在本版修复范围。
- 部署仅限 `haiyue-vps`。部署前、后正式批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 均 paused，
  无其它运行态领取任务，processing 条目 0、非终态领取意图 0。
  在线逻辑备份 `cps-novel-20260926T144540Z.dump`，190,429,479 字节，
  SHA-256 `07d15cc425b32b39274f01ee0fca3cba003b9db6dba4195fcb807c10c2a422c8`，`LOGICAL_BACKUP=PASS`。
- env 备份 `preprod.env.bak-v045-20260926T145200Z`；diff 只有三处：
  `APP_VERSION` 0.4.4→0.4.5、`NEXT_PUBLIC_BUILD_VERSION` v0.4.4→v0.4.5、
  `PREPROD_APPROVED_OPEN_WRITE_GATES` catalog_write,promo_write→catalog_write,promo_write,sitemap_write。
  先改 env，再仅运行新版 preflight/release；输出
  `PREPROD_WRITE_GATES=PASS approved=catalog_write,promo_write,sitemap_write open=catalog_write,promo_write,sitemap_write`。
  生命周期开关与按接口限速仍 true，两接口各 1,500 ms；白名单、账号、主机 nginx 及批次状态均未改动。
- `RELEASE=PASS` / `RELEASE_EXIT=0`，release-state ready、current 指向 Final；
  health 0.4.5 / Final / metadata passed / database passed；四容器 healthy，三服务近 5 分钟错误日志 0。
  18 个迁移无 pending；postgres 容器 ID 与 Created 前后未变。
- 部署后只执行 sitemap `--dry-run`，未执行 `--apply`：
  en=1、es=1、pt-BR=1、id=1、vi=1、th=1、ja=1、ko=20、zh-Hant=1、ar=1、fr=1、de=1、pl=1、cs=1、ru=1，总计 34 URL。
  对应 15 个主页 + 13 个韩语书页 + 6 个韩语分类页；库内符合条件的韩语书 13 本，其余语种 0。
  当时线上 XML 34 URL，与候选逐项一致，缺失和多余均 0。
- **Owner 发布实地验收通过**：文章 `2b762fb2-e4db-400e-a3a6-de584f49971a`（短 ID `968nrdfv`，
  《세 오빠가 무릎을 꿇고 용서를 빌어요》）于 2026-09-26 23:26:58.836 +0800 发布成功，SEO public。
  书目 `f52b27e3-d7e7-4297-b383-6fb7dcaab0a4` 已有旧试读任务
  `ff9c1fa1-4311-4d5e-9c11-580770b99898`（09-22 创建），仍 pending、attempt 0、未开始。
  发布前后试读任务总数均 80,006，新增 0，符合 `preview_in_flight` 预期；
  本次未覆盖“无旧任务时新增 1 pending”的实地分支，不声称观察到字面 skipReason。
- 发布自动 sitemap 任务 `7ad98e34-a82d-45f6-8acb-d38275ca76a9` 于 23:26:59 +0800 success。
  Owner 两次手动刷新任务 `0ecd1724-41f8-48b5-accd-1ef93d294b32`（原因“测试”）、
  `616568be-8ac6-45ec-a7dc-6638498217f9`（原因“·”）均 queued→completed，条目 success、error null；
  审计 `276009` / `276011` 记录 `sitemap.refresh.request` 与相应 taskId。
  末次生成时间 `2026-09-26T15:29:24.944Z`，当前 35 URL：
  ko=21（主页 1、书页 14、分类 6），其它 14 个语种各主页 1；
  XML、候选及库内 14 本韩语书逐项一致，缺失和多余均 0。
- **Owner 目测通过**：Sitemap 卡片显示任务已完成、最近生成成功、收录 35；
  “设置 → 账号安全”可点击，“API 配置”仍灰色。最终只读核对批次仍 paused、运行态领取任务 0。
  恢复批次由 Owner 操作；生产未上线。回滚目标 v0.4.4 Final `205220ebc6f460e85e6fbc8901f592c979c87b83`，
  数据库结构兼容；先备份并恢复 env（移除 sitemap_write、恢复版本变量），再执行旧版回滚；本次未触发回滚。


### v0.4.4 —— 已发布到预生产（2026-09-26 12:14 +0800，`RELEASE=PASS`）

- 身份：开发线 `integration/v0.4.4-2026-09-26`，基于 `fb68856`，以 `--no-ff` 合入
  `fix/sitemap-refresh-stale-cache` @ `cc7a54c`，合并提交 `56727e0` 带 Claude Opus 5.5 复核 trailer。
  Final SHA `205220ebc6f460e85e6fbc8901f592c979c87b83`，annotated tag `v0.4.4`；镜像 `cps-novel:0.4.4-205220e`（linux/amd64）。
  config digest `sha256:664adc8eeade6a71c79ae3130bd0bb99902f030737ef6406f57eef9dbc041922`，platform manifest digest `sha256:bbb07762665f46073b3437174a91dbfacd5d65b75e882aa6561778fa88ba8851`；
  归档 SHA-256 `fc13c5a682b75e0147d230e63aef20e0770ee32a084d89297222b96f4e440a53`；发布目录 `/opt/cps-novel/releases/205220ebc6f460e85e6fbc8901f592c979c87b83`。
- PATCH：每次 sitemap 刷新重建候选 builder；processing 期间发布在现有 JSONB 中标记需补刷，
  终态或租约耗尽回收时经同一 advisory lock 入队一个尾随刷新；普通重试保留标记。
  预生产 nginx 仓库模板同步 general `30r/s` / burst `100`、api `20r/s` / burst `60`；登录和 production-like 模板不变。
  本轮未修改主机 nginx 配置。无 schema、迁移或 grants 文件变更，迁移步骤为 `No pending migrations to apply`。
- Owner 授权仅在 `haiyue-vps` 部署。前后只读确认正式领取批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 为 paused，
  处理中条目和非终态领取意图均为 0。在线逻辑备份 `cps-novel-20260926T040719Z.dump`（190,425,974 字节，
  SHA-256 `1d89e68861ebdcd3d6a2d253bad4665458885cda5db4808edd3cfcd073966c39`）；`LOGICAL_BACKUP=PASS`。postgres 容器 ID、Created 未变。
- 目标机 env 备份 `preprod.env.bak-20260926T041343Z`，只改 `APP_VERSION` 0.4.3→0.4.4、
  `NEXT_PUBLIC_BUILD_VERSION` v0.4.3→v0.4.4。未更改其他配置、账号、白名单或批次状态。
  按接口限速与生命周期开关保持 true，两接口各 1,500 ms；sitemap 双闸与 worker allowlist 保持开启。
- 目标机代码 commit/tree、归档 SHA-256、载入镜像 revision/平台核对通过。`RELEASE_EXIT=0`，release-state 为 ready，
  四容器 healthy；health 返回 0.4.4 / Final / metadata passed / database passed；后台域名隔离通过，三服务近 5 分钟错误日志 0。
- 本地门禁：tsc 0，相关单测 41 passed，sitemap 真实库 5 passed / 0 skipped，五组指定真实库运行器与
  分片枚举 4 项、页位置排序 1 项通过；迁移、数据库 schema、字典 drift 0。全量按 Owner 批准降低到 4 workers 后
  446 文件 / 6,695 项通过（33 文件 / 319 项环境门禁跳过）；原满载 UI 超时经 Opus 判定无关，登记 B-14，本版不改测试。
- **实地验收**：两次新文章发布实地验收通过：首次于 2026-09-26 12:21:02（+0800）刷新成功，runId `d6c8ea3e-b4aa-4767-8651-c98cf319fc81`，XML 与数据库均为 12 本；第二次于 12:22:35 刷新成功，runId `7f450f7e-52e2-4c3d-adb2-2fe5b1ff30df`，XML 与数据库均为 13 本。两次任务 completed、条目及 status.json 均 success，URL 逐项一致（无缺失或多余）。web 容器内用 Node http 携带 Host: www.bangbangji.cloud 请求；同一 worker 自 04:14:08 UTC 启动后未重启（RestartCount=0），确认缓存不再跨刷新冻结。发布前基线为库内 11 本、旧 XML 8 本，runId `3bfcfc37-427b-4222-9ba5-d9db5ef33436`。
- 正式领取批次由 Owner 恢复；手动刷新、每日兜底、命令行生成、写闸登记及 B-8/B-9/B-14 修复不纳入本版。
  回滚目标 v0.4.3 Final `505feeaae04ae1a23df3e7f6a27795f4128636f3`，数据库结构兼容；生产未上线。

### v0.4.3 —— 已发布到预生产（2026-09-25 22:35 +0800，`RELEASE=PASS`）

- 身份：开发线 `integration/v0.4.3-2026-09-25`（基于 v0.4.2 收官提交 `e1e9396`）；Final SHA
  `505feeaae04ae1a23df3e7f6a27795f4128636f3`，annotated tag `v0.4.3`；镜像
  `cps-novel:0.4.3-505feea`（linux/amd64，config digest
  `sha256:e601019cf1009564496deba6d5952cd2d64c4cff21c17b63cbd6f483d10a9f31`，归档 sha256
  `fecbd3eaee7063a3f128cd02c08e55217e159a31cc56be4a5e1e6d888bfb02e5`）；发布目录
  `/opt/cps-novel/releases/505feeaae04ae1a23df3e7f6a27795f4128636f3`。
- 合入已获 Opus 复核的 admin2 一次性建号命令与运维手册（`f036cc4`）、分片枚举真实库用例的 helper 规划器修复（`4329620`），
  并把预生产模板更新为 admin/admin2 双 identity UUID 白名单示例；版本身份升到 0.4.3。无新增数据库迁移或 grants 变更。
- Owner 在后台暂停正式领取批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 后授权部署；部署前核实批次暂停、
  处理中的分片条目为 0、非终态领取意图为 0。在线逻辑备份 `cps-novel-20260925T142332Z.dump`
  （190,409,997 字节，sha256 `45676de334f0d932a50fcea284e0c3071b36c44ae2a734278bca1c3a3fa881c9`）；
  发版脚本 `RELEASE=PASS`，健康接口版本、提交、metadata 与数据库检查通过，postgres 容器未重建。
- 目标机先只改 `APP_VERSION` 0.4.2→0.4.3、`NEXT_PUBLIC_BUILD_VERSION` v0.4.2→v0.4.3（备份
  `preprod.env.bak-20260925T143330Z`）。admin2 建号经预演、创建和同一 request-id 回放，identity ID
  `c5fd40e2-6f1d-4543-8251-27fb5ac941ac`；独立 2FA 尚待 Owner 现场绑定。随后把该 ID 追加到
  `PROMO_CLAIM_USER_IDS`（备份 `preprod.env.bak-20260925T144425Z`），`PROMO_CLAIM_ROLES` 保持空；
  只重建 web，worker/scheduler 容器 ID、创建时间、镜像前后不变。admin 原有 2FA 密文摘要建号前后不变。
- **待完成**：Owner 绑定 admin2 2FA 并离线保存恢复码后，分别核验 admin2/admin 的认证；正式领取批次仍暂停，
  由 Owner 自行决定何时恢复。admin/admin2 真实提交领取验收涉及不幂等上游 getcode，待正式领取结束后每次由 Owner 单独授权。
  生产未上线。
- **部署后配置变更（2026-09-26 00:44 +0900 / 2026-09-25 15:44 UTC）**：Owner 批准在 `haiyue-vps` 的预生产 worker 白名单保留原有项并追加
  `article.generate.v1`、`article.generate.batch.v1`、`article.generate.batch.v2`、`sitemap_refresh`，同时打开
  `FEATURE_SITEMAP_AUTO_REFRESH=true` 与 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=true`。目标机 env 备份为
  `preprod.env.bak-20260925T154337Z`（变更前 SHA-256 `f09c48868e0ad690676f4879b2e1ed877326d51c7bbb4d053beb5aea90ed025f`；
  变更后 `b7d49e35ab19bfa23d558f9952e52f98285ef69573f56bb600cd885686384d1d`）；diff 只有上述三处。只重建 web 与 worker，
  两者 healthy 且仍运行 v0.4.3 已批准镜像；scheduler 与 postgres 的容器 ID、Created 未变。配置断言、健康接口和批次暂停检查通过。
  首次发布、批量生成和 sitemap 文件的业务验收待 Owner 在后台操作后进行；决策与风险见
  [`ADR-PREPROD-ARTICLE-GENERATION-SITEMAP-CONFIG.md`](../adr/ADR-PREPROD-ARTICLE-GENERATION-SITEMAP-CONFIG.md)。

### v0.4.2 —— 已发布到预生产（2026-09-25 03:57 +0800，`RELEASE=PASS`；按接口限速开关关闭）

- 身份：Final SHA `33cd67bd34c34af1d3dbcbf78e6f2636d175c889`，annotated tag `v0.4.2`，开发线
  `integration/v0.4.2-2026-09-25`（基于 `v0.4.1` 收官提交 `a2e08a9`）；镜像 `cps-novel:0.4.2-33cd67b`（linux/amd64，config digest
  `sha256:e8659dacfb8a7ab14aaa7ae3e989b7efbf5d9ac9db9e74d92e9142d1dc5c5037`，归档 sha256
  `802a331c00eabf20172184f8152078108fec353020ccb57714053abaa0a2fbca`）；发布目录
  `/opt/cps-novel/releases/33cd67bd34c34af1d3dbcbf78e6f2636d175c889`；`/api/health` 版本 0.4.2、commit `33cd67b`、
  `metadataConsistency=passed`。
- 合入：`feat/moboreader-per-endpoint-rate-limit` @ `ce9fdc0`（领推广正式修复第 4 阶段·4-A，经 Opus 多轮复核及外部审阅修正：
  `x-ratelimit-reset` 按绝对时间解析、429 冷却不截短、等待后重查中止信号、按响应 Date 换算防时钟偏差、补齐 worker 配置透传）、
  `feat/catalog-position-registration` @ `e2c9002`（第 5 阶段·5-A，目录页位置登记）+ 版本身份升到 0.4.2。
- **已合入但开关默认关闭（等于未上线）**：按接口分别限速（`MOBOREADER_UPSTREAM_PER_ENDPOINT_RATE_GATE_ENABLED` 未配置即 `false`，
  关闭时沿用旧的单一全局闸门 1,500 ms）。部署后核对 worker 容器内该开关为 `false`、旧间隔 1500，发版前检查
  `PREPROD_MOBOREADER_RATE_GATE_CONFIG=PASS enabled=false`。
- **随部署生效、不改执行行为**：`novel_source_item.catalog_position` 新列；目录扫描登记页坐标（可信签名 = 空 name、
  orderType 0、每页 100）；生命周期分片按页排序与提示键；发版前限速配置校验。部署时 97,647 本书的页坐标均为空，
  须跑一次全量目录扫描才会登记。
- 数据库：迁移 `20260924090000_p5a_catalog_position`（加可空 JSONB 列，无索引、不改已有数据）；grants 无变更。
  配置：目标机 `APP_VERSION` 0.4.1→0.4.2、`NEXT_PUBLIC_BUILD_VERSION` v0.4.1→v0.4.2（备份 `preprod.env.bak-20260924T195612Z`）；
  生命周期开关保持开启。发布前逻辑备份 `cps-novel-20260924T195132Z.dump`。
- 部署后另行授权：预生产开启 4-A（先两接口 1,500 ms 跑 24 小时，再降 1,200 ms）；按上述坐标跑一次全量目录扫描（约 977 页）
  登记页码。第 5 阶段·5-B（按页预读与回读）待施工，不在本版。
- 回滚到 `0a25469`（v0.4.1）：应用层兼容（旧代码不读新列，无需撤销迁移）；两个版本变量改回 0.4.1。

### v0.4.1 —— 已发布到预生产（2026-09-24 16:27 +0800，`RELEASE=PASS`；生命周期开关开启）

- 身份：Final SHA `0a2546968d258304990918276b201026c8cccf66`，annotated tag `v0.4.1`，开发线
  `integration/v0.4.1-2026-09-24`（基于 `c4bdcbb`）；镜像 `cps-novel:0.4.1-0a25469`（linux/amd64，config digest
  `sha256:c6336cafb97c0261d8772b6b5fbd4148b6293e3077934988b5f46467f37e2882`，归档 sha256
  `b6fe79a64f699afc8561ef5b593436a9e3a56ac72c50fb4a4b9ad21fde05abf4`）；发布目录
  `/opt/cps-novel/releases/0a2546968d258304990918276b201026c8cccf66`；`/api/health` 版本 0.4.1、commit `0a25469`、
  `metadataConsistency=passed`。
- 合入：`feat/catalog-sync-promo-link-status-filter` @ `42114d9`（待办 B-4，经 Opus 复核；首版因全量 ID 拼
  in/notIn 在 8 万规模报错被打回，改为库内关联过滤并补 3.6 万+ 规模回归测试）+ 版本身份升到 0.4.1。
- **已上线**：目录同步页"推广链接状态"筛选（未领取 / 已领取 / 人工核对中，与书目状态、语种取交集）；领取资格列把
  有码书显示为"已有推广码"、人工核对中的书显示为"人工核对中"；全选提交后枚举与界面筛选共用同一判定。部署后
  以同一口径只读核对：俄语已建立书目 2,978 = 已领取 156 + 人工核对中 0 + 未领取 2,822。
- 数据库：无迁移、无 grants 变更。配置：目标机 `APP_VERSION` 0.4.0→0.4.1、`NEXT_PUBLIC_BUILD_VERSION`
  v0.4.0→v0.4.1（备份 `preprod.env.bak-20260924T082608Z`）；生命周期开关保持开启。发布前逻辑备份
  `cps-novel-20260924T082520Z.dump`。
- 构建备注：公司网络下 Docker 构建两次因 npm 官方源超时失败（依赖层因版本号变更失去缓存），切换网络后第三次成功；
  未改动 `.npmrc` / Dockerfile 等构建输入。
- 回滚到 `8e83da4`（v0.4.0）：代码层面完全兼容（无迁移 / grants / compose 变更）；两个版本变量改回 0.4.0 即可。

### v0.4.0 —— 已发布到预生产（2026-09-24 01:33 +0800，`RELEASE=PASS`；生命周期开关关闭）

- 身份：Final SHA `8e83da49f79f3943a6c6062f5f5b1014a3a72e67`，annotated tag `v0.4.0`，开发线
  `integration/v0.4.0-2026-09-24`（基于 `1da7ed7`）；镜像 `cps-novel:0.4.0-8e83da4`（linux/amd64，
  config digest `sha256:048442eba9011020a74a78940984ebce00449678a14feca17210d5dba3f9c873`，归档 sha256
  `42f857f9ad0b0f19560433bee9fb92c0caf6c3f8f2210358fc53ad467a2e99e3`）；发布目录
  `/opt/cps-novel/releases/8e83da49f79f3943a6c6062f5f5b1014a3a72e67`；`/api/health` 版本 0.4.0、
  commit `8e83da4`、`metadataConsistency=passed`。
- 合入：`feat/promo-claim-lifecycle-v1` @ `537490e`（领推广链接生命周期与自动分片，正式修复第 2 阶段，
  23 提交，逐步经 Opus 复核）+ 版本身份升到 0.4.0。
- 范围四档：**已合入但开关默认关闭（等于未上线）**——生命周期与自动分片全部能力（预生产
  `PROMO_CLAIM_LIFECYCLE_V1_ENABLED` 未设置，发版前检查确认 `enabled=false`）；**已上线（与开关无关）**——
  scheduler_app 最小权限（已核实读不到凭据密文）、发版前生命周期配置校验、已终态旧路径父批次不再显示
  中止按钮、单任务暂停/恢复对生命周期分片返回 409；**进行中**——新渠道凭据录入与验证、开关开启与三级
  真实 UAT（`docs/operations/PROMO_CLAIM_LIFECYCLE_UAT_PLAN_2026-09-24.md`，选项 C），均须 Owner 另行授权。
- 数据库：无迁移；grants 新增 scheduler_app 最小权限。配置：目标机 `APP_VERSION` 0.3.0→0.4.0、
  `NEXT_PUBLIC_BUILD_VERSION` v0.3.0→v0.4.0（备份 `preprod.env.bak-20260923T173306Z`）。发布前逻辑备份
  `cps-novel-20260923T172917Z.dump`。
- 回滚到 `a31a146`（v0.3.0）：库结构兼容；两个版本变量改回 0.3.0；旧 grants 重放去掉 scheduler 新权限，
  对旧代码无害。详见 `docs/governance/development-log.md` 发版记录。

### v0.3.0 —— 已发布到预生产（2026-09-23 23:26 +0800，`RELEASE=PASS`）

- 身份：Final SHA `a31a1468816904920bcf326537426bfe0d4a1ae4`，annotated tag `v0.3.0`，
  开发线 `integration/v0.3.0-2026-09-23`（基于 `a9317e5`）；镜像 `cps-novel:0.3.0-a31a146`
  （linux/amd64，config digest `sha256:f49585279286575994b558eaa6106f4c1112f8fffa440789dba446d42e2b4130`，
  归档 sha256 `de4284d9bc2450a38b4f021eb3e373cc17bac769fa5b278300ab8b8bcd94aeb9`）；发布目录
  `/opt/cps-novel/releases/a31a1468816904920bcf326537426bfe0d4a1ae4`；`/api/health` 版本 0.3.0、
  commit `a31a146`、`metadataConsistency=passed`。
- Owner 裁决（2026-09-23）：版本号定为 v0.3.0，消除"tag `v0.2.0` 已存在、`package.json` 仍是
  `0.1.0`"的版本身份漂移（见 `docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md` §8.2、
  `docs/adr/ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT.md` 的追加说明）。
- 合入：`fix/preprod-approved-open-write-gates` @ `b9fe386`（写闸登记制 + 凭据 blocker 重评估）、
  `chore/release-v0.3.0-prep` @ `f8dc929`（版本身份 + 发版治理）、
  `feat/upstream-call-observability` @ `3dd996c`（上游请求观测）、`23cce42`（X8 镜像清理）、
  `6ac60f3`（CLAUDE.md）、`a31a146`（隔离守卫测试修复）。
- **已上线**：以上全部。**已合入但开关默认关闭**：无。**进行中、未上线**：领推广生命周期与
  自动分片（第 2 阶段，`feat/promo-claim-lifecycle-v1`，开关 `PROMO_CLAIM_LIFECYCLE_V1_ENABLED`
  代码默认 `false`），计划 `v0.4.0`。
- 数据库：无迁移、无 grants 变更。配置：目标机 `APP_VERSION` 0.1.0→0.3.0、
  `NEXT_PUBLIC_BUILD_VERSION` v0.1.0→v0.3.0（备份 `preprod.env.bak-20260923T152433Z`）。
  发布前逻辑备份 `cps-novel-20260923T135245Z.dump`。
- 回滚到 `9728551`：库结构兼容；须先把两个版本变量改回 0.1.0，并先经批准关闭两组写闸
  （旧版发版前检查不认登记制）。详细记录见 `docs/governance/development-log.md` 的发版记录。

## 台账（Registry）

| Version | Date (+0800) | Bump | Summary | Commit / Release | Status |
| --- | ---: | --- | --- | --- | --- |
| `v0.4.5` | 2026-09-26 22:53 | PATCH | 发布后触发试读；sitemap 写闸、手动刷新与 CLI；连接池、详情页与侧栏；7a 仅设计；无迁移/grants 变更 | tag `v0.4.5` → `ff1d2dd7c8d46dba8e9267687eafbb9347b55387`；image `cps-novel:0.4.5-ff1d2dd` | 预生产已发布；实地验收通过；试读不执行；生产未上线 |
| `v0.4.4` | 2026-09-26（12:14） | PATCH | sitemap 候选缓存与 processing 发布漏刷修复；预生产 nginx 模板同步；无迁移或 grants 变更 | annotated tag `v0.4.4` → `205220ebc6f460e85e6fbc8901f592c979c87b83`；镜像 `cps-novel:0.4.4-205220e`；`RELEASE=PASS` | 预生产已发布；两次发布实地验收已通过；生产未上线 |
| `v0.4.3` | 2026-09-25（22:35） | PATCH | admin2 独立身份建号与双 UUID 领取白名单；分片枚举真实库 helper 修复；无迁移或 grants 变更。详见“当前快照” | annotated tag `v0.4.3` → `505feeaae04ae1a23df3e7f6a27795f4128636f3`；镜像 `cps-novel:0.4.3-505feea`；`RELEASE=PASS` | ✅ 预生产已发布；admin2 2FA 绑定与双账号验证待完成；生产未上线 |
| `v0.4.2` | 2026-09-25（03:57） | PATCH | 领推广按接口分别限速（4-A，开关默认关闭）+ 目录页位置登记（5-A，含迁移，不改执行行为）。详见"当前快照" | annotated tag `v0.4.2` → `33cd67bd34c34af1d3dbcbf78e6f2636d175c889`；镜像 `cps-novel:0.4.2-33cd67b`；`RELEASE=PASS` | ✅ 预生产已发布（按接口限速开关关闭）；生产未上线 |
| `v0.4.1` | 2026-09-24（16:27） | PATCH | 目录同步页推广链接状态筛选（未领取 / 已领取 / 人工核对中）与"已有推广码"显示（待办 B-4）。详见"当前快照" | annotated tag `v0.4.1` → `0a2546968d258304990918276b201026c8cccf66`；镜像 `cps-novel:0.4.1-0a25469`；`RELEASE=PASS` | ✅ 预生产已发布；生产未上线 |
| `v0.4.0` | 2026-09-24（01:33） | MINOR | 领推广链接生命周期与自动分片（正式修复第 2 阶段，开关默认关闭、未上线）；scheduler_app 最小权限；发版前生命周期配置校验。详见"当前快照" | annotated tag `v0.4.0` → `8e83da49f79f3943a6c6062f5f5b1014a3a72e67`；镜像 `cps-novel:0.4.0-8e83da4`；`RELEASE=PASS` | ✅ 预生产已发布（生命周期开关关闭）；生产未上线 |
| `v0.3.0` | 2026-09-23（23:26） | MINOR | 预生产写闸登记制 + 凭据 blocker 重评估与一套环境一套凭据；上游请求观测（领推广正式修复第 1 阶段）；版本身份统一到 0.3.0；开发日志发版级 + 发版治理 + 台账 CPS 格式；X8 镜像清理按版本形状。详见"当前快照" | annotated tag `v0.3.0` → `a31a1468816904920bcf326537426bfe0d4a1ae4`；镜像 `cps-novel:0.3.0-a31a146`；`RELEASE=PASS` | ✅ 预生产已发布；生产未上线 |
| 预生产部署 | 2026-09-22（约 15:24） | — | 基础资产补齐 + 合回 PR #8/#9 多语成果（CanonicalTag 1,845 格公开多语译名落库），`RELEASE=PASS` | 镜像 `cps-novel:0.1.0-9728551`；merge commit `97285515b00b2f6d810b2944f8daf1f5aef10ad8`（PR #24，author date 2026-09-22T16:16:46+09:00） | ✅ 预生产部署成功；未打 tag |
| 预生产部署 | 2026-09-22（约 11:35） | — | 预生产首次正式部署：等待服务健康再验证；失败 trap 由可静默失败改为 fail-closed，`RELEASE=PASS` | 镜像 `cps-novel:0.1.0-921119d`；merge commit `921119dc3c6544848aad7d306c2525c7971ed376`（PR #23，author date 2026-09-22T12:02:04+09:00） | ✅ 预生产首次正式部署成功；未打 tag |
| `v0.2.0` | 2026-08-19（01:47） | MINOR | P2-07～P2-12 轮次：publish gate、公开站、缓存失效、sitemap、IndexNow、验收收口 | annotated tag `v0.2.0` → `eb7dd9d60d5cef38c5343fc6cfa383533c0d8570` | 已打 tag、已合入 main；未部署（当时 `package.json` 仍为 `0.1.0`，即已知版本身份漂移，已于 v0.3.0 统一） |
| `v0.1.0` | 未核实（分支持续演进，无法从当前 tip 可靠核实里程碑落地日期） | — | M0–M12 launch parity：后台核心能力、首页轮播、模板/文章/分类、安全设置与公开 SEO consumer 一次性交付 | `feature/launch-parity-operating-surfaces`（本地） | LOCAL_IMPLEMENTED；OWNER_PUSH_GATE；UNRELEASED；UNDEPLOYED |
| `v0.1.0` | 2026-08-06 | — | P1-15：P1 收口报告、风险债务登记与 P2 交接输入包 | `feature/v0.1.0-p1-15-closeout` → `62453d2cf4fb756b4c614d560b4522b3d07df067`（"docs(p1-15): close P1 and prepare P2 handoff"） | WAITING_FOR_GPT_NOTION_AND_OWNER_GATE |
| `v0.1.0` | 2026-08-05 | MINOR | P1-04～P1-14：P1 工程底座、Schema/运维、Worker/Scheduler、Auth/Credential、后台与公共 UI、阅读器、四容器/Health、最终测试和只读审计 | `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668` | P1_LOCAL_COMPLETE；UNRELEASED；UNDEPLOYED |

注：两条预生产部署行的日期取自 Owner 提供的部署执行时间（约数）；对应 merge commit 的
author date（+0900 换算 +0800 后分别为 2026-09-22 11:02:04 与 2026-09-22 15:16:46）与之相差
数十分钟，落在"合并代码 → 实际执行发布脚本"的正常间隔内，作为交叉核验依据一并列出，
不代表两者本应完全相等。`v0.1.0` M0–M12 一行的分支在原始里程碑之后仍有大量后续 commit
（如 2026-09-10 的 i18n 测试），故未采用分支当前 tip 的日期，只标注"未核实"，避免误导。

## 远端同步状态

- P1 最终本地 `main`：`fb8cddbdf7c8ff6b566169eade4a89258e7db668`；
- 本轮只读观察的缓存 `origin/main`：`36c9ca6e8b39ec3041a845bb55d246412ac0ea79`；
- 本地 `main` 相对缓存 remote-tracking ref：ahead 52、behind 0；
- P1-15 未 fetch、未 push；远端服务器实时状态 `NOT_VERIFIED`；
- 未发布、未部署、未执行生产数据库操作。
