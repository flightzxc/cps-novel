# PlotNovel 存量文章放量运维（2026-10-15）

## 当前状态：第3波收尾PASS，已发布新增1456篇；继续按门禁执行

主控复核11f4cb11及Owner批准恢复后，第3波生成、发布、收尾已通过。累计新增发布1456篇，线上总1506篇；本波已知模板失败15本，逐本留档、不补发。claimPromo关闭，635条人工复核和原50篇页面不变。原2%门禁停手、阈值修订和只读诊断保留在下文历史章节；当前执行结果以最新波次及最终验收为准。

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

## 已知模板失败阈值修订与只读诊断（18:38 JST）

Owner确认首波12项属于个别书目TemplateRenderError，授权仅在ops分支修改阈值/分类并补单测，提交后停待主控复核。新政策：失败记录同时满足code=finalize_failed且错误类TemplateRenderError才计已知类别，按整波书目数允许≤5%；任何其他/缺失类别或已知失败>5%仍停手。原worker固定脱敏摘要`Item finalize failed: TemplateRenderError`可精确核对错误类，不单凭finalize_failed或字符串包含匹配放行。三个门禁（status、发布准入、下一波就绪）复用同一分类结果。只改运维CLI及其单测，不改业务规则/运行器/生产worker；requestId、清单、原任务/草稿、journal停手检查与互斥锁保持原样。

本轮15项定向单测通过（原4+新增11）、skipped0；覆盖首波12/500、25/500恰好5%、26/500超限、末波24/485与25/485边界、未知/缺失/混合/非精确分类及无效分母。tsc0、lint0 error/16既有warning；没有重跑全量回归。脚本固定摘要见review-gates.json，修改待主控复核，本轮未把新版CLI送进生产，也没有generate/publish调用。

只读诊断于2026-10-15T09:38:06.597Z在实际web容器、cwd=/app、原生web_app连接执行，PGOPTIONS开启默认只读，RepeatableRead事务显式READ ONLY。限定第一波12条失败任务/清单书目，复用现有模板选择、validateStoredArticleTemplate、推广解析、countPreviewChapters及renderNovelArticleDraft，使用原任务payload指定模板键；只在内存渲染，不调用生成函数、不落库、不生成文章或审计、不访问上游。

**12/12复现同一错误**：TemplateRenderError / ERR_TEMPLATE_VALUE_INVALID，slot=body，field=cover_url，constraint=absolute_url；模板ID22751b2d-a802-4a59-9048-59435454c8d4、version1。原持久错误均finalize_failed且固定摘要精确对应TemplateRenderError。结论为封面字段不符合模板绝对网址合同；未输出封面原值、模板正文、渲染正文、口令或凭据。未做数据修复、模板放宽、重建任务或补发，12条失败保留。

journal只读核验：3条generate、0条stop，SHA256 cdc2273da9dedc15916b7d1856cf5e9dc3ef577ef2f869d326a09c02cc24fd32，无遗留lock。另有主机监督phase2/STOP.json，SHA256 fe0227f11a5922923fb5e7310d3b7e7cd0733f540bf2e8e8222cf2818e5a41dc；两者均未修改/删除。无需轮换原CLI journal；复核通过后，若需解除主机监督停手，须先把该STOP文件与旧监督版本/摘要另存归档，记录本轮Owner例外及新审核提交，再恢复，不能直接删除历史。

临时诊断入口首次docker cp沿用0600/root属主，web非root用户无法打开，退出EACCES；文件未加载，未进入渲染或数据库查询。已将不含凭据的临时诊断源码文件按0644复制，服务器受保护父目录仍0700，随后12项只读诊断完成。该临时入口权限错误单独留证，不混入业务权限错误计数；没有更改数据库/业务文件/容器用户权限或系统配置。首次证据摘要与修正见diagnostic-wrapper-iterations.json。

诊断前后原50篇页面及635条人工复核摘要一致，env/Final/CID不变。放量保持停止，488篇草稿未发布，后三波未启动，claimPromo仍关闭。证据：[12本只渲染结果及journal核验](evidence/plotnovel-bulk-publish-2026-10-15/threshold-review/render-only-result.json)、[修订门禁](evidence/plotnovel-bulk-publish-2026-10-15/threshold-review/review-gates.json)。等待主控复核，通过后才发布488篇并继续后续波次；未把本次阈值修订记为已执行放量。

