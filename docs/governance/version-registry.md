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
> v0.5.7 第二阶段当前快照、版本表、正式手账、完整 G 报告和 24 样本已同步 Notion 并回读 PASS（2026-10-01T16:01:28.183Z），历史版本与模板保留。
> 本文件是仓库内镜像；v0.5.6 当前快照、版本表、正式手账及 v0.5.5 分类遗留了结已同步 Notion 并回读核对。v0.5.7 第一阶段当前快照、版本表与详细记录已同步并回读 PASS（2026-10-01T13:32:26.469Z）（第一阶段历史）；当前第二阶段 E/F/G 已完成，Notion 同步状态按本页最终补记。本文件变更不会自动写入 Notion。

> v0.5.7 第三阶段实际差集已PASS；最终Notion已同步并回读PASS（2026-10-01T20:42:52.094Z），次日备份仍待复核。

## 当前快照

### v0.5.13 —— 已部署正式站（2026-10-09 11:20:43 +0800 / 03:20:43Z；主控直接发布，Owner 授权不经 Codex）

- Final `cc2655b0a3864f6ae6a665f46bad91f15d0a904a`（tree `48427e2d`），annotated tag `v0.5.13`；镜像 `cps-novel:0.5.13-cc2655b`；归档 SHA256 `356b6d7c…8089`。
- 维护 54 秒，迁移 24 条（新增 `novel_effective_tag`，首建 185,270 行，迁移 5.7 秒）；V0513_POST_CHECK=PASS；归属表检查 missing=0 extra=0 changed=0。
- 外部验收：/browse 13,008 本、第 651 页 200；female-audience 9,732 本、第 487 页 200。完整记录见 [发布记录](releases/v0.5.13-preproduction.md)。
- Notion 已同步回读 PASS（2026-10-09T04:39:26Z）：Codex 按主控交接完成当前快照、版本表、详细手账和唯一开发日志镜像；关键事实一致，历史/规则/模板逐字节保留，收据见 `releases/evidence/v0513-release/phase2/notion-readback.json`。

#### v0.5.13 准备快照（历史）


- 唯一基线 `391cb0d361e067b3788e90854a7310d2c872a68a`，来自 `integration/v0.5.13-2026-10-09`。它基于 v0.5.12 收官 `12c08b5`（Final `84af0d7`），并已合入 v0.5.12 收官后的治理补记 `a42873d`。各组合入均经主控复核，含独立变异验证。
- 本版合入：
  - **B-38 根治公开列表 240 本上限**（`fix/b38-db-pagination-v0513@f7998b7`，merge `2f1dc03`；「再议 A」定案记录 `4a7ea47`，merge `6fb21b9`）：
    - 新增分类归属表 `novel_effective_tag`，迁移 `20261009120000_b38_novel_effective_tag`，在迁移内完成首次建表；
    - 迁移由 23 条变为 24 条，业务表由 57 张变为 58 张；
    - grants：web_app、worker_app 读写，analyst_ro 只读；
    - 分类页、/browse、博客列表、导航、站点地图、站内链接改为数据库分页和计数，删除 `PUBLIC_LIST_CAP`；
    - Owner 10-09 定案「再议 A」：在同一事务里直接重算。
  - **B-40 运行镜像只带生产依赖**（`chore/b40-slim-runtime-image-v0513@1442f71`，merge `4b03a06`）：
    - prisma 移入 dependencies；
    - 新增发版门禁 `RUNTIME_IMAGE_DEPS`；
    - 镜像从 1.23GB 降到 952MB，vitest/tinypool 不再进入镜像。
  - **集成修正** `8d94332`：p1-05b、p1-06 运行器的 prisma 前置检查改读 dependencies。
- 没有新环境变量、新任务类型、worker 白名单变化或 nginx 变化。生产 env 只改两个版本字段。发版后先跑归属表只读检查（`tsx scripts/ops/effective-tag-projection.ts check`），差异为 0 即结束。
- 生产依赖 audit 门禁：0 critical，恰好五项 high：@prisma/config、deepmerge-ts、effect、nanoid、prisma。
- 发布方式：Owner 10-09 授权本版由主控（Claude）直接发布，不经 Codex。开发日志与 git 治理由主控完成；Notion 由主控留提示词，交 Codex 同步。

### v0.5.12 —— 已部署正式站、Owner 验收通过（2026-10-09）

- Final `84af0d7ef5ef36b06fa9783c114fe831adab4e13` / tree `0367259156c20d30d2db02026c87827a4914bc97`，原 RELEASE=PASS/EXIT=0，维护51秒；Next16.3.8，health/metadata、五应用/backup、23迁移finished/0回滚、postgres CID、白名单/preflight、错误日志0全部PASS。
- 第一阶段45门禁/33运行器、9,269passed与交接一致、专项skipped0、proxy1742/known0、六Naver探测、23迁移/57表、drift0、B21/矩阵/15变异/真实品牌镜像/三Compose全部PASS。不可变归档331715760bytes、SHA `ed35a77cbefe12930cf166400d9d228bbf2ff98675fe2b909a28f3ebbde0e7ca`，本机/服务器独立SHA与原--load/OCI核验PASS。
- env仅两版本字段改变，其余字节cmp一致，两个任务白名单/nginx/业务开关不变，无新迁移；B两次READ ONLY在途0、备份SHA/restore-listPASS。
- 自动F PASS：Naver200/67bytes/SHA一致无跳转；en189works/2/10、ko H1소설: 여성향、es译文、browse240works。共10外部请求全经代理，分类3次。Owner 2026-10-09 本会话确认“验收通过了”，F.4/F.5 按 Owner 确认通过；71本待运营生成后核对；验收补记Notion同步回读PASS（2026-10-08T17:03:49.589Z），未代生成或刷新Sitemap。
- 生产audit0critical/指定五high；全量2critical/12high/1moderate。裁定：vitest/tinypool**在镜像里但运行时不加载，与 v0.5.11 相同，B-40 在 v0.5.13 处理**；纠正第一阶段“不进镜像”，Final/归档不重做。B-38数据库分页/全量计数也排v0.5.13。
- 本轮五组合入、公告、Owner译文和240上限决策见[发布记录](releases/v0.5.12-preproduction.md)；annotated tag固定Final、原生成CHANGELOG、唯一发版日志及ADR完成；治理提交702dc7e/tag已推送回读PASS，Notion同步回读PASS（2026-10-08T16:52:10.946Z），原历史/规则/模板逐字节保留。

### v0.5.12 第一阶段准备快照（历史；后续部署及审计裁定已在上方更新）

