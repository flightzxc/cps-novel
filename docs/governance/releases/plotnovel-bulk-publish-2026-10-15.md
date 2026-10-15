# PlotNovel 存量文章放量运维（2026-10-15）

## 当前状态：阶段二第一波生成失败率2.4%，按门禁停手

主控已复核固定脚本ab09d1be通过，Owner已批准固定清单四波放量。第一波500本全部终态：488成功草稿、12失败（finalize_failed），失败率12/500=2.4%，超过2%上限，已在发布前停手。publish调用0、新增公开页面0、线上仍50篇，后三波未启动；未重试/补发/修数据/取消任务或执行最终刷新和抽查。claimPromo仍关闭，635条人工复核与原50篇页面摘要不变。后文阶段一交付事实保留为历史，当前以本节及阶段二停手记录为准。

代码基线release/v0.6.0-2026-10-14@ed983f28377989605796030c06f8b9277c7ee7e8。新分支ops/plotnovel-bulk-publish-20261015，工作树/Users/chenweifeng/Documents/cps海阅/plotnovel-bulk-ops，真实node_modules，npm ci和Prisma generate已完成。固定脚本提交 **ab09d1beda4f0b26562ad7db1710d3c0855aec64**，仅留档ops分支、不合入集成，也不把脚本带入release分支。线上Final/tag仍493eb23b034b0410780228535b3e293e4ee91f9a，未发版/构建/拉取/重建镜像，不改schema、依赖、业务代码、env、能力或既有公开网址。

## 四命令及复用边界

脚本scripts/ops/plotnovel-bulk-generate-publish.ts只做编排：按PlotNovel英语的真实书目归属取小说，调用resolveArticleGenerateAdmissions和原推广解析；生成调用enqueueArticleGenerateBatch，发布调用publishArticlesBatch，IndexNow控制和sitemap状态也读原模块。不复制SQL业务写入、同名规则或就绪规则。源码约285行，使用createRequire以/app/package.json为解析基准，显式tsconfig解决/tmp入口的模块定位；实际生产plan已验证。

所有命令显式--actor-id，核对唯一active admin/super_admin；拒绝非web_app，原生容器数据库连接，无替换连接参数。plan/status及写命令的前置查询均事务READ ONLY。plan写0600清单文件，不写库；status不写库或执行日志。

generate/publish/status还必须传--manifest、--manifest-sha256完整64位、--wave。清单含固定操作编号/基线/actor/app/en、计数、完整novelId、波次/块和既有有效试读基线；全文件字节摘要由外部传入，不自证。每次核对完整范围归属、实际就绪推广归属、635基线及已发布总量的外部干扰，拒绝篡改/重复ID/重新分块。

- generate确认短语PLOTNOVEL_BULK_GENERATE；每个原块输入不变，requestId固定plotnovel-bulk-20261015-w<N>-c<K>，通过原接口恢复已有任务，不为失败书另建任务。
- publish确认短语PLOTNOVEL_BULK_PUBLISH；只采用原块任务成功created结果中的草稿，requestId固定plotnovel-bulk-publish-20261015-w<N>-c<K>，跳过带本次对应审计的已发布文章；不接管外来草稿/发布，发现非首次发布亦停手。
- status按实际任务条目/文章/试读书目计数，普通IndexNow pending/processing可等待；缺失outbox单列missing，故障/挂起/死信等单列stopReasons，已有有效试读单列。
- 写命令使用清单旁的0600 execution.jsonl与0700互斥锁；任意拒绝、冲突、未知错误或中断记录stop，后续不得自动越过。SIGINT/SIGTERM在当前调用返回后停止后续块，不自动撤回已提交项。进程硬中断遗留锁须先人工核实，不自动删除。

## 本地门禁

npm ci及Prisma generate通过；完整typecheck0错误，完整lint0 error/16条既有warning，无audit fix或依赖改动。新增4项定向守卫测试、9项一次性PostgreSQL16.14真实库冒烟，**13/13通过、skipped=0、无Unhandled**；真实27迁移、真实角色/grants、grants重放幂等、字典drift0，测试库已删除。仅跑这两个文件，没有全量回归。

真实web_app执行plan→generate→publish→status；原worker处理器通过真实worker_app领取/围栏落库生成，无真实上游请求。证明MoboReader与同名书排除、重复调用不重复业务行或审计、错误角色/管理员/确认短语/摘要/外剧场清单零业务写入、已有第一块恢复、外来草稿拒绝、真实部分发布后第二篇拒绝的停手日志及禁止自动重试、只读事务真实拒绝写、已有试读及缺失outbox统计。原业务服务未mock；部分发布异常用测试适配器在原服务前改变第二本夹具状态，实际发布仍经原函数。

### 基线证据后缀修正

基线把1份TS、2份CJS临时运维探针以可执行后缀放在docs/evidence，导致全量tsc/lint误将其编译/检查。只追加.txt后缀，三份内容逐字及SHA256与ed983f28一致，更新证据索引；不修改业务代码、tsconfig、eslint规则或排除范围。该文档整理同步在ops和release上。夹具密码格式与测试目录清理的首次失败保留在本地ignored日志及证据摘要，不削弱断言。见historical-evidence-text-archive.json和development-iterations.json。