阈值待复核与12本只读诊断已同步Notion原运维条目，2026-10-15T09:41:29.188Z回读PASS，原历史和无关正文保留；收据见threshold-review/notion-readback.json。

## 第1波执行与收尾PASS（2026-10-15T10:29:16.983246+00:00）

主控复核11f4cb11通过，Owner批准恢复；新版CLI容器内SHA256=62eb005c2dc0eccc783e676a3c830efdbb5bd71eb7d3ed88e4d812eac72d3c4f。原主机STOP.json及旧CLI/监督/journal移入受保护archives/resume-11f4cb11-20261015T101633Z，原STOP摘要fe0227f11a5922923fb5e7310d3b7e7cd0733f540bf2e8e8222cf2818e5a41dc未变；原CLI journal未改，不重建第一波生成任务。

生成清单500本，成功并首次发布488篇、已知TemplateRenderError失败12本（2.400%），未知失败0；失败项保留、不重建/补发。草稿0，未提交/处理中/跳过均0；发布拒绝/冲突/not_found/aborted均0。任务ID：f793c18c-d286-4dd5-81c1-5ec04ce24822, 0fddd31d-62a2-4dab-bb9c-13bf47841158, ff1b613e-c2f8-463f-95f3-1c9fb97d05e7。

生成CLI：2026-10-15T08:45:56.427437+00:00至2026-10-15T08:46:02.161527+00:00，exit=0。

发布CLI：2026-10-15T10:16:48.503842+00:00至2026-10-15T10:17:06.081175+00:00，exit=0。

IndexNow 488/488 accepted，pending/missing/死信0，熔断关闭、无429等待。试读按书目完成488/488，失败0，待处理0，缺失0；其中清单时已有有效试读3本。sitemap任务995e3929-ea11-4b5f-93f7-ce98f8eb9a71 completed，最近生成success@2026-10-15T10:17:29.876Z，覆盖本波发布时间、无待处理刷新。状态readyForNextWave=true；允许残余≤5%试读继续收尾，最终统一等终态后再补刷。

PlotNovel已发布总数538=原50+累计新增488；原50页面及635人工复核摘要未变，claimPromo关闭，Final/env/CID不变。自原执行基线起各服务error/permission denied均0；已知模板失败单独核销，不将其掩为任务成功。主动外部HTTP0，最终抽样尚未执行。逐本核销见[本波证据](evidence/plotnovel-bulk-publish-2026-10-15/wave-1/result.json)。

### 第1波模板失败书目（B-47修复后另行批准补发）

| novelId | task itemId | 模板错误码 |
| --- | --- | --- |
| 00d9bd97-fe97-429e-9d1b-39ee466f5f05 | 506a1ba1-d8d1-4a55-8a4a-180683b6d6d1 | ERR_TEMPLATE_VALUE_INVALID |
| 0c5b3037-73f9-48d6-8e88-097c17ab5503 | 476a3746-b6bf-4e99-b5c4-0c25c1fcc42d | ERR_TEMPLATE_VALUE_INVALID |
| 12a6c73b-f700-416d-8595-86d9779113c5 | a74c3133-9cd5-487a-9105-a018d1086e9b | ERR_TEMPLATE_VALUE_INVALID |
| 1734d288-229c-439b-8d02-2e759fa4da6e | 942151e1-0e16-4034-ade9-684b8fdc5149 | ERR_TEMPLATE_VALUE_INVALID |
| 1fca788e-88c7-4fc1-86d8-99f1abf06dcd | 0cdf173e-7977-4d5c-a87f-ef2252e9100d | ERR_TEMPLATE_VALUE_INVALID |
| 21cc69f0-eb6a-4abc-bfd9-f5774fbe5b6d | ed6e5c3f-ea8f-4e9e-8ec5-e23089072cb7 | ERR_TEMPLATE_VALUE_INVALID |
| 22e4be9a-3936-43dc-8c09-1751a9c8b052 | 2fdf0f42-0d62-4f4d-a1e9-5e1cddc13df7 | ERR_TEMPLATE_VALUE_INVALID |
| 263b2b6c-3189-4d04-9183-1bac7b042483 | 74acdec2-1dad-434b-9e39-ae2ec311432c | ERR_TEMPLATE_VALUE_INVALID |
| 2b98da7d-898a-4a01-954a-a0a928dcb2a7 | bc02d40e-c561-4c17-864a-772b37e4a832 | ERR_TEMPLATE_VALUE_INVALID |
| 2bd00daa-1d89-4191-868e-47cea348bc87 | 9162aba8-a636-48a8-bd4f-29ed7b1375e4 | ERR_TEMPLATE_VALUE_INVALID |
| 2d0ae15d-6734-4840-b8c3-88c6e7bdb719 | 8f6dd1c4-938c-4e38-bda4-80d8fecca527 | ERR_TEMPLATE_VALUE_INVALID |
| 346954a7-c6e7-494d-8918-ceccff8b2340 | e24a0671-dd97-405a-b627-6baf4b64346b | ERR_TEMPLATE_VALUE_INVALID |