- 唯一基线 `2763eeddcb3aeaa0719bdeab0ba12a4c669c6e28`，来自 `integration/v0.5.12-2026-10-08`，基于 v0.5.11 收官 `274b990`（Final `eb40756`）；主控已逐项复核（含独立变异）并集成。本次仅升版、门禁与发布，不开发功能。
- 五组合入：分类页运营需求 `feat/category-page-ops-v0512@0ceac1d`（merge `87bfb79`）；新文章过短网址补词 `fix/article-short-slug-suffix-v0512@fa4cecf`（merge `c379da2`）；Next/Naver/任务中文名 `chore/v0512-next-naver-tasklabel@c111eb2`（merge `203a5a6`）；短语分类名文案 `fix/category-copy-phrase-names-v0512@82c87c0`（merge `89bbb83`）；第三方验收译文 `fix/category-copy-gpt-acceptance-v0512@e8fa978`（merge `2763eed`）。
- Next、@next/third-parties、eslint-config-next 为 16.3.8；包含 Naver 验证文件与「畅读收益同步（changdu.revenue_sync.v1）」类型显示。无新迁移、grants、nginx 或环境变量变化，仍为 23 条迁移、57 张业务表；生产 env 仅第二阶段修改两个版本字段。
- Owner 10-08 决定分类页标题加 Novels（含 H1/title/分享/面包屑），有意偏离 CPS 并推翻 09-30 决定；作品数显示可浏览总数且 /browse 同步；过短网址仅新生成时追加本地化词，正常及已有网址不变；追加两处短语分类名文案修改。
- 第三方验收：网址后缀 15 词全部 PASS；分类三条文案 45 条中 32 PASS、13 NEEDS_CHANGE。Owner 10-09 保留 en 三条以贴近运营要求与搜索词，ru/th/ko/zh-Hant 十条照验收修改。可浏览 240 本上限源自 08-18 P2-08 Cursor 实现，Claude 复核登记但未写触发条件；B-38 根治排 v0.5.13，以数据库分页并计算总数。
- 生产依赖 audit 门禁为 0 critical、恰好五项 high：@prisma/config、deepmerge-ts、effect、nanoid、prisma；其他 high/critical 必须停止。全量 audit 中 vitest/tinypool 开发依赖 critical 单列；原“不进镜像”判断已被10-09主控裁定纠正：在镜像里但运行时不加载，与 v0.5.11 相同，B-40 在 v0.5.13 处理。
- 独立工作树 `release-v0.5.12`，分支 `release/v0.5.12-2026-10-09`；先本地提交六文件身份，再串行执行完整门禁与 33 个运行器（仅排除 p1-12）。全绿后推送 GitHub，构建并本地核验 linux/amd64 不可变归档；Final/tree 和归档身份以第一阶段实测交付为准。
- 第一阶段不连接运维主机，归档交付后停止；第二阶段须 Owner 单独授权，仅限 haiyue-vps 低流量时段。正式 tag、生成 CHANGELOG、发版级开发日志与 Notion 收官待部署验收后完成；当前为已合入、尚未部署。

### v0.5.11 —— 已部署正式站（2026-10-08 17:15:56 +0800；Owner 操作项目待确认）

- Final `eb40756416b186ca4b293ff57e24026af78cf4f9` / tree `b98d07a62c98196593a625c5cedcd2344a8e9220`；image cps-novel:0.5.11-eb40756，linux/amd64，归档331746262bytes / SHA256 `8bc4ac3787b801e8dab4744d4265b9971fd6fadd0e2a395f45923aeebe21291d`，服务器独立重算与原verify --load/OCI身份PASS；源码current/HEAD/tree干净核对通过。
- 原RELEASE=PASS/EXIT=0；维护17:15:08–17:15:55 +0800，共47秒，新迁移75.079ms。23迁移finished/0rolledback、收益四表存在、四grants点位t/f/t/f、五应用与backup健康、health0.5.11/Final/metadata passed，postgres CID与nginx public哈希不变。
- 十项范围及来源详见[发布记录](releases/v0.5.11-preproduction.md)。分页焦点、RTL、试读脱敏、模板Key/博客卡片、空语种隐藏、Sitemap清理、桌面分类栏、安装器修复、账号级收益看板、IndexNow透传均合入；博客/Turnstile/IndexNow仍关闭，nginx安装器本版未安装。主控交叉类型修正4189aa6也包含。
- env改前全值符合提示词，备份preprod.env.bak-v0511-20261008T091454Z；仅两个版本字段与主WORKER_TASK_ALLOWLIST追加changdu.revenue_sync.v1，余字节cmp一致/轻量通道不变；不加REVENUE_VIEW_*或ADMIN_LOGIN_TURNSTILE_*。启动白名单主包含新任务/light不含/invalid空，web默认super_admin+2FA，三服务IndexNow双false。
- 第一阶段44门禁/33运行器、553files9022tests、专项skipped0、strictproxy1736/known0、23迁移/57表、drift0、15变异、真实品牌镜像与三composePASS。audit0critical、批准六high，source-map-js全1.2.2、Next16.3.7。Owner10-08安全公告放行本版、v0.5.12升级16.3.8。
- F2cs200/noindex/菜单hreflang隐藏、F3ar lang/dir与分类真链接、F4分页页脚前PASS；F5博客写闸关闭跳过、不保存模板。现有35分片小说28813/章86168逐语种等于B快照，较旧版增加68/204来自部署前新发布；cs不在mainpage。10本机外部请求经指定代理，六服务自部署错误/权限/token模式0。
- **待Owner确认**：F1后台刷新Sitemap/B33清理日志及目录下降（基线390/411.5M，当前仍390，无新cleanup）；F3电脑分类栏单行箭头目视；F6super_admin+2FA同步09-20～10-08并与上游网文日报对数（当前0任务/0批次，未冒充成功）。不代Owner点击，不阻断其余验收，F7不在授权内。
- Owner10-08决定PN09连入口隐藏、PN16单行箭头、PN04现状、看板super_admin、主任务手动无定时。viewport-fit=cover不做；HSTS稳定一周后另行用新安装器；CPS收入可能混入小说已登记待办。本次不动证书/DNS/NAS/推广批次/业务开关，不重建postgres；回滚须另批SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES，先恢复env并查收益在途。
- annotated v0.5.11固定Final、原生成CHANGELOG、本台账与唯一日志本地完成，治理提交47b89f3c9efa4dbc9da41511880a03a111deda33及tag已推送回读PASS，Notion同步并回读PASS（2026-10-08T09:25:42.103Z），历史规则与模板保留；保留全部历史及模板。

### v0.5.10 —— 已部署正式站（2026-10-08 01:11:28 +0800；Owner 操作项目待确认）

- Final `7f955106a82f8dff82568e305ea35f1a68b8c934` / tree `6e3b5733ff0ee34cac9b5eca46c6f1c95356d504`，image `cps-novel:0.5.10-7f95510`；批准归档SHA256 `546a81da9b0d42d2cd24604a4e933a87d5f6f4fbefc562e6adcc44ef210a43d3`服务器重算与原verify --load通过。
- 原RELEASE=PASS/EXIT=0，维护01:10:39–01:11:27 +0800，48秒；health0.5.10/Final/metadata passed，五应用健康，postgres CID/22迁移/nginx public哈希不变。env仅两行版本，其余字节cmp一致；无业务开关变更。Turnstile已合入但关闭，secret=/dev/null、wc0。
- 八项范围与来源见[正式发布记录](releases/v0.5.10-preproduction.md)。2026-10-07正式开放后的分类404/死链、分页SEO矛盾、阿语轮播、设置误触代码已在pulsenovels.com生效。运营反馈源2026-10-07《小说站问题反馈》；没有功能开发或新迁移/依赖/grants/nginx改动。
- Sitemap任务5d361608完成，18.887秒，35分片/115163网址；14语种小说28745、免费正文章节85964与部署前SQL逐项一致，en分类1788→72；10个不同分类HEAD全200，外部经代理累计20次。第一页13hreflang不变；分页/分享/en-ko alt/阿语HTML/worker四样本通过。
- Owner后台登录2FA、阿语浏览器切换、手机设置重置、后台搜索/只读模板Key待确认（未保存模板）；不阻断技术发布。Git annotated tag/原生成CHANGELOG、本台账和唯一正式开发日志已完成本地登记；Git推送回读已完成，Notion同步并回读PASS（2026-10-07T17:28:41+00:00），规则/历史/模板保留。
- v0.5.11：PN-06翻页位置、PN-10弹窗焦点、PN-03/PN-02遗留RTL/层级。无回滚授权，SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES须回滚时另批。

### v0.5.9 —— 已于2026-10-07切换正式域名对外开放；原预生产E/F/5b/5c/5d PASS