## 生产只读预演

时间 **2026-10-15T08:26:14.594082Z（17:26:14 JST）**；仅haiyue-vps，docker ps按Compose标签定位cps-novel-web-1。脚本先送服务器受保护运维目录，再docker cp到web /tmp，容器内sha256逐字核对。仅执行：

```bash
docker exec -w /app -e 'PGOPTIONS=-c default_transaction_read_only=on' cps-novel-web-1 tsx --tsconfig /app/tsconfig.json /tmp/plotnovel-bulk-generate-publish.ts plan --actor-id 71f0e655-0640-4f07-bcbb-041f027fa7cb --output /tmp/plotnovel-bulk-20261015-manifest.json </dev/null
```

输出角色web_app、transactionReadOnly=on；操作人ID71f0e655-0640-4f07-bcbb-041f027fa7cb、username admin、role super_admin、status active，与既有Owner身份一致。PlotNovel app 00de5521-d075-4472-87eb-cc5d1732f4d0。脚本SHA256 **194438792336da3d054a2751c16737ef578906bc3de591eb43c3ccd3dd524660**。

| 准入口径 | 本数 |
| --- | ---: |
| PlotNovel英语已关联小说全集 | 3860 |
| 可生成 | **1985** |
| promo_link_missing | 1186 |
| promo_link_not_ready | 635 |
| already_exists | 50 |
| duplicate_title_in_link_theater | 4 |

不可生成1875，合计3860；原因使用原准入优先级，互斥计数，不把同名与未就绪重复相加。与约1989的预期差4，原函数确实排除4本就绪同名书；没有放宽规则或凑数量。

| 波次 | 本数 | 固定块大小 |
| --- | ---: | --- |
| 1 | 500 | 200 / 200 / 100 |
| 2 | 500 | 200 / 200 / 100 |
| 3 | 500 | 200 / 200 / 100 |
| 4 | 485 | 200 / 200 / 85 |

清单SHA256 **95cae34466d3b672ff57fa8017c3cb0b7f0a64829c3ca99e665f9aa1d2ade1ec**。容器/tmp/plotnovel-bulk-20261015-manifest.json；服务器/opt/cps-novel/shared/operations/plotnovel-bulk-publish-2026-10-15/manifest.json（0600、父目录0700）；本地/Users/chenweifeng/Documents/cps海阅/plotnovel-bulk-ops/.tmp/plotnovel-bulk-20261015/manifest.json（0600）。完整清单不入Git，主控可从本地文件读取；下载后独立重算摘要一致。

预演前后635条人工复核ID/status/response_shape摘要相同，既有50篇ID/status/slug/public_page_short_id/published_at/body摘要相同；web容器CID不变，Final及env SHA f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369不变。未输出码、凭据、env或正文。主动外部HTTP0；原脚本getcode/生成/发布调用均0。生产只运行plan，没有运行generate/publish/status或sitemap刷新。

## 阶段二执行门禁（阶段一登记）

本节为阶段一登记的执行方案；本轮已获双重批准并执行至第一波生成停手。原批准要求同时指定主控复核通过、本ops提交和清单摘要以及Owner“批准放量”；任何源码或清单改变须重新交付复核。

每波生成全部终态后，按不同书目计算失败率；>2%停手，≤2%仅发布成功草稿，失败留档不补发，所有清单项逐本核销。发布每次≤200，任何拒绝/冲突/not_found/aborted立即停后续调用，不重试。每块之间和等待期间由主机侧监督服务日志；permission denied立即停，脚本不取得Docker或额外数据库权限。

每30秒status及日志采样：IndexNow普通pending/processing可等，全部accepted且熔断关闭/无429等待才继续；失败/挂起/死信即停。试读按书目/条目至少95%终态、失败≤10%，已有有效试读单列，缺任务且无有效试读不能算完成；主worker连续15分钟无终态进展，或连续10分钟净增长且未下降，停后续提交。sitemap最近生成success、完成时间覆盖本波发布且无在途刷新。暂停只停止编排，不自行取消worker或修数据。

全部波次后等试读全部终态，再按原sitemap CLI先预演后单次刷新处理B-46已知时序。核对已发布总数50+实际新增，sitemap覆盖公开书页及实际有效可索引章节，各服务自执行开始error/permission denied0。随机固定3篇，各书页/go/中间页GET一次共9次，全指定7899代理、无HEAD/重试/跟随，响应/口令仅内存。出现任何差异按原规则停手，不撤回或修改既有公开页面。

## 治理与交接

ops分支推送回读，不合入集成；本文件、脱敏证据与v0.6.0台账在release分支，CHANGELOG由原生成器/core.abbrev=7生成；Notion单独同步本次存量放量运维条目并回读。没有新增发版级开发日志或移动tag。阶段二每波结束均做治理提交后才进下一波。阶段一交付时所有波次均未执行；本轮第一波结果见下文，其他波次仍未执行。