这里只登记受影响书目，不执行B-47修复或补发；第一波12本cover_url/absolute_url已只渲染定位，后续各项按原任务错误分类留档。

## 第2波执行与收尾PASS（2026-10-15T10:44:05.375871+00:00）

生成清单500本，成功并首次发布483篇、已知TemplateRenderError失败17本（3.400%），未知失败0；失败项保留、不重建/补发。草稿0，未提交/处理中/跳过均0；发布拒绝/冲突/not_found/aborted均0。任务ID：a0c92c40-5830-415b-948f-5885446936e9, 10e08deb-4322-44cd-9a2a-1ddbd4d8d94a, 4a24f571-674e-449c-abad-676652f324b2。

生成CLI：2026-10-15T10:30:43.605126+00:00至2026-10-15T10:30:48.577512+00:00，exit=0。

发布CLI：2026-10-15T10:31:25.155239+00:00至2026-10-15T10:31:40.150172+00:00，exit=0。

IndexNow 483/483 accepted，pending/missing/死信0，熔断关闭、无429等待。试读按书目完成483/483，失败0，待处理0，缺失0；其中清单时已有有效试读2本。sitemap任务1bb3495c-36d4-4bd4-b5fb-efbdc224e73d completed，最近生成success@2026-10-15T10:32:06.424Z，覆盖本波发布时间、无待处理刷新。状态readyForNextWave=true；允许残余≤5%试读继续收尾，最终统一等终态后再补刷。

PlotNovel已发布总数1021=原50+累计新增971；原50页面及635人工复核摘要未变，claimPromo关闭，Final/env/CID不变。自原执行基线起各服务error/permission denied均0；已知模板失败单独核销，不将其掩为任务成功。主动外部HTTP0，最终抽样尚未执行。逐本核销见[本波证据](evidence/plotnovel-bulk-publish-2026-10-15/wave-2/result.json)。

### 第2波模板失败书目（B-47修复后另行批准补发）