- 唯一基线 `59e84efa85756c0e957dcbf63f62b32aa5d7fca2`，基于 v0.5.8 收官 `306edb4`；已复核集成，本次不开发功能。上一轮基线 549760f 的本地候选 8772afd 在 audit 发现第六项 high 后停止、未推送，已按 Owner 要求丢弃工作树与本地分支，未 rebase/cherry-pick。新建 `release-v0.5.9-redo` / `release/v0.5.9-2026-10-07-redo`，全新 npm ci、Prisma generate、真实 node_modules，全部门禁从头重做。
- 领推广生命周期修复：其它未完成批次中的书照常入队并记提示数；所有选书方式排除已有推广码或人工核对的书；ADR D4 仅检查本条是否尝试及本账号是否有 prepared / claim_retry_blocked 意图；后台展示新计数、保留历史原因码。worker 执行时三道防重复检查未改，旧路径不变；Owner 2026-10-06 已确认 D4 收窄。scheduler_app 新增 side_effect_intent.status 列级 SELECT，由部署脚本重放 grants 生效。
- 上线切换第二段证据及异地恢复演练暂缓、worker 健康采样 ADR 已并入（d8f3321，仅文档）；B-8/B-31 将此前未运行的 11 个真实库测试文件接进运行器并增加禁止整文件跳过断言；两处过时夹具修正，产品代码无改动。
- 目录同步页新增上架时间筛选、排序与显示；sourceCreatedFrom 使用北京时间绝对日期快照，列表、预估与 worker 同口径，批次预估补认推广链接状态筛选。站点地图文章按 id 每 500 条加载，公开分类 SQL 每 2000 本分块，试读候选同样分块，修复组合外键 stack depth 与绑定参数规模上限，输出规则不变。
- 后台跨页全选支持批量发布父子任务（最多 5 万篇、每 200 篇拆子任务），复用原发布流程，支持暂不抓试读、整批控制与收尾一次站点地图刷新。部署时只在 WORKER_LIGHT_TASK_ALLOWLIST 追加 article.publish.batch.v1 / article.publish.v1，主通道不改；IndexNow 出站开关透传缺口 B-34 未修，打开出站前须另行处理。
- Owner 2026-10-07 决定在发版前修复 GHSA-68fv-2mgg-jv7q：source-map-js 1.2.1 → 1.2.2（ab7541d）。新基线仅 package-lock.json 该包一处变化，package.json 不变，无 overrides 或其它依赖变化；本轮 npm ls --all 必须全部 1.2.2，audit 必须 0 critical / 指定五项 high，不得包含 source-map-js。
- 无新迁移（仍 22 条）、无新环境变量或 Compose 变化；grants.sql 仅上述列级授权变化；Next 固定 16.3.7。先提交与 v0.5.8 相同六文件版本身份，再串行完成 32 个运行器及全部指定门禁，通过后推送、构建核验 linux/amd64 不可变归档。本版合入内容已由原脚本部署，正式域名仍未开放，验收全部完成。
- 第一阶段仅本地/GitHub；第二阶段已获 Owner 当前会话独立授权，仅连接 haiyue-vps。试读门禁0在18:15:32UTC任务/条目均归零；保留 rehearsal，不改 nginx、证书、DNS、NAS 或业务开关，不触发领推广或 Sitemap 刷新。
- 交接说明批次 eba8f359 已由 Owner 于 2026-10-06 中止，历史只读 A 为 cancelled 50 + completed 3 + completed_with_errors 18 = 71，B/C/D 均 0；这是来源交接；第二阶段部署前已重新只读核对，A–D符合相同预期。回滚目标 v0.5.8 Final `0329b113bcfefb35a7654bfd311d2e0a6095ed25`，先恢复轻量 allowlist 并确认无在途批量发布或尚未完成枚举的上架时间筛选批次，不执行 down migration。
- 第一阶段 PASS：Final `6af0b2e5c79db932c4754a43580eed3729bd0334`，tree `9894abdff08bf348a45aad025879c681ed5215b2`，image `cps-novel:0.5.9-6af0b2e`（linux/amd64，Next 16.3.7，source-map-js 全部 1.2.2）；归档 331,281,258 字节，SHA256 `524379f2db0f0654258768b33b8966c244faa72b7d59aa92699f746ca4b31146`；原消费端 VERIFY=PASS。tsc/lint 0 error、全量 511 files / 7900 tests、32 运行器、22 迁移/drift 0、strict proxy 1646/0、完整 B21、nginx 矩阵、公开切换变异、真实品牌镜像与三套 Compose 全 PASS；audit 恰好指定五项 high / 0 critical。详见 [发布记录](releases/v0.5.9-preproduction.md)。后续文档提交不改变 Final；annotated tag v0.5.9固定Final，原生成CHANGELOG及正式发版级开发日志已完成；Notion同步读回PASS（2026-10-06T19:05:00.415Z）；Git治理提交/tag已推送回读PASS（8a4a4da9815bcacc0983d3624b1ba986f0ca7d1d）。

- 第二阶段原 RELEASE=PASS / EXIT=0：18:22:33–18:23:30 UTC，57秒；完整 Final 不变，PREPROD_APPROVED_MIGRATION=YES，22迁移与grants重放PASS。服务器归档SHA256与批准一致、原VERIFY --load PASS；备份681,522,357bytes/restore-list PASS；env备份后仅两版本号及轻量白名单三行，其它字节不变。health0.5.9/Final、五应用及postgres健康，postgres ID不变、错误日志0、backup ok、Next16.3.7；status列权限f→t/response_shape仍f。
- 第二阶段全部验收PASS：后台F5/5b/5d在Owner登录后只读通过；Sitemap系统04:00JST兜底任务069eee5b成功，21.432秒，35分片/118537网址，14语种小说28981/免费章节85964逐项与部署前计数一致。部署后54001=0；收官前五应用/postgres健康、近5分钟错误0。没有触发可选UAT。
- 发版治理：annotated tag固定Final、原生成CHANGELOG、台账、唯一发版级开发日志已完成；Notion同步读回PASS（2026-10-06T19:05:00.415Z）；Git治理提交/tag已推送回读PASS（8a4a4da9815bcacc0983d3624b1ba986f0ca7d1d）。

### v0.5.8 —— 已部署密码保护预生产，E/F/G PASS（2026-10-05 21:27:39 +0800）

- 部署完成 2026-10-05 22:27:39 JST；仅 haiyue-vps，原 release.sh RELEASE=PASS / EXIT=0，总墙钟58秒。Final `0329b113bcfefb35a7654bfd311d2e0a6095ed25`，tree `1f897777caeb6e9d667baf794fa1322e5070bba6`，image `cps-novel:0.5.8-0329b11`，linux/amd64 / Next16.3.7。annotated v0.5.8 固定 Final，CHANGELOG 按原生成器更新；治理提交 `f68712f2aafda1460643a6043193c73a4787a409` 与 tag 已推送并回读；后续治理提交不改变发布身份。
- 归档331,195,464bytes，SHA256 `3522fe62836e5a4fa2befb818f87efb8568b76c37509f6cb8a62efc7e333816c`；目标机离线/载入/descriptor身份 PASS。在线逻辑备份283,219,340bytes，restore-list PASS。完整身份、原始EXPLAIN、采样和env diff见[发布记录](releases/v0.5.8-preproduction.md)。
- 第一阶段40项全 PASS：typecheck0，lint0 errors/19warnings，498files/7674tests passed、453tests skipped、无failed/Unhandled；28运行器，22迁移/双向schema及字典drift0，worker索引7passed，strictproxy1646/known0，B21六组一致，build/brand/nginx/变异/三Compose通过；audit0critical/指定5high，原EXIT1保留。
- 第二阶段新增1迁移21→22，只在维护模式由migrate-approved执行，135.395ms，22条全finished/0rolled_back；两部分索引定义一致。health0.5.8/Final、五应用与postgres健康、postgres容器ID不变、backup ok/BACKUP_TIMER=RUNNING、近五分钟错误日志各0。env备份后只改两版本号，其余字节/标签开关/写闸/白名单不变。
- F重点 PASS：部署代码原心跳SQL两表均Index Only Scan Backward，无Seq Scan；Execution0.126ms（当前无非空心跳条目，不声称冷缓存压测）。后台预热0.053367s，再每10秒采3次0.033381/0.041052/0.035007s，均200/workerStatus=ok/expiredLocks=0；公开worker health404。
- G PASS：旧站匿名401、带密码200/noindex，ko首页/sitemap/从sitemap取得ko小说均200；新域名404；nginx前后文件hash完全一致，rehearsal/worker_connections4096保持。未改nginx/证书/DNS/NAS/业务开关，未刷新sitemap或另写业务数据。本版没有第三阶段，领取批次仍paused，仅Owner恢复。
- 已生效范围仅密码保护预生产，正式域名未开放；worker部分索引/倒序查询/interval反序列化修复已部署。NAS GNU/BSD stat及LC_ALL=C已使用为原交接说明，本轮未连NAS。Owner决定开放延至书籍同步和内容充实后，异地完整恢复演练暂缓，故障优先VPS本机备份回滚；B-30撤销。证书/rehearsal/worker_connections已完成，外部压测延至确定开放日期前，证据ops/cutover-stage2-2026-10 @b4afb67；详见[运营边界ADR](../adr/ADR-V058-RELEASE-OPERATIONS-BOUNDARY.md)。
- 版本台账、正式开发日志、发布记录及Notion第二阶段完整交接稿已写；Notion第二阶段已同步回读 PASS（2026-10-05T22:36:40.438000+09:00），第一阶段历史保留。自写包装器两处已修正，记录完整，仓库部署/E/F/G无失败。回滚目标v0.5.7 Final `bbb06253828d9fd338f0ece1749c2020d8ec4679`，兼容批准由Owner在回滚时给出；不down、不删索引、不改rehearsal。