阶段一历史停点为等待主控复核及Owner批准；本轮批准后停在第一波生成失败率门禁，claimPromo关闭、635人工复核保留。机器结果见[phase1-result.json](evidence/plotnovel-bulk-publish-2026-10-15/phase1/phase1-result.json)，门禁见[local-gates.json](evidence/plotnovel-bulk-publish-2026-10-15/phase1/local-gates.json)。

阶段一治理提交6b6d570b已推送并回读。Notion手账新增本次独立运维条目，于2026-10-15T08:33:30.499Z回读PASS，唯一条目、完整清单摘要和未执行阶段二状态均一致，原无关历史逐字保留。仅有Notion按规范将正文中的一个>转义为\>的序列化差异，归一该处后新增正文精确一致。收据见[notion-readback.json](evidence/plotnovel-bulk-publish-2026-10-15/phase1/notion-readback.json)。

## 阶段二：第一波生成后停手（2026-10-15）

Owner本轮明确给出主控复核ab09d1be通过（tsc、真实库13/13、单测4/4与独立变异承重），并批准清单95cae34466d3b672ff57fa8017c3cb0b7f0a64829c3ca99e665f9aa1d2ade1ec四波500/500/500/485，承诺放量期间不在后台发布PlotNovel。脚本、清单、操作人及生产Final/env/CID重新核验一致，未重跑已通过的门禁或重新规划清单。

基线08:45:09.684095Z（17:45:09 JST）；web原生连接/web_app，命令保持原CLI接口，外层stdin=/dev/null、docker exec不带-i。第一波generate于08:45:56.427437Z启动，200/200/100三块均selected=submitted、blocked=0、duplicate=false。

| 块 / requestId尾部 | 生成任务ID | 本数 | 成功草稿 | 失败 | 终态 |
| --- | --- | ---: | ---: | ---: | --- |
| w1-c1 | f793c18c-d286-4dd5-81c1-5ec04ce24822 | 200 | 196 | 4 | completed_with_errors |
| w1-c2 | 0fddd31d-62a2-4dab-bb9c-13bf47841158 | 200 | 193 | 7 | completed_with_errors |
| w1-c3 | ff1b613e-c2f8-463f-95f3-1c9fb97d05e7 | 100 | 99 | 1 | completed_with_errors |

requestId完整前缀plotnovel-bulk-20261015-。任务条目执行08:45:58.913910Z至08:46:17.567531Z，18.653621秒。08:46:37.200387Z只读status确认500=488成功+12失败，pending/skipped/notSubmitted均0，三个父任务全部终态；失败率**2.4%>2%**，stopReasons=generation_failure_or_skipped。12条error.code均finalize_failed、attempt_count均1；该记录类别不等于已定位根因，未进一步施工或重试。

**停手结果**：保留488篇草稿和12条失败记录。publish调用0、article.publish审计0、后三波生成任务0；本次新增公开页面0、已发布总数仍50。没有继续IndexNow/试读/站点地图的本波发布收尾流程；状态accepted/pending均0指本波未发布，不表示新增页面已验收。最终手动刷新和3篇抽查未执行，主动外部HTTP0。没有重新提交、补发、取消任务、修数据、删除停手标记或恢复领码。

停手只读读回（08:47:24.355388Z）：635条manual_review_required数量及ID/status/response_shape摘要未变；原50篇ID/status/slug/public_page_short_id/published_at/body摘要未变；claimPromo仍registered_disabled。env SHA f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369，Final和六服务CID均未变；全部healthy。自基线起web、worker、worker-light、scheduler、postgres、backup-timer的error/permission denied计数各0。业务任务12项失败单独报告，不能因日志error计数0记为生成通过。

主机侧监督仅围绕批准CLI做摘要/身份/只读状态与日志采样，未复制业务规则；首次状态采样已见全部终态，未触发积压长窗口判断。受保护目录phase2/STOP.json阻止本监督程序后续写命令；没有伪造原CLI的stop事件，原execution.jsonl只包含实际三个generate事件。执行监督与只读SQL源码以.txt后缀归档，不进入编译范围。

证据：[阶段二结果](evidence/plotnovel-bulk-publish-2026-10-15/phase2/phase2-result.json)、[失败分类及12条书目/任务ID](evidence/plotnovel-bulk-publish-2026-10-15/phase2/wave-1-stop-readback.json)、[原生成日志](evidence/plotnovel-bulk-publish-2026-10-15/phase2/execution-journal.json)、[停手快照](evidence/plotnovel-bulk-publish-2026-10-15/phase2/STOP.json)、[摘要索引](evidence/plotnovel-bulk-publish-2026-10-15/phase2/SHA256SUMS.json)。当前等待Owner下一步决定，未经再次授权不越过停手点。ops固定提交不变、仅留档；本次仅治理提交，未新增发版级开发日志，未移动tag或Final。

本轮停手结果已同步既有Notion条目并回读PASS（2026-10-15T08:49:44.725Z）：唯一条目、失败率/数量/任务ID/停手范围一致；阶段一历史及无关正文逐字保留，比较排除fetch包装层as-of时间戳。收据见[Notion回读](evidence/plotnovel-bulk-publish-2026-10-15/phase2/notion-readback.json)。