| novelId | task itemId | 模板错误码 |
| --- | --- | --- |
| 3fefed63-17e5-419c-8745-12184ec43b01 | 80af506d-e8d2-4705-b10d-16b90c3e2cd8 | ERR_TEMPLATE_VALUE_INVALID |
| 40cee355-5e76-481a-bf91-00bc369d1514 | 308df0c2-84e8-4baa-a9c6-7d9a1056dab2 | ERR_TEMPLATE_VALUE_INVALID |
| 410d0cdf-8dbe-4bbb-ada8-94491834840c | c27a280c-141a-4ced-95d9-3e78ec1618a1 | ERR_TEMPLATE_VALUE_INVALID |
| 47ba9c6f-054e-4c94-8d3e-421a550da060 | ebeb11dc-2d9b-41e6-9f64-2865e71d1238 | ERR_TEMPLATE_VALUE_INVALID |
| 4b6a3c3d-88ce-4533-bcdc-353e7c285b0d | 54c2c426-5e5c-4f69-9749-469419a1083c | ERR_TEMPLATE_VALUE_INVALID |
| 4d3a5068-7a50-46c4-9a88-810e6970c139 | 933cd8c7-05bf-44aa-a181-b61a20171a9e | ERR_TEMPLATE_VALUE_INVALID |
| 57b18a9b-37f6-4f57-911b-58a4591e730a | a69cc32a-49d8-48a4-a388-128eaa2f1594 | ERR_TEMPLATE_VALUE_INVALID |
| 5fe258f5-d752-4b32-95e7-00f0ad600439 | 7ab107e0-589c-4ddc-812b-95de016522fb | ERR_TEMPLATE_VALUE_INVALID |
| 668ad359-6ec1-45c8-b588-575e2c76c9ae | aef8d4f8-1a3f-4d41-b2ee-12da9732beca | ERR_TEMPLATE_VALUE_INVALID |
| 6ece0a4d-9f4a-405c-b4aa-78e10df25628 | 2ffa7871-43b7-4404-90c6-11f7a33bf96b | ERR_TEMPLATE_VALUE_INVALID |
| 716128d5-ebd1-4eb6-8631-386249a76027 | 2ca0bc03-3c42-4d51-a4d0-3ea2743a8457 | ERR_TEMPLATE_VALUE_INVALID |
| 72c15194-679a-4a7e-8942-3ba5cbe6e618 | 7af2f507-992e-4664-bf40-03ddf6e176e5 | ERR_TEMPLATE_VALUE_INVALID |
| 7580b19e-fc84-408f-8ddd-c49bbda9d6d4 | bcafa457-e78a-43ef-99da-30d17dd699c1 | ERR_TEMPLATE_VALUE_INVALID |
| 77ad1197-8ae7-4a8d-9777-e7cb991d8c6e | 5373aeaf-f2e4-4816-967e-7e067c4f8461 | ERR_TEMPLATE_VALUE_INVALID |
| 77bbead2-9989-4277-a0f2-4a4cd9900d5b | d0c4a1b9-e0bc-4da3-9dae-830c66624d1d | ERR_TEMPLATE_VALUE_INVALID |
| 798613b2-0810-4abd-be32-81b9dc23311d | e4653885-da94-4757-bf26-91c42ade7015 | ERR_TEMPLATE_VALUE_INVALID |
| 8153b554-f04d-41e7-82cc-ef77e9b3b832 | 482a26fe-623c-40cd-9f37-8f92d80aee53 | ERR_TEMPLATE_VALUE_INVALID |

这里只登记受影响书目，不执行B-47修复或补发；第一波12本cover_url/absolute_url已只渲染定位，后续各项按原任务错误分类留档。

## 第3波执行与收尾PASS（2026-10-15T10:58:57.031013+00:00）

生成清单500本，成功并首次发布485篇、已知TemplateRenderError失败15本（3.000%），未知失败0；失败项保留、不重建/补发。草稿0，未提交/处理中/跳过均0；发布拒绝/冲突/not_found/aborted均0。任务ID：041148d4-4869-46e1-8195-f74d97106360, d28164b9-47e4-4e5e-a724-bebd1e81e28e, 0da25c3f-d99b-4519-b691-02460a887156。

生成CLI：2026-10-15T10:45:25.024813+00:00至2026-10-15T10:45:29.970908+00:00，exit=0。

发布CLI：2026-10-15T10:46:29.176553+00:00至2026-10-15T10:46:43.882646+00:00，exit=0。

IndexNow 485/485 accepted，pending/missing/死信0，熔断关闭、无429等待。试读按书目完成485/485，失败0，待处理0，缺失0；其中清单时已有有效试读2本。sitemap任务605244b7-8437-477f-8960-8cd635d56cc6 completed，最近生成success@2026-10-15T10:47:08.442Z，覆盖本波发布时间、无待处理刷新。状态readyForNextWave=true；允许残余≤5%试读继续收尾，最终统一等终态后再补刷。

PlotNovel已发布总数1506=原50+累计新增1456；原50页面及635人工复核摘要未变，claimPromo关闭，Final/env/CID不变。自原执行基线起各服务error/permission denied均0；已知模板失败单独核销，不将其掩为任务成功。主动外部HTTP0，最终抽样尚未执行。逐本核销见[本波证据](evidence/plotnovel-bulk-publish-2026-10-15/wave-3/result.json)。