### v0.5.7 —— 预生产 E/F/G PASS；第三阶段仅 en 完成，实际差集 PASS；次日备份待复核

- 部署 2026-10-01 22:35:53 +0800 / 23:35:53 JST；Owner 2026-10-02 转交主控 Opus F.1 裁决后完成第二阶段。仅 haiyue-vps；Final `bbb06253828d9fd338f0ece1749c2020d8ec4679`；tree `ae80be834ebb71c73487b630f76b2acde557c12d`；image `cps-novel:0.5.7-bbb0625`（linux/amd64，Next 16.3.7）。annotated `v0.5.7` 固定 Final 已推送，CHANGELOG 按生成器更新；治理提交不改变身份。
- 新基线 ab2d600；旧候选 43fcfaa 作废未推送。第一阶段从新工作树全部重跑：tsc 0、lint 0 errors / 19 warnings、496 files / 7642 tests passed、0 failed / Unhandled；27 运行器、21 迁移/drift 0、strict proxy 1646 / known_findings=0、B21 en 331.9 MiB、build/brand/nginx/变异/Compose/归档全 PASS、Docker TS2307=0；audit 0 critical / 指定五项 high。归档 331,482,934 字节，SHA256 `2d803e13d89e93d360059661f18e30d093ee63428ffd26fe941ed304b129c3a0`。
- 原 release.sh `RELEASE=PASS / EXIT=0`，E 及本轮复核通过：health 0.5.7 / Final、五应用及 postgres healthy、postgres ID 不变、21 迁移、backup ok、核验时各服务近五分钟错误日志 0。env 备份后仅改两个版本值，其它字节/标签配置/写闸/白名单不变。
- F PASS：按 [验收 ADR](../adr/ADR-V057-PREPRODUCTION-ACCEPTANCE.md)，nginx 外层 404/162、404/162、400/166 是既有防护，B-24 以直连 web 三者空 body 404 验收；实际两层证据保留。正常 ko 首页/sitemap 小说/章节/两个图标全部 200，后台正常登录/2FA/退出和未登录跳转通过。包装器漏识别 Next 流式 HTML 跳转已修正重跑。
- G 2026-10-02 00:52:43 JST 完成：web_app / READ_ONLY，15 语种原报告累计 38.977 秒，含抽样导出全流程 56.307 秒；扫描 80,006 / 手动跳过 0。仅 en 583 本套话、133 本集合变化、126 本失去全部自动标签，预计移除 133 / 新增 0，另 1 本仅评分变化；其余 14 语种变化 0。8 条非零句式各三本，共 24 本样本，见 [完整报告](releases/v0.5.7-impact-report.md)。Owner 已审阅并裁决保留 bp-008；原规则和报告不变。
- en 全部 source=auto 前快照 `/opt/cps-novel/backups/v057-auto-tags-en-before-20261001T155201Z.tsv`，50,120 行 / 3,708,880 字节，SHA256 `3a4b145db66e185671499ff0c24b79a505c495b7e3222ac1e96ad8e149656da7`；另存全部英文书目 updated_at 与标题/简介指纹。完整三个 apply authority、原报告文件及 SHA256 见报告，33 文件独立校验 PASS。
- B-24/B-21/B-23 已在密码保护预生产生效，正式域名切换后才对公网可见。Alpha/chef 按 Owner Final 不改继续观察；套话样本已采集，范围审阅由 Owner 决定。批次保持 paused，由 Owner 恢复；执行前定类 pending/processing 各0。第三阶段仅en已完成且实际133/0/133/126差集PASS；数据恢复需独立授权。
- 本地台账、发布记录和同一次正式发版开发日志更新完成；Notion 同步与回读状态见本页顶部补记。回滚目标 v0.5.6 Final `8625021d064f17d37e610d6038023c3ffecd9408`，用旧目录和 `/opt/cps-novel/shared/env/preprod.env.bak-v057-20261001T143450Z`；兼容标志必须 Owner 在回滚时明确批准。详见 [发布记录](releases/v0.5.7-preproduction.md)。

- 第三阶段最终：第三阶段仅 en 已完成且差集 PASS：任务 `51e9d41e-afb3-4351-a085-63d2e865b184`，43,431 条全部成功，失败 0、skipped(stale) 0（原因分布为空），2026-10-02 05:16:10 JST 完成；实际移除 133 / 新增 0 / 涉及 133 本 / 126 本失去全部 auto，与原 G 报告一致。公开可见自动标签 0 → 0，报告后标题/简介指纹变化 0；批次 paused，业务开关不变。次日备份只读复核安排于 2026-10-03 06:00 JST。
- after49,987对，SHA256 `5ffa5ef55678fff07b7504803355fc10270b6bc1abffc610a9f104a576ae597f`，两份快照及差集保留。本任务新增43,431条分类记录；DB +197.664MiB、WAL累计 +2479.407MiB（LSN +2512MiB），均为全库测量窗口增量。证据见 [最终验收](releases/v0.5.7-reclassification.md)。

### v0.5.6 —— 已部署预生产（2026-10-01 03:38:32 +0800；E/F/G PASS，已收官）