### 第3波模板失败书目（B-47修复后另行批准补发）

| novelId | task itemId | 模板错误码 |
| --- | --- | --- |
| 85585c6c-a5be-4a9b-bf18-b94666106bf5 | 9fea4f30-6fb2-4043-9b9a-9aaf7e5f3672 | ERR_TEMPLATE_VALUE_INVALID |
| 8ab64dc5-2634-4dcf-b72a-c841ba39f15c | c9ee11f6-2e63-4080-8ccd-fabce4072d2b | ERR_TEMPLATE_VALUE_INVALID |
| 8d02b946-85d1-497d-b6f6-5c44292f9ee3 | 7c1d71ca-29d8-433b-9299-085dc390543c | ERR_TEMPLATE_VALUE_INVALID |
| 94aa50b9-023c-405d-9db7-320c84d5ad94 | e093cf2a-f784-4c76-8b34-7ac211c03107 | ERR_TEMPLATE_VALUE_INVALID |
| 952e719f-6bc5-4e28-a3ff-ce09dbab085b | 7dd63c5c-6c5d-41ce-9dc2-09b89f6035f0 | ERR_TEMPLATE_VALUE_INVALID |
| 977ce050-54da-4f0b-8445-9e5752c70c8f | 574e02ec-42e0-43ee-b415-e2b2114c3b8b | ERR_TEMPLATE_VALUE_INVALID |
| 9e7319d7-dbb7-474b-8676-d6a5131f1afa | 1a834f10-9a71-4e1e-9366-4a4561eaffe4 | ERR_TEMPLATE_VALUE_INVALID |
| a36df145-db67-4cb8-a995-0fd945f4ce85 | 9f47d05b-b54e-4901-b25d-88c3fd17ed03 | ERR_TEMPLATE_VALUE_INVALID |
| a3d42871-135a-4681-a897-bc3bbbcbc23a | 4b213f00-6779-4cc7-9e8e-b73f70c421ee | ERR_TEMPLATE_VALUE_INVALID |
| a8d242e9-c7f7-44bd-85a0-b925e0619cd8 | dcf31785-94e0-4fdd-b350-e4c5d2fd5e2c | ERR_TEMPLATE_VALUE_INVALID |
| ae9d3c01-36be-467d-8bc6-a32f28b163d7 | 16091961-7b4d-44bc-a4f8-a42e0693bb79 | ERR_TEMPLATE_VALUE_INVALID |
| b1db18a4-828b-4c5e-bcc9-b7669511927f | 2d376e4d-510f-4ed8-b0d4-362f94cde44e | ERR_TEMPLATE_VALUE_INVALID |
| b95462c5-9bcb-4ab9-be95-73c54b7ee4d8 | 121ce40b-85c3-449d-b478-1bb770f1e403 | ERR_TEMPLATE_VALUE_INVALID |
| c074f114-40ef-4eab-8126-6450ae10c883 | eb2a545f-d32f-4c2f-8ea2-551296f95979 | ERR_TEMPLATE_VALUE_INVALID |
| c4d82857-3c28-464d-afe6-6bbaff7215e7 | bd1742ea-c872-4a87-b9e5-5368f92ec894 | ERR_TEMPLATE_VALUE_INVALID |

这里只登记受影响书目，不执行B-47修复或补发；第一波12本cover_url/absolute_url已只渲染定位，后续各项按原任务错误分类留档。

第三波收尾后Owner因断网明确暂停。恢复时只读核验生产CLI摘要、485篇IndexNow与试读全部完成，第四波仍未提交；原记录/页面/635人工复核/env/CID不变。未重放前三波。暂停检查点已含本地CLI未提交退回旧版的改动，恢复时保留该工作文件及diff；以已审核11f4cb11的Git blob（SHA256 62eb005c2dc0eccc783e676a3c830efdbb5bd71eb7d3ed88e4d812eac72d3c4f）和容器实际字节为执行身份，不把本地旧工作文件部署或合入。