- 新集成基线 `9274c4aadf7738914e1ddc1ab4167b33f636588e`，基于 v0.5.5 收官 `d38d7c3`，已由 Opus 复核、集成；发布分支 `release/v0.5.6-2026-10-01-redo`。上一轮本地 Final `a98cd9c` 因新增安全公告作废、未推送，工作树与证据保留；本轮全新 npm ci、重新运行全部门禁，不沿用旧结果。Final `8625021d064f17d37e610d6038023c3ffecd9408`，annotated tag `v0.5.6` 固定于 Final；镜像 `cps-novel:0.5.6-8625021`（linux/amd64，Next 16.3.7），归档 SHA256 `f5d0e127248ac3a70f12e4432047972ed07b2ce6daca7755dcac9028327ebf32`；后续文档提交不改变部署身份。
- 运营《小说站调整V2》第二轮：后台站点设置新增 Yandex 站长验证码和 Metrica ID；只在公开站且填写有效值后输出。站点地图排除无公开内容语种、categorypage 并入 mainpage（旧路径 308）、免费可索引章节加入 novelpage；B-27 docker bash:5.2 写闸测试单独 60 秒超时已修。
- 新迁移 `20260930100000_site_setting_yandex` 为 site_setting 追加两列，迁移总数 20 → 21；字典和 web_app 两列 UPDATE grants 已同步。没有新环境变量及 Compose 改动。
- B-29：Owner 于 2026-10-01 决定将 Next.js 16.3.3 → 16.3.7 安全升级并入本版；@next/third-parties、eslint-config-next 同步升版，lockfile 13 个同系列包变化。GHSA-vcvr-r3jv-pc5j 为 next/og ImageResponse RCE；主控核实海阅只在两个图标使用常量输入，评估不可利用，仍升级修复。本次不开发功能、不再修改依赖。
- 第一阶段仅本地串行门禁、GitHub 推送及 linux/amd64 归档构建，不连接运维主机，交付后停止。第二阶段已获 Owner 单独授权并部署，仅限 haiyue-vps；env 仅改两个版本变量，自动标签值原样保留，由 release.sh 的 migrate-approved 执行迁移及重放 grants。本版没有第三阶段。
- 本轮 tsc、lint（0 error）、全量 489 files / 7,555 tests、build、drift 0、全部 27 个运行器、nginx 矩阵、公开切换变异、品牌图、Compose identity 和三套 Compose 全部通过；x9 两场景 migrations=21，proxy next=16.3.7 / 1,530 探针。生产 audit 按 Owner 明确五项清单验收：0 critical、5 high，指定 GHSA 消失；归档消费端 VERIFY=PASS。详见 [v0.5.6 发布记录](releases/v0.5.6-preproduction.md)。
- 第二阶段 `RELEASE=PASS / EXIT=0`，health 0.5.6 / 完整 Final；五应用 healthy、postgres 容器 ID 未变、backup health ok、核验时近五分钟错误日志 0。线上 21 条迁移全部 finished / 未 rolled_back，新列定义、空值及 web_app UPDATE 权限正确；env 备份后仅改两版本号，写闸和标签配置原样保留，批次 paused。Next 16.3.7、两个图标 200 image/png。公开首页、ko 小说和后台实际首页均无 Yandex 输出，设置页两个输入框可见且为空，旧 categorypage 308 正确；未保存设置。
- 不填写 Yandex、不触发站点地图刷新、不改基础设施或业务开关。Owner 后台刷新成功后已只读完成 G：总索引仅两个 ko 分片，mainpage 7 条（首页和 6 个带 /ko/ 的分类）、novelpage 60 条（15 小说 + 45 章节），en 404，抽两章 200 且 HTML 无 noindex；预生产 X-Robots-Tag 保护头保留。本版 E/F/G 通过；仅密码保护预生产生效，正式域名切换后才对公网可见，Yandex 仍需运营填写。
- 回滚目标 v0.5.5 Final `b44b9e2008f66f180fde8b194f5538ebfaf32849`；新增两列对旧版兼容，但 `SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES` 必须由 Owner 在回滚时明确批准。使用旧版不可变目录与本次 env 备份，不执行 down migration、不删列、不恢复数据。

### v0.5.5 —— 已发布到预生产（2026-09-30 19:46:54 +0800；Owner + Opus 验收 PASS）

- 集成基线 `5cda72ad391a3f7820b5aa6c2fba09539e15dff6` 经 Opus 复核、集成；语种切换提示经 GPT 两轮第三方验收（PASS_WITH_FIXES → 修订后 PASS），TKD 新文案另经 GPT 验收通过。Final `b44b9e2008f66f180fde8b194f5538ebfaf32849`；发版分支 `release/v0.5.5-2026-09-30`；后续文档提交不改变部署身份。
- 本版发布语种切换、真实 404 与跨语种链接对齐 CPS，前台 TKD 与 15 个默认模板 SEO 标题资产对齐，Next.js 16.3.3 安全升级，非英文模板最高已启用版本兜底，以及同书并发创建唯一冲突收敛。无新迁移、环境变量或 Compose 改动，不做功能开发。
- 第一阶段 tsc 0、lint 0 errors / 19 warnings、全量 486 files / 7,485 tests 0 failed / 无 Unhandled，生产 build、27 个运行器、静态/live 字典与迁移 drift 0、nginx 矩阵、公开变异、品牌图、三套 Compose 与身份核验均通过。首次 Compose identity 因遗漏本地 helper 缺变量，加载既有 helper 后重跑通过。proxy 1,530 条 0 失败，4 条 B-24 KNOWN_FINDING；B-25 追踪警告和 B-26 audit 项已记录。
- 镜像 `cps-novel:0.5.5-b44b9e2`（linux/amd64），归档 331,232,586 字节，SHA256 `944bedab2d7d950591b435bc110074f57014cd4605e9e5217317dac1f56faa47`；离线与本地载入身份核验通过，镜像内 Next 16.3.3。第一阶段构建后，第二阶段已按 Owner 单独授权部署 haiyue-vps；详细身份和日志见 [v0.5.5 发布记录](releases/v0.5.5-preproduction.md)。
- 第二阶段仅部署 haiyue-vps，站名原值 PulseNovel；前后批次 paused、运行领取任务与定类在途计数 0，线上 20 条迁移与 Final 一致。在线备份及 restore-list、目标机归档与载入身份核验通过；env 备份后仅改两版本号，标签开关、写闸、白名单和其它 env 字节不变。PREPROD_APPROVED_MIGRATION=YES 下 RELEASE=PASS / EXIT=0，health 0.5.5 / Final，五应用服务及 postgres healthy、postgres ID 未变，备份 ok、核验时近五分钟错误日志 0，容器 Next 16.3.3。
- Owner 于 2026-10-01（JST）提供已登录 Chrome 实测、主控 Opus 截图核对结论：第二阶段全部通过。404 页品牌及韩语正文正常，标题 `찾을 수 없음 | PulseNovel`；纠正此前 HTTP 解析未读到页头站名的判断。小说和章节选 English 均跳至无前缀英文首页，按钮下方 ko fallbackToast 与 GPT 验收文案逐字一致；菜单仅 한국어 + 始终保留 English；浏览页 title `전체 작품 | PulseNovel`、15 本。
- 本版新布局仅 404，Owner Chrome 375px 手机截图已确认、图片由 Owner 另附；不冒称 Codex 已收到或保存图片文件。首页 absolute / 404 本地化标题按 Owner 收官裁决接受；博客原开关 false，正常列表未启用，不为验收改开关。跨语种同书直达目前无公开数据，由单测覆盖，首次出现数据时补实测。详细口径见 [ADR](../adr/ADR-V055-PREPRODUCTION-ACCEPTANCE.md)。
- 分类 sitemap 遗留已于 2026-10-01 12:29:42 JST 在 v0.5.6 G 节只读验收了结：Owner 刷新后 categorypage 已并入 ko mainpage，6 个分类网址全部带 /ko/category/，无需等待原 2026-10-02 04:35 JST 计划。证据见 v0.5.6 发布记录；未主动刷新或创建任务，未移动 v0.5.5 Final/tag。
- 第三阶段已按 Owner 单独授权完成，仅限 haiyue-vps；apply 时间 2026-10-01 00:47:21 +0900（台账 2026-09-30 23:47:21 +0800），approver `admin`，审计 `516113`。15 条 update、0 create，仅 metaTitle 与 updated_at 改变；再次 dry-run `changes=[]`，行数 15、version 全部 1。备份 `/opt/cps-novel/backups/v055-article-template-before-20260930T153857Z.json`（15 行 / 5039 字节，SHA256 `1d03cc22d0a8154e1c2ff4f9dfad65835552bb998afe7489e81b40e711ea1106`）；已发布文章 TKD 回填不在范围。第三阶段 Notion 当前快照、版本表与追加记录已同步并回读 PASS（2026-09-30T15:55:50.203Z）。领取批次由 Owner 恢复。回滚目标 v0.5.4 Final `0260d8d89c8aba83ba7eb8887ae94461489a927c`，使用原发布目录和 `/opt/cps-novel/shared/env/preprod.env.bak-v055-20260930T114510Z`，不重建 postgres；模板恢复另行授权。
- annotated tag `v0.5.5` 固定于 Final，已生成 CHANGELOG，正式发版开发日志与版本台账已更新；Notion 当前快照、版本表与正式手账已同步并回读一致。收官记录时间 2026-09-30 23:22:25 +0800（JST 2026-10-01 00:22:25 +0900）。预生产已生效，Next 16.3.3 正式切换前置条件满足；公网可见仍须正式域名切换。

### v0.5.4 —— 已发布到预生产（2026-09-29，`RELEASE=PASS`）

- 集成基线 `c4ea5bb85721cc68df7310b3a17f59b156f4f909` 经 Opus 复核，译文经 GPT 两轮第三方验收（第一轮 PASS_WITH_FIXES，修订后增量 PASS）。Final `0260d8d89c8aba83ba7eb8887ae94461489a927c`，annotated tag `v0.5.4` 固定于 Final；镜像 `cps-novel:0.5.4-0260d8d`（linux/amd64），归档 SHA256 `acc69c44b4271e06562d1b606f3391d4b6a95caa15008f641bb243168048197f`。
- 本版仅发布运营前端与 SEO 优化第一轮，含 Owner 于 2026-09-29 裁决的 D-12 章节列表锁定折中方案。无新迁移、环境变量或 Compose 改动，不开发新功能。
- 第一阶段本地 tsc、lint（0 error）、全量 474 文件 / 7,133 测试、build、22 个真实库运行器、nginx 矩阵、公开切换变异、品牌图及三套 Compose 全部通过；迁移与字典 drift 0。第二阶段经 Owner 单独授权，仅部署 `haiyue-vps`：部署前批次 paused、定类任务无 pending/processing，线上 20 条迁移与 Final 一致；新鲜在线备份及 restore-list 通过。
- 目标机 env 备份后只改两个版本号；标签开关、写闸登记与白名单原样保留。`PREPROD_APPROVED_MIGRATION=YES` 下 `RELEASE=PASS`；health 为 0.5.4 / Final，五个应用服务及 postgres healthy，postgres 容器 ID 不变，backup health ok、近五分钟错误日志 0，preflight 写闸输出一致；批次仍 paused。
- 回滚目标 v0.5.3 Final `2cec4502091df773f8ed6954486e5cf137954b8f`；使用其原发布目录和本次 env 备份 `preprod.env.bak-v054-20260929T101615Z`，不重建 postgres。改动已在带访问密码的预生产生效，正式域名切换后才对公网可见。详细证据见 [v0.5.4 发布记录](releases/v0.5.4-preproduction.md)。

### v0.5.3 —— 已发布到预生产（2026-09-28 17:10:36 +0800，`RELEASE=PASS`）

- 集成基线 `14fe2e41f8da3b4920c00e957a5952e5775e1176` 经 Opus 复核；Final `2cec4502091df773f8ed6954486e5cf137954b8f`，annotated tag `v0.5.3` 固定在 Final。镜像 `cps-novel:0.5.3-2cec450`（linux/amd64），归档 SHA256 `cb2fc89ff299d4304cb626b1185021229756391358cc922086d09a344a59f42c`。
- 第一阶段：tsc 0、lint 0 errors / 19 warnings、全量 470 文件 / 7,089 测试 passed，0 failed、无 Unhandled Error；build、22 个真实库运行器（排除 p1-12）、nginx 矩阵、公开切换变异、品牌图与三套 Compose 通过；迁移及静态/live 字典 drift 0。无新迁移或业务配置修改。
- Owner 单独授权后仅部署 `haiyue-vps`：领取批次前后 paused，定类任务和条目无 pending/processing；线上 20 条迁移名称、校验和及完成状态与 Final 一致。新鲜在线备份及 restore-list 通过。env 先备份，仅改两个版本变量；标签开关、写闸登记和主白名单原样保留。`PREPROD_APPROVED_MIGRATION=YES` 下无待应用迁移，grants 回放通过，`RELEASE=PASS`。
- 五个应用服务及 postgres 均 healthy，近五分钟错误日志 0；postgres 容器 ID 保持 `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e`，未重建。health 返回 0.5.3 / Final，backup health 为 ok；预检写闸输出部署前后完全一致，品牌 PNG 的 HTTP 200、类型及 SHA256 匹配。
- 本版仅修复大语种自动标签建任务分页读取与事务超时，代码已部署到预生产；英文回填由自动标签开闸线另行执行。本次没有开启标签开关：目标机实测 `FEATURE_NOVEL_TAG_AUTO=false`、`AUTO_WRITE_AUTHORIZED=NO`，auto_tag_write 未登记；未改 nginx、证书、DNS、NAS 入口、其它业务开关或批次状态。
- 回滚目标 v0.5.2 Final `efe51b58418cb340d53c40e35e68d7e1f6db5e93`；使用原发布目录及 env 备份 `preprod.env.bak-v053-20260928T090640Z`，不重建 postgres。详细证据见 [v0.5.3 发布记录](releases/v0.5.3-preproduction.md)；[Notion 发版手账](https://app.notion.com/p/3e4601b5fd3481b5a39bcf48408015c2)已同步并读回。

### v0.5.2 —— 已发布到预生产（2026-09-28 11:52:32 +0800，`RELEASE=PASS`）

- 集成基线 `5d04dcdbc5a8b30e840e0c746ea7a084c7438208` 经 Opus 复核；Final `efe51b58418cb340d53c40e35e68d7e1f6db5e93`，annotated tag `v0.5.2` 固定在 Final。镜像 `cps-novel:0.5.2-efe51b5`（linux/amd64），归档 SHA256 `802d6e903f62183ac58e3e768118b69c0fbfb58d224033f05386eca4c6803c10`。
- 第一阶段：tsc 0、lint 0 errors / 19 warnings、全量 470 文件 / 7,086 测试 passed，0 failed、无 Unhandled Error；build、22 个真实库运行器（排除 p1-12）、nginx 矩阵、公开切换变异、品牌图与三套 Compose 通过；静态/live 字典 drift 0。无新迁移、白名单或业务开关变更。
- Owner 单独授权后仅部署 `haiyue-vps`：暂停闸门前后通过；线上 20 条迁移名称、校验和及完成状态与 Final 一致；新鲜在线备份及 restore-list 通过。env 先备份，仅改两个版本变量；`PREPROD_APPROVED_MIGRATION=YES` 下无待应用迁移、grants 回放通过。`RELEASE=PASS`；五个应用服务及 postgres healthy，postgres 容器 ID 不变、`shared_buffers=4GB`。health 返回 0.5.2 / Final，backup health 为 ok，品牌 PNG 的 HTTP 200、类型及 SHA256 匹配，近五分钟错误日志 0。
- 公网化代码已合入并部署到预生产，正式 nginx 未安装、功能未生效；NAS 入口已合入，待 Owner 授权手工安装；B-20 随将来的正式模式生效。IndexNow 与自动标签未登记或开启；预生产域名、nginx、DNS、证书、能力行与批次状态未改。批次仍暂停，由 Owner 恢复。
- 回滚目标 v0.5.1 Final `f4d3d3595926051f3488cb1e3203c25340cbacf9`；使用原发布目录及 env 备份 `preprod.env.bak-v052-20260928T035019Z`，不重建 postgres。postgres 仍挂载 v0.5.1 发布目录中的配置，该目录不得删除。详细证据见 [v0.5.2 发布记录](releases/v0.5.2-preproduction.md)；Notion 交接提示词已生成，未直接同步或读回。

### v0.5.1 —— 已发布到预生产（2026-09-27 23:21:12 +0800，`RELEASE=PASS`）

- Final `f4d3d3595926051f3488cb1e3203c25340cbacf9`；集成基线 `c3726ef` 经 Opus 复核，发版分支 `release/v0.5.1-2026-09-27`。annotated tag `v0.5.1` 固定在 Final，后续治理提交不改变部署身份。
- 镜像 `cps-novel:0.5.1-f4d3d35`（linux/amd64）；归档 327,146,077 字节，SHA256 `05438ed18db069f7e7df2e290f439d96559260f8925ea414184f8058349abac9`。目标机源码 commit/tree、归档及载入镜像身份核验通过。
- 第一阶段：typecheck 0、lint 0 errors / 19 warnings、全量 466 文件 / 6,952 测试 passed，37 文件 / 416 测试 skipped，0 failed、无 Unhandled Error；build、三套 Compose、全部 22 个运行器通过。p1-12 runtime 按 Owner 指示排除，B-19 未复现；无新迁移，静态及 live 字典 drift 0。
- 第二阶段单独获授权，仅部署 `haiyue-vps`。线上 20 条迁移名称、校验和及完成状态与 Final 一致；Owner 修正原交接指令，允许 `PREPROD_APPROVED_MIGRATION=YES`：实际为空迁移检查与事务性 grants 重放，二者通过。env 先备份，仅改两个版本变量；应用部署后 postgres 原容器 ID 保持 `49fcbd95027c…`。
- 应用四服务与 postgres 全部 healthy；health 返回 0.5.1 / Final，metadata/database passed；近五分钟错误日志 0。内存限制：web/worker 2 GiB（堆 1536 MiB），worker-light 1 GiB（堆 768 MiB），scheduler 512 MiB（堆 384 MiB）。写闸批准列表仍为 catalog_write,promo_write,sitemap_write；auto_tag_write 未登记、未开启；IndexNow 仍关闭。
- backup-timer 自动重建到 Final 字面目录，`BACKUP_TIMER=RUNNING`、首轮 `PREPROD_BACKUP_RUN=PASS`，容器 healthy，后台主机 `/api/health/backup` 返回 `backupStatus=ok`。之后每日备份时刻随本次部署时刻调整，这是预期行为。
- Owner 手动 Sitemap 实地验收通过：`d908325f-8c6c-4666-a952-2316611ef491` 和 `c2275819-b9ca-4256-bb49-52ad1716bab8` 均 completed / item success，各 36 URL、error null；审计 356063 / 356065 的执行者均为 `cps-novel-preprod-worker-light-1`。沿用 v0.5.0 已接受的数据库审计证据口径，不冒称 Docker 成功日志。
- 第三阶段另行获 Owner 授权，且 Owner 已补齐并报告两条旧配置回退路径本地演练通过。再次核对暂停闸门和 `1 sleep` 后，从 Final 字面目录执行重建；`RECREATE_POSTGRES=PASS`、10 项 GUC PASS、shm=1073741824、指纹 `8dedd651ac4745461dca876121a0e008` 一致，实测停机 35 秒。persistent-check 三行 PASS，迁移仍 20 条；没有触发回退。
- 数据卷 `cps_novel_postgres_data` 的 CreatedAt 前后均为 `2026-09-21T11:57:29+09:00`；postgres 新 ID `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e`。**postgres 已挂载 `/opt/cps-novel/releases/f4d3d3595926051f3488cb1e3203c25340cbacf9` 下的配置，该目录在下次从其它目录重建 postgres 前不得删除。**
- 范围：应用内存限制、备份常驻修复、数据库容量参数已在预生产生效；B-16 仅测试与运维脚本；异地拉取已合入，待在 Owner 的 Mac 或 NAS 安装；自动标签登记位已合入但开关关闭（等于未上线）。没有修改能力行、业务开关、白名单、批次状态、nginx、其它主机或 X8。
- 最终批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 仍 paused，运行领取任务、在途条目及非终态意图均为 0；恢复由 Owner 操作。应用回滚目标 v0.5.0 `807aad3`，不要求回退数据库参数；旧参数回退必须使用 Owner 修订的旧目录 lib.sh 函数流程，不能在 v0.5.0 目录调用不存在的重建脚本。
- 详细备份、参数与证据见 [v0.5.1 发布记录](releases/v0.5.1-preproduction.md)。Notion 交接材料已生成，尚未直接写入或读回 Notion。

### v0.5.0 —— 已发布到预生产（2026-09-27 13:21:23 +0800，`RELEASE=PASS`）

- 开发线 `integration/v0.5.0-2026-09-27`，集成基线 `33a93c5`；工单 5、7、试读运维脚本、B-15 和工单 6 已经 Opus 复核并以 `--no-ff` 合入。
  Final `807aad3dae88c6cf560f663e55c8662407717c80`；annotated tag `v0.5.0` 固定在 Final，后续治理提交不改变发布身份。
- 镜像 `cps-novel:0.5.0-807aad3`（linux/amd64），归档 327,247,775 字节，SHA-256
  `ec1aa747df1abc7c811d1815fa4312775ec883c172ad46930a5b4d65fc8a9219`；config digest
  `sha256:a8cecd3b24d6424a1362aa652d9031bb71fc066579f70d16107f25c8934b97a7`；platform manifest digest
  `sha256:85aee9572dd24f070d8e2dd38ba1031560cd11bc4c255845f373006e739ce34c`。
- **已上线（预生产）**：worker-light 轻量通道、周期扫描底座、sitemap 每日兜底、scheduler 整间隔对齐、B-15 权限契约及人工核对出边数据库防线；试读已在主 worker 实际执行并通过本次发布验收。
  **已合入但开关关闭（等于未上线）**：IndexNow 分钟扫描与轻量投递接线、前台自动标签。
  试读运维脚本已合入，仅运维用；本次不回填。生产未上线。
- 两条增量迁移 `20260926150000_periodic_sweep_skip_reason`、`20260927090000_side_effect_manual_review_guard` 已应用，现有 20 条迁移完成；grants 回放通过。
  触发器启用且 SECURITY INVOKER；只允许 web_app 改走 manual_review_required，迁移后的数据库兼容 v0.4.5。
- 本地串行门禁：typecheck 0、build 通过；全量 461 文件 / 6,869 项 passed，37 文件 / 416 项 skipped，0 failed、0 Unhandled Error。
  全部 19 个 PostgreSQL 运行器均执行：17 个通过（含 x6/x9）；p1-05b / p1-06 因 B-16 三条旧 lint 错误退出 1，如实保留，不记通过。
  p1-06 另有旧 43 表 / 3 迁移断言和 Bash 3.2 fail-fast 问题，仍未修复。分片枚举 4 项、页位置排序 1 项单独通过；静态及 live 字典 drift 0。
  x9 空库 20 迁移、存量 19→20 迁移验证通过，两库各两次 grants 回放后均 27 passed。
- 部署仅限 `haiyue-vps`。在线逻辑备份 `cps-novel-v050-20260927T051542Z.dump`，194,525,163 字节，SHA-256
  `5eec21945b03f883dee13d14ac566396eb0a0db18da8bfdc60a9b74014240448`；备份及 restore-list 核对通过。
  env 备份 `preprod.env.bak-v050-20260927T051948Z`；仅升级两个版本号、新增三个 lane/light 变量，主白名单仅移出 sitemap_refresh 与 home_carousel.compute.v1、保留 preview。
  先改 env 再跑新版 preflight/release；写闸保持 catalog_write,promo_write,sitemap_write，IndexNow 四开关、自动标签和 AUTO_WRITE_AUTHORIZED 保持关闭。
- `RELEASE=PASS` / `RELEASE_EXIT=0`，release-state ready、current 指向 Final；health 0.5.0 / Final / metadata/database passed，五服务 healthy，postgres 未重建；验收后近 5 分钟错误日志 0、IndexNow 扫描行 0。
- **Owner 实地操作及只读验收通过**：文章 `ef51fcc9-d744-4c3a-8e03-4504a973b5fa`（短 ID `u7nnliaz`）于 16:29:41 +0800 发布，published / public。
  手动 sitemap `a9e9a65a-25b2-41bc-9369-20d336ba4bb6` 与发布自动 sitemap `c8aea19e-833e-4eb4-80f7-6342123114d9` 均 completed / 条目 success，分别 35 / 36 URL；
  审计 356053 / 356059 的 actor_id 均为 cps-novel-preprod-worker-light-1。
  新试读任务 `ed166a49-23db-406b-bda2-9c885d2b4007` 一次成功，审计 356061 为主 worker；3 章正文分别 2,488 / 2,573 / 2,266 字符，主 worker 的两次上游请求均 HTTP 200，429 为 0。
- **验收口径裁决**：当前版本不输出 Docker 成功处理记录；Owner 于 2026-09-27 明确接受 `task_item.success` 数据库审计作为执行节点证据，随后授权 tag 和治理收官。没有把数据库审计描述为 Docker 日志。
- **09-27 前序配置补记**：本次部署之前已打开两项读取能力（审计 276013 / 276014）、将试读加入主白名单、取消 80,006 条旧试读积压；这些不是本次发布执行中的操作。本次未修改能力行、批次状态、账号、nginx 或其它主机/X8。
- 验收后正式批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 仍 paused；其它运行态领取任务、两类 processing 条目、非终态领取意图均为 0。恢复由 Owner 操作。
  每日兜底下一次预计 2026-09-28 04:00 JST（03:00 +0800，15 分钟窗口），由主控次日核对，本次未等待或手动触发。
- 回滚目标 v0.4.5 Final `ff1d2dd7c8d46dba8e9267687eafbb9347b55387`；先以新版 compose 停掉 scheduler/worker/worker-light 并排空，再恢复 env 备份、执行旧版回滚并移除已停止的 light 容器，保留 sitemap 卷、不做 down migration。本次未触发回滚。
  B-16、admin2 前版待办独立保留。完整结果与证据见 [v0.5.0 发布记录](releases/v0.5.0-preproduction.md)。

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
| `v0.5.13` | 2026-10-09 11:20:43 | PATCH | B-38 公开列表数据库分页与分类归属表（迁移 24、表 58）、B-40 运行镜像只带生产依赖 | Final `cc2655b0a3864f6ae6a665f46bad91f15d0a904a`；annotated `v0.5.13`；image `cps-novel:0.5.13-cc2655b` | 已部署正式站；部署后实测与外部验收 PASS；主控直接发布 |
| `v0.5.12` | 2026-10-09 | PATCH | 分类标题与可浏览总数、新文章短网址补词、Next 16.3.8、Naver 文件、任务类型中文名及多语种文案；无新迁移/grants/nginx/环境变量 | Final `84af0d7`；release/v0.5.12-2026-10-09 | 已部署正式站；A～E/自动F PASS；Owner验收通过（含F.4/F.5）；71本待运营生成后核对 |
| `v0.5.11` | 2026-10-08 17:15:56 | PATCH | 十项已复核范围；收益四表迁移及grants，主worker手动同步；IndexNow/Turnstile关闭，nginx未安装 | Final `eb40756416b186ca4b293ff57e24026af78cf4f9`；annotated `v0.5.11`；image `cps-novel:0.5.11-eb40756` | 正式站已部署，A～E及自动F通过；Owner新Sitemap/B33、桌面目视、收益同步对数待确认 |
| `v0.5.10` | 2026-10-08 01:11:28 | PATCH | 书封、分类Sitemap/站内链接、分页SEO、阅读设置、阿语与运营后台；Turnstile合入关闭；无新迁移 | Final `7f955106a82f8dff82568e305ea35f1a68b8c934`；annotated `v0.5.10`；image `cps-novel:0.5.10-7f95510` | 正式站已部署，自动验收PASS；35分片115163、en分类1788→72；Owner浏览器/手机待确认 |
| `v0.5.9` | 2026-10-07 02:23:30 | PATCH | 领推广生命周期修复；上架时间筛选；站点地图规模修复；后台批量发布；B-8/B-31 覆盖及切换证据；source-map-js 1.2.2；无新迁移 | Final `6af0b2e5c79db932c4754a43580eed3729bd0334`；image `cps-novel:0.5.9-6af0b2e`；`release/v0.5.9-2026-10-07-redo`；基线 `59e84ef` | 已于2026-10-07切换正式域名pulsenovels.com对外开放（19:39:17 JST确认）；同版Final不变；public配置/部署/live/外部/100x20/worker及当天sitemap计数通过；Owner接受已知B-38部分分类404，随v0.5.10修复；预生产E/F/5b/5c/5d为历史PASS；Owner登录/2FA与认证记录核对PASS，GSC/监控待做；Git已push核远端，Notion开放及Owner2FA完成状态同步回读PASS（19:49 JST） |
| `v0.5.8` | 2026-10-05 21:27:39 | PATCH | worker 心跳部分索引及健康检查修复；NAS stat 跨平台与排序修复；新增 1 条迁移 | Final `0329b113bcfefb35a7654bfd311d2e0a6095ed25`；annotated `v0.5.8`；image `cps-novel:0.5.8-0329b11`；`release/v0.5.8-2026-10-05` | 已部署密码保护预生产；E/F/G PASS；批次 paused；正式域名未开放；Notion 第二阶段同步回读 PASS（2026-10-05T22:36:40.438000+09:00） |
| `v0.5.7` | 2026-10-01 22:35:53 | PATCH | B-24 路径 fail-closed；B-21 定类内存优化；B-23 公版套话校准；Docker 边界修复；无新迁移 | Final `bbb06253828d9fd338f0ece1749c2020d8ec4679`；image `cps-novel:0.5.7-bbb0625`；`release/v0.5.7-2026-10-01-redo` | 密码保护预生产 E/F/G PASS；F.1 主控裁决；15 语种只读报告、24 样本、en 前快照完成；tag/CHANGELOG 完成；第三阶段仅en completed / 43,431成功、0失败/skipped；实际差集133/0/133/126 PASS；公开auto0；快照保留，次日备份待复核；批次paused |
| `v0.5.6` | 2026-10-01 03:38:32 | PATCH | Yandex 设置；站点地图瘦身及免费章节；B-27；Next 16.3.7 安全修复；新增 1 条迁移 | Final `8625021d064f17d37e610d6038023c3ffecd9408`；image `cps-novel:0.5.6-8625021`；发布分支 `release/v0.5.6-2026-10-01-redo` | 预生产已发布；E/F/G PASS；tag/CHANGELOG/正式日志/Notion 同步回读完成 |
| `v0.5.5` | 2026-09-30 19:46:54 | PATCH | 语种切换/404/跨语种 SEO 与 TKD 对齐；Next 16.3.3；模板版本兜底及并发创建收敛；无新迁移 | tag `v0.5.5` → `b44b9e2008f66f180fde8b194f5538ebfaf32849`；image `cps-novel:0.5.5-b44b9e2` | 预生产已发布；Owner + Opus 验收 PASS；分类 sitemap 已在 v0.5.6 G 节只读验收了结；第三阶段 15 模板标题更新及零变化回读 PASS，approver admin / audit 516113 |
| `v0.5.4` | 2026-09-29 | PATCH | 运营前端与 SEO 优化第一轮；D-12 章节列表折中方案；无新迁移 | tag `v0.5.4` → `0260d8d89c8aba83ba7eb8887ae94461489a927c`；image `cps-novel:0.5.4-0260d8d` | 预生产已发布；领取批次保持暂停；正式域名切换后才对公网可见 |
| `v0.5.3` | 2026-09-28 17:10 | PATCH | 大语种自动标签建任务分页与事务超时修复；无新迁移；英文回填另行执行 | tag `v0.5.3` → `2cec4502091df773f8ed6954486e5cf137954b8f`；image `cps-novel:0.5.3-2cec450` | 预生产已发布；领取批次保持暂停；标签开闸与英文回填另行执行 |
| `v0.5.2` | 2026-09-28 11:52 | PATCH | 公网化代码预置、NAS 受限拉取入口预置、B-20；无新迁移；正式模式未生效 | tag `v0.5.2` → `efe51b58418cb340d53c40e35e68d7e1f6db5e93`；image `cps-novel:0.5.2-efe51b5` | 预生产已发布；批次保持暂停；NAS 入口待 Owner 授权安装 |
| `v0.5.1` | 2026-09-27 23:21 | PATCH | B-16 测试运维修复；应用容量、备份常驻、数据库参数生效；异地拉取待安装；自动标签仍关闭；无新迁移 | tag `v0.5.1` → `f4d3d3595926051f3488cb1e3203c25340cbacf9`；image `cps-novel:0.5.1-f4d3d35` | 预生产已发布；数据库重建及 Owner Sitemap 验收通过；批次保持暂停 |
| `v0.5.0` | 2026-09-27 13:21 | MINOR | 轻量通道、周期扫描、sitemap 每日兜底、B-15 防线；试读实际执行通过；IndexNow 与自动标签开关关闭 | tag `v0.5.0` → `807aad3dae88c6cf560f663e55c8662407717c80`；image `cps-novel:0.5.0-807aad3` | 预生产已发布；Owner 验收通过；批次仍暂停；生产未上线 |
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
