# PlotNovel B-47 补发与34本试读定向重跑运维记录（2026-10-16）

## 当前状态：第三阶段乙全部完成，最终验收PASS（JST 2026-10-17）

Owner已将首次book_upstream_code_leak裁定为检查器误报并授权续跑。仅修正辅助检查器后，原3样本9项公网检查全PASS；禁止独立码命中0、偶然重合18次，新增HTTP9/累计12。58本补发已完成；34本按甲阶段固定组/requestId执行，13成功写21章、21本chapterList null跳过、失败0。两组B-46自动覆盖均通过，无手动刷新；保护摘要、env及容器保持，服务error/permission denied0。

甲阶段与首次停手历史证据保留，Owner裁定三项依据、最终34本逐项结果和收官见文末。

## 固定身份与保护

- Final `cb255e0f1c93041eda6aefeefbb541d7eddfc15f`；ops HEAD `c3578aa6f8c18bc0ee39bcd14da95703aaad3098`，独立分支不合入集成线。
- env SHA256 `23425e8289854167d53d91f1f3673e383239458f0ae76fb4a5c695559e224509`，仅部署版本字段变化；FEATURE_SITEMAP_AUTO_REFRESH=true。
- 原1977篇摘要 `42499c6f369bbf44008e62715da659b0f68248e1b8d80c3ecc29a108c95d3f6c`，635人工复核摘要 `ac2b4b10e414ef8c7520d718c72439140b5a3c1f7a34a1d9bbca44b6640a386f`，预演前后保持。
- 未改公开网址、既有章节或发布内容，未调用上游，未保存文章正文、封面原值或口令码。第二阶段代理抽查4/6次全PASS，第三阶段甲不增加请求。

## 甲1：58本内存预渲染

原生web_app、RepeatableRead、READ ONLY、cwd=/app，复用模板选择、promo解析、countPreviewChapters与renderNovelArticleDraft，**58/58成功**。原12本已有10-15 09:38诊断；另46本用v0.6.0的原article/render模块（仅导入路径指向临时只读文件，其余依赖与Final相同）在内存复现原失败，58本原失败均为ERR_TEMPLATE_VALUE_INVALID / body / cover_url / absolute_url。没有持久化产物或调用generate/publish接口。逐本原失败字段与新渲染状态见证据JSON。

## 甲2：补发plan

脚本0644复制到web /tmp，SHA256 `0217ad5978a9f4d43c320fed963f479dd43d79d8099013bf74937185590f2129`，宿主/容器字节一致。同一actor `71f0e655-0640-4f07-bcbb-041f027fa7cb`、admin/super_admin/active；角色web_app、事务只读。候选ID集合与交接固定58本完全相等，wave1单chunk58。

| 准入统计 | 数量 |
| --- | ---: |
| Population | 3860 |
| Eligible | 58 |
| already_exists | 1977 |
| promo_link_missing | 1186 |
| promo_link_not_ready | 635 |
| duplicate_title_in_link_theater | 4 |

清单SHA256 `ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639`。容器文件 `/tmp/plotnovel-b47-20261016-manifest.json`；宿主0600文件 `/opt/cps-novel/shared/operations/plotnovel-b47-republish-2026-10-16/manifest.json`；本地证据原字节一致。乙阶段使用同一清单、actor、脚本和wave1，不重建候选。生成requestId `plotnovel-b47-republish-2026-10-16-w1-c1`，发布requestId `plotnovel-b47-republish-publish-2026-10-16-w1-c1`。

## 甲3：34本只读调查与固定分组

固定34个source item，原生worker_app、READ ONLY，按当前channel_app读回；**全部仍在MoboReader一组**（不沿用“部分已改挂”的假设）。novel.status=published34，可读章节0的34本，在途试读0。原preview-backfill-recovery入口不带--apply，candidateCount=34、truncated=false、batches=[]，credential preflight usable；失败分类MoboReader Preview read failed=34。未重跑上游，所以13本/21本预期尚未经本次执行核实。

| 分组 | channel_app | 数量 | 固定requestId | candidateCount |
| --- | --- | ---: | --- | ---: |
| moboreader | `85c2fb3e-28f8-476a-83f2-9647e2206192` | 34 | `preview-b42-34-2026-10-16-moboreader` | 34 |

source-item源文件SHA256 `fd467de40f3d72a89f960bea21cd5f1a34c8b6d37e2c1b393861c337daa9c82f`；分组JSON按sort_keys与紧凑separators编码的SHA256 `00b721679ee31d2d4cb4d3b5466e2a07017ddd515defa928806636f0eb77946e`。原命令和全量sourceItemIds见[证据JSON](evidence/v061-release/phase3a/phase3a-result.json)。乙阶段先重新调查；数量或分组变化即停，沿用原requestId和sourceItemIds。

| sourceItemId | novelId | novel.status | 可读章 | 在途试读 |
| --- | --- | --- | ---: | ---: |
| `02b6dff3-d973-4922-ad43-d4ab61a895b5` | `7781e177-99e1-4cd2-ad05-51eb6cf9d6a8` | published | 0 | 0 |
| `031216f8-1a1b-463b-856a-74b4712c889b` | `581501ea-da86-4be2-88d5-8a6a4a73e40b` | published | 0 | 0 |
| `0325c057-214b-46d1-a1f5-5f481e03d7b1` | `02a68b43-375c-4d23-9b45-703a7fe464e1` | published | 0 | 0 |
| `056374b0-ec90-4b5d-9543-aef5b081aeaf` | `47a40ac4-eeb5-4ccb-b7cb-0767b2de3d78` | published | 0 | 0 |
| `0dd6a38a-e438-4654-b608-3bc60743c304` | `62729dc9-647f-490f-9b34-74561f68bb36` | published | 0 | 0 |
| `0faed754-957d-461f-abe6-00c1b1e9e32b` | `cc9d20ab-1809-4864-b57e-d62c64dc0170` | published | 0 | 0 |
| `1044615d-8566-4134-910e-b5220166b0a9` | `44d30de5-8739-4b92-a11c-53b0d561d0c5` | published | 0 | 0 |
| `11e79e01-415e-4c38-9429-3b2bb3157cd6` | `3ae09229-d70c-49f1-a50b-b4e923ff5707` | published | 0 | 0 |
| `14006896-96c5-4acd-b833-9d830e2f3101` | `ba912bad-c42f-417b-80dd-7455691bae9e` | published | 0 | 0 |
| `175c6473-dbbd-41a7-9b5a-e720f1ada72c` | `46590824-8755-43b4-a76f-b6d4b02419ce` | published | 0 | 0 |
| `182ae182-d5c2-4ab3-a45e-c312051fd04c` | `21721548-0e10-43b1-8f49-0a7d15cbfdb2` | published | 0 | 0 |
| `185d2e13-e620-483d-8fde-21441afb372e` | `1421bed3-2a1e-4ebb-96fa-7e46c687e090` | published | 0 | 0 |
| `1df34abe-29f9-4b4f-a897-ebb5101ae8fc` | `75ca466a-03a4-430c-862c-8c759f309b48` | published | 0 | 0 |
| `1f0df82e-498b-44cb-b66e-06c57d6d1890` | `95d89a43-9b6d-4b18-b30d-c2bd98f0bede` | published | 0 | 0 |
| `1f9c9b7b-d58a-4557-8f1a-ed2c441569cb` | `1600b837-a99d-42b8-acfa-105e0d6f4a12` | published | 0 | 0 |
| `217e972c-1b14-43f9-86e9-c40606e9f7bb` | `eb05f5d6-767f-4e58-bf93-d969f9c40a52` | published | 0 | 0 |
| `234abdc6-224c-4dab-b73b-565bebf51302` | `87593459-f52d-42d5-aac1-f91677ff9ce4` | published | 0 | 0 |
| `24c306c7-1fd0-4700-baa4-3a484cd46837` | `63f6ccbc-7060-4b59-b50d-755436f9f22a` | published | 0 | 0 |
| `2cb5ec08-7a37-4ec3-8258-52cd10ea1d73` | `655ff0c8-308c-406c-ad08-c7282f75784e` | published | 0 | 0 |
| `3236281e-8892-422f-8f46-f23e916ae834` | `bb38cdd8-3e4a-4c0b-93d2-97277fe6795d` | published | 0 | 0 |
| `35980fa4-b3f3-4057-adcd-28cb74b02523` | `42f4f206-af4b-49b4-94c3-d6ac207010cb` | published | 0 | 0 |
| `366461bb-fbe3-418a-ab65-04b184cf0140` | `5dea56d0-88e8-4c1a-a786-53fda5bca603` | published | 0 | 0 |
| `38c5670b-242e-403d-b921-0c2bbe1b2e66` | `319bf8e0-cc25-43f5-9dc8-5bf23a655044` | published | 0 | 0 |
| `3b2987f7-1ff4-48ba-9b55-8363a5783d53` | `89675844-f5f6-4114-8a1b-03065e4343ff` | published | 0 | 0 |
| `3cda0227-f309-40ea-989a-0411a8fa5460` | `058ee325-ed77-4b4c-8755-558e68c7ab75` | published | 0 | 0 |
| `3d427bac-d7cc-440a-829c-cc5c319ccc74` | `65666038-7463-49c0-bfad-9526b91d0d8f` | published | 0 | 0 |
| `3d5c16dd-44ed-44b7-af61-26dfe50d794a` | `2e8d4495-f966-4471-9241-c1bd0c17a8b2` | published | 0 | 0 |
| `3e858f0f-c235-4224-9783-d4dddbdf77a9` | `1583d476-069b-4928-9932-42607ceebb40` | published | 0 | 0 |
| `48652907-0196-4ec7-a3ad-c9ad3e1df6fa` | `e7f3856d-e196-4f53-9ab7-5bc9189a6983` | published | 0 | 0 |
| `4b87f14c-e188-4205-b612-a7cdfd634e7f` | `e1a7352d-a077-4372-8bc8-5f3afb5f7ceb` | published | 0 | 0 |
| `4cc30b02-93c4-4fac-a5d1-754a79222a35` | `15ceba58-e558-4bf4-868b-7fc5f6ed6533` | published | 0 | 0 |
| `4d46f103-1780-4000-9ecd-86b6dafb9ccf` | `858bbc2f-1437-4406-b1d5-07e21f2c1688` | published | 0 | 0 |
| `537aab35-9d84-4f4f-a02a-d48c2a1234a7` | `901d3e0f-f9fb-42f0-b75c-cdab86ce9d22` | published | 0 | 0 |
| `6681979c-cfed-459d-8669-1f1d5f5d20e8` | `9cb66af3-18fa-427f-bd6e-d4ddcf0e95de` | published | 0 | 0 |

## 乙阶段既定执行规则（方案历史，实际结果见下方）

既定规则：58本wave1生成任何失败立即停；发布拒绝/冲突立即停且不重试。目标总2035、目标草稿0、IndexNow58/58accepted，逐本报告试读成功/跳过/失败。B-46必须核对preview_chapters_written刷新与来源试读任务关联成功，既有builder只读校验书页及有效章节覆盖；开关false或全部试读结束30分钟仍未覆盖，按原手册只手动刷新一次并明确报告B-46未生效与原因。随机3篇合计最多10次代理请求，不跟随上游跳转。

34本先重新调查，不变才按固定组/requestId apply；预期13本写入非空章节、21本chapterList null跳过、失败0，实际按上游分布报告。有章节写入同样核对sitemap。IndexNow熔断/429/死信/非accepted、permission denied、主worker积压持续增长、原635或1977摘要变化立即停止，不自行修复。回滚需Owner另批兼容标志，固定目标v0.6.0 Final493eb23b034b0410780228535b3e293e4ee91f9a，保留已发布58篇。

## 证据与治理

[甲阶段完整证据](evidence/v061-release/phase3a/phase3a-result.json)，包含58本逐条原失败字段/预渲染状态、plan、精确清单SHA、34本分组与原survey命令、保护摘要。原日志、退出码与脚本保留；Notion五处已同步并回读PASS（2026-10-16T14:17:38.721Z），历史282397字符保持；[回读收据](evidence/v061-release/phase3a/notion-readback-final.json)已保存。发版级开发日志只保留v0.6.1唯一条目，运维不重复新增发版条目。


## 第三阶段乙首次停手历史（Owner后续已裁定检查器误报）

Owner已明确“批准补发”，授权固定58本及甲阶段34本分组/requestId。已完成58本生成与发布及试读、IndexNow和B-46覆盖验收；公网首篇书页口令码检查未通过，立即停止后续业务提交。34本只读重查仍candidateCount34、分组未变，**apply=0次**。后续两次只读复核未复现，但原首次命中计数/上下文未保存，不能判定已通过，也不能确认是真实暴露还是误命中；未放宽原检查、未换样本绕过、未自行修业务数据。

| 58本验收项 | 结果 |
| --- | --- |
| 生成 | success58 / failed0 / skipped0；任务e9b60199-1bbc-48a0-bb73-bc6555490c91 completed |
| 发布 | 58；rejected0 / conflict0 / not_found0 / aborted=false；总2035，目标草稿0 |
| IndexNow | 58/58 accepted；无熔断/429等待/死信/blockedUrls |
| 试读 | success58 / skipped0 / failed0；写入非空章节173，积压0 |
| B-46 | preview_chapters_written自动刷新completed；来源任务关联成功，coveredItemCount58、triggerCount1 |
| sitemap | 新58书页+173有效章节全覆盖；全PlotNovel2035书页/6044有效章节，缺失0、意外章节0、go URLs0 |
| 手动刷新 | 0次，B-46已生效 |
| 保护 | 原1977篇、635人工复核摘要不变；env/六容器ID不变，六服务error/permission denied0 |

试读任务 `29c70278-aa65-4787-9c46-8a3400c3fe6c` 于14:59:23.669Z完成，自动sitemap任务 `92554c1b-f02f-4ae1-aa3f-43f5f15677db` 于14:59:45.552Z完成，间隔21.883秒；params.triggeredBy为moboreader.preview_refresh.v1#来源任务ID。静态release ID等于自动任务ID，既有builder在web_app/RepeatableRead/READ ONLY下核对，无手动刷新。

### 公网检查停点

随机选定3篇，计划9/10代理GET。首次书页200，CTA/hint/canonical检查越过后在book_upstream_code_leak断言停止；随后仅两次同页脱敏只读定位，分别扫描2035个受保护口令码，最新使用与原检查器相同的规范化规则，两次匹配均0，自己/其它书命中均0。**本阶段总请求3/10次，不跟随上游，未保存原始正文、封面原值或口令码。** 首次检查器未保存具体命中计数/上下文，因此公网验收仍未通过，三篇书页/跳转/中间页整套矩阵未完成，不能把复核0写成整套通过。

首篇articleId `7728ebb3-699a-4048-9e2d-7ebb377fd75e`；路径 `/novel/the-adoptive-father-was-critically-ill-and-his-wife-personally-destroyed-his-last-will-pgmatps3g`。原检查和两次复核结果分别见public-result.json、public-diagnostic.json、public-diagnostic-exact-normalization.json。远端停手文件 `/opt/cps-novel/shared/operations/plotnovel-b47-republish-2026-10-16/phase3b/STOP.json` 已保存；不删除停手证据，不自行恢复业务提交。

### 34本未执行与后续承接

34本已在补发前及停手后用原入口只读重查，均为甲阶段同一MoboReader组、published34、可读章0、在途0、candidateCount34、credential usable。固定requestId `preview-b42-34-2026-10-16-moboreader` 与甲阶段sourceItemIds完整保留；未带apply，没有新34本任务，13写入/21null跳过仍只是预期。**当前停点是公网验收异常，须Owner裁定后续处理；不得自行越过原门禁执行34本。** 保留58篇和全部旧章节，后续恢复不重生成或重发已完成58本。

### 58本逐本试读结果

| novelId | sourceItemId | 写入非空章 | status | skipped reason | failure kind |
| --- | --- | ---: | --- | --- | --- |
| `8ab64dc5-2634-4dcf-b72a-c841ba39f15c` | `001c8f37-1a3d-434b-b1de-3e8d393a499d` | 3 | success | — | — |
| `72c15194-679a-4a7e-8942-3ba5cbe6e618` | `032d7794-d3d4-4d88-8f29-613bc5b51667` | 3 | success | — | — |
| `7580b19e-fc84-408f-8ddd-c49bbda9d6d4` | `03a5f8a0-b07a-481e-9f7c-abe998975748` | 3 | success | — | — |
| `1fca788e-88c7-4fc1-86d8-99f1abf06dcd` | `06c59f35-0bfd-493d-97ac-161e959da29d` | 3 | success | — | — |
| `f7f84c54-1ddd-410b-b0b3-b81bff2534df` | `070aeeb7-7c29-44bb-a0b4-d415f84da5ed` | 3 | success | — | — |
| `12a6c73b-f700-416d-8595-86d9779113c5` | `0c6e4fd0-0d6a-4ece-9dd7-3174d7f834f6` | 3 | success | — | — |
| `c4d82857-3c28-464d-afe6-6bbaff7215e7` | `0d103fb2-322a-4ea4-bda0-eb63a30156ab` | 3 | success | — | — |
| `4b6a3c3d-88ce-4533-bcdc-353e7c285b0d` | `0dec0fff-cb33-446c-854d-4464fbdf2aea` | 3 | success | — | — |
| `47ba9c6f-054e-4c94-8d3e-421a550da060` | `117dd956-8108-4e25-afc9-243e6cf3e84f` | 3 | success | — | — |
| `40cee355-5e76-481a-bf91-00bc369d1514` | `1251c062-2dc9-4789-92f4-617dda03a515` | 3 | success | — | — |
| `ecb9ab94-cf60-417c-99f1-86a6ecfd8160` | `12aac5fd-bab5-467d-b89f-7ec5b8d1f865` | 3 | success | — | — |
| `fe45dcb3-90e8-4837-b379-b95a9c0610a0` | `14cb444c-ef0c-4e7e-b07a-03a000f042fa` | 3 | success | — | — |
| `410d0cdf-8dbe-4bbb-ada8-94491834840c` | `19599802-d30f-40f6-a198-c0b02ea61d04` | 3 | success | — | — |
| `0c5b3037-73f9-48d6-8e88-097c17ab5503` | `2188d995-10f2-45a8-bf32-1f56e43e4f57` | 3 | success | — | — |
| `8153b554-f04d-41e7-82cc-ef77e9b3b832` | `26045a50-ae19-495d-ade7-afc94648e2e5` | 3 | success | — | — |
| `263b2b6c-3189-4d04-9183-1bac7b042483` | `26dfbb75-94a5-4cf3-a076-298cf3891a0d` | 3 | success | — | — |
| `c074f114-40ef-4eab-8126-6450ae10c883` | `28210a04-67c9-432f-bcdd-375eb9f486db` | 3 | success | — | — |
| `8d02b946-85d1-497d-b6f6-5c44292f9ee3` | `29ef315e-0423-4a5e-a365-72cee54efcd8` | 3 | success | — | — |
| `f7892692-4271-4668-a317-2368aeaf1ab0` | `2b87e95c-9f0c-4f13-a7a9-cb93b2ede439` | 3 | success | — | — |
| `f2913f03-390c-4a7e-877e-e80782962a16` | `2d74e088-e8e8-4555-8b96-6652923cf5e4` | 3 | success | — | — |
| `94aa50b9-023c-405d-9db7-320c84d5ad94` | `2dec16d5-505f-4994-91c8-e61623418f6a` | 3 | success | — | — |
| `21cc69f0-eb6a-4abc-bfd9-f5774fbe5b6d` | `2ef63d7b-9344-45f6-b559-58c3660f91a0` | 3 | success | — | — |
| `ece1d680-f62a-4715-ab88-3b9ee18aa511` | `2fa33c4e-c8c9-46cb-bf2d-a86c810f9403` | 3 | success | — | — |
| `d0fc635e-71fa-4dbc-a8a0-72fb5fa0a695` | `32983211-0db1-4a79-a294-e2a4d194aad0` | 3 | success | — | — |
| `77bbead2-9989-4277-a0f2-4a4cd9900d5b` | `334b69f9-ee2c-4b80-8818-494ca6134cb4` | 3 | success | — | — |
| `eb7a743f-051b-4335-a470-74a60862b7ff` | `3383b622-7239-4cb2-904c-d7391dae3339` | 3 | success | — | — |
| `c631b659-4f79-4768-80ce-4c61f2966c6e` | `33c56a21-4a69-44b5-bb51-8c33436c035a` | 3 | success | — | — |
| `d930fbdc-02ed-4285-a00c-b55925c120f9` | `345fe7da-78c1-46d1-ad8c-ea5bea649587` | 3 | success | — | — |
| `85585c6c-a5be-4a9b-bf18-b94666106bf5` | `363ca41b-bc02-4a20-8f12-177276eb3212` | 3 | success | — | — |
| `5fe258f5-d752-4b32-95e7-00f0ad600439` | `370c3a03-7fda-46da-bec7-23449a9533d5` | 3 | success | — | — |
| `952e719f-6bc5-4e28-a3ff-ce09dbab085b` | `37f066e1-605e-44ba-8a25-2239fc5a1107` | 3 | success | — | — |
| `668ad359-6ec1-45c8-b588-575e2c76c9ae` | `3c2a5b58-3a64-42c5-a158-0b9719d418be` | 3 | success | — | — |
| `57b18a9b-37f6-4f57-911b-58a4591e730a` | `3e7c4fcd-37b9-4b00-af89-507b0bfd67f5` | 3 | success | — | — |
| `00d9bd97-fe97-429e-9d1b-39ee466f5f05` | `3e8b9b5b-1689-4d39-a15d-98730e7a8bfd` | 3 | success | — | — |
| `77ad1197-8ae7-4a8d-9777-e7cb991d8c6e` | `3f9fb5ab-767a-428b-ad3b-72c8dffc99cb` | 3 | success | — | — |
| `2bd00daa-1d89-4191-868e-47cea348bc87` | `44eacb04-aa51-43c0-9578-5e6430ed1f5a` | 3 | success | — | — |
| `4d3a5068-7a50-46c4-9a88-810e6970c139` | `45c55b6f-d45f-4c2f-ab8d-21c16cd6c821` | 3 | success | — | — |
| `2b98da7d-898a-4a01-954a-a0a928dcb2a7` | `46635b8c-a7b9-428b-9da8-7c30e7c2ff9d` | 3 | success | — | — |
| `3fefed63-17e5-419c-8745-12184ec43b01` | `489eaca7-bc7f-459f-9178-cabcbc952d22` | 3 | success | — | — |
| `dfd67f4a-a014-42f0-9ce7-e1f5b630d58a` | `4a0cbcca-8ca8-48f4-b4eb-d4d2a25c2d10` | 3 | success | — | — |
| `a8d242e9-c7f7-44bd-85a0-b925e0619cd8` | `4b2dfc34-d989-4d30-bf60-f4ba8fde824e` | 3 | success | — | — |
| `977ce050-54da-4f0b-8445-9e5752c70c8f` | `4b840aa4-5ace-4ec3-94af-f821764d41ab` | 3 | success | — | — |
| `346954a7-c6e7-494d-8918-ceccff8b2340` | `4c6a4088-18a5-4eaf-a9ba-0add0baed86c` | 3 | success | — | — |
| `716128d5-ebd1-4eb6-8631-386249a76027` | `4cb59103-8ca3-4ece-8409-c546bba76be2` | 3 | success | — | — |
| `798613b2-0810-4abd-be32-81b9dc23311d` | `4cc8935d-4305-4d29-a1fd-0e74aa68bdf3` | 3 | success | — | — |
| `ae9d3c01-36be-467d-8bc6-a32f28b163d7` | `4ccf0bf1-6f10-4f62-a3e4-483bbd36b65e` | 3 | success | — | — |
| `b1db18a4-828b-4c5e-bcc9-b7669511927f` | `4f85a18b-efe6-4290-80ca-3431d19f6d00` | 3 | success | — | — |
| `da0ece41-6216-4cf4-849d-c75029cadf0e` | `518c01c0-c2af-48e0-aa72-83f468c86158` | 3 | success | — | — |
| `a36df145-db67-4cb8-a995-0fd945f4ce85` | `51b64da3-0de6-451a-b837-23fb9da2c354` | 3 | success | — | — |
| `6ece0a4d-9f4a-405c-b4aa-78e10df25628` | `52b76cbb-0c9b-4016-8128-fb739eb98896` | 3 | success | — | — |
| `da373ead-ae9f-4fb2-a319-6041e33649d8` | `5393c43f-6a70-42d2-a118-22b9b2cffedf` | 3 | success | — | — |
| `9e7319d7-dbb7-474b-8676-d6a5131f1afa` | `8613a2ef-ec6e-4d8d-bf50-c4ba5332d057` | 3 | success | — | — |
| `e1cff180-c9d7-402b-9c3b-b24122b52310` | `8e511a2c-c532-4179-b09f-25f30bb259d6` | 3 | success | — | — |
| `a3d42871-135a-4681-a897-bc3bbbcbc23a` | `b6c7f512-1105-4e04-a723-62f9089c9d6d` | 3 | success | — | — |
| `2d0ae15d-6734-4840-b8c3-88c6e7bdb719` | `b83a5d13-bf30-488e-9bca-b4420171bef9` | 3 | success | — | — |
| `22e4be9a-3936-43dc-8c09-1751a9c8b052` | `bc06d97c-3987-42e0-86c2-38c680ca2b59` | 3 | success | — | — |
| `b95462c5-9bcb-4ab9-be95-73c54b7ee4d8` | `d3b095d8-2dc4-44ee-b846-88b7771c4589` | 3 | success | — | — |
| `1734d288-229c-439b-8d02-2e759fa4da6e` | `e8f94e3b-9a54-4627-a3d4-12d3b0634487` | 2 | success | — | — |

### 执行偏差与证据

只读监督器的1977-ID保护过滤最初超出单命令参数长度，改用stdin传psql，原查询口径不变。覆盖辅助程序复制临时文件时保留host uid1000，导致应用uid1001读不到；恢复manifest属主1001:1001、模式0600并复核原SHA不变，检查夹具另用0644输入和甲阶段已知novelIds过滤；没有执行不可授权的source-item查询。全过程服务permission denied0；原ops脚本、编排和门禁未改。原失败日志保留。公网检查异常独立保留为STOP，不作为已修复夹具问题处理。

[乙阶段完整结果与逐条证据](evidence/v061-release/phase3b/phase3b-result.json)，[远端停手快照](evidence/v061-release/phase3b/remote/STOP.json)。技术状态为“58本完成，公网验收未通过，34本待处理”，不登记为乙阶段全完成。Notion五处已同步并回读PASS（2026-10-16T15:11:34.874Z），原历史293077字符在还原本轮指定更新后逐字一致；[乙阶段回读收据](evidence/v061-release/phase3b/notion-readback.json)。发版日志仍只有原v0.6.1唯一条目。


## Owner裁定与续跑收官（JST 2026-10-17）

### 首次公网检查误报裁定依据

Owner明确裁定此前book_upstream_code_leak为检查器误报，不是真实泄露，授权修正自己的检查器、原3样本新增9次HTTP复查，全部PASS后按甲阶段原组/requestId继续34本。以下为Owner转述的主控只读证据；未输出任何码值：

1. 2035个受保护口令码全部为6位纯数字。本次新检查器从原只读查询得到2035项并逐项断言六位纯数字，统计一致。
2. 原检查器对整页HTML做纯子串匹配。主控两次抓取同一书页，每页96个不同6位数字窗口，主要来自封面地址中的13位时间戳，偶然命中概率约17.8%；两次有32个窗口不同，来自每次变化的推荐书封面地址，因此可出现首轮命中、复核未复现。这些96/32/17.8%来自Owner提供的主控证据，未为重算它们增加HTTP请求。
3. 结构上书页取不到口令码；仅src/app/go/[code]/app/page.tsx经src/app/go/_lib/code-mode-page-data.ts调用code_mode_upstream_code()。Owner确认web_app直接读upstream_code会permission denied、部署后已验证。本次只读检查源码调用关系，不再在生产做负向拒绝探针；六服务permission denied保持0。

历史STOP文件和原证据不删除。远端新owner-resolution.json记录本次裁定，明确取代历史误报停点；原58篇不重新生成或发布。

### 检查器修正与原样本完整公网复查

仅修改辅助检查器，不改产品、补发脚本或业务门禁。匹配改为 `(?<![0-9])CODE(?![0-9])`；嵌在更长数字串中的命中只计“偶然重合”。独立数字边界命中严格停手，记录本篇/其它篇、可见文本/属性名/脚本JSON键名等位置，元数据中的数字打码；所有受保护码均替换为[CODE]后才保存该页规范化HTML。保留原中间页显示本篇码的既定合同，校验码卡身份、no-store/noindex和商店链接；其它书独立码仍一律停手。7条本地测试通过，包含独立数字、字母邻接仍算独立、长时间戳、属性/JSON键名脱敏、Unicode转义、Location及HTML全码替换。

仍为原定3篇，不换样本。3书页200、3个/go相对302、3中间页200/no-store/noindex/本篇码卡一致，全部PASS；禁止的独立码命中0，长数字串偶然重合 **18次**，逐响应计数见boundary-scans和public-accepted.json。没有禁止的独立命中，故真实生产脱敏HTML快照0份；该分支已由测试承重。未输出码值、正文或封面原值，未跟随上游跳转。

本轮实际目标站HTTP为9次，累计 **12次**（上轮3+本轮9）。第三样本/go首个传输尝试curl35，随附curl手册定义为SSL握手失败，未发出目标HTTPS GET；保留原传输失败记录后只补该/go及/app两次，未重跑已通过7项。本轮传输尝试10次=HTTP9+TLS握手失败1，阶段传输尝试累计13；HTTP预算仍9新增/12累计。计数单位明确分开，原失败日志和两个独立请求台账全部保留，最终合并矩阵为9项/3篇。

### 34本执行及逐本结果

原入口重查仍candidate34，甲阶段同一channel_app `85c2fb3e-28f8-476a-83f2-9647e2206192`，原34个sourceItemIds、固定requestId `preview-b42-34-2026-10-16-moboreader`；credential usable。仅一次apply，任务 `ba768571-d0da-4d92-bf79-3f4bd34e3a68` completed。实际 **success13 / skipped21 / failed0**，13本共写入 **21个非空章节**，21本skipped reason均为 `upstream_preview_chapter_list_null`；与预期13写入/21null跳过/0失败一致。无补提交、无重试，条目attemptCount均见原JSON。

| sourceItemId | novelId | 写入章 | status | skipped reason | failure kind |
| --- | --- | ---: | --- | --- | --- |
| `02b6dff3-d973-4922-ad43-d4ab61a895b5` | `7781e177-99e1-4cd2-ad05-51eb6cf9d6a8` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `031216f8-1a1b-463b-856a-74b4712c889b` | `581501ea-da86-4be2-88d5-8a6a4a73e40b` | 1 | success | — | — |
| `0325c057-214b-46d1-a1f5-5f481e03d7b1` | `02a68b43-375c-4d23-9b45-703a7fe464e1` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `056374b0-ec90-4b5d-9543-aef5b081aeaf` | `47a40ac4-eeb5-4ccb-b7cb-0767b2de3d78` | 2 | success | — | — |
| `0dd6a38a-e438-4654-b608-3bc60743c304` | `62729dc9-647f-490f-9b34-74561f68bb36` | 2 | success | — | — |
| `0faed754-957d-461f-abe6-00c1b1e9e32b` | `cc9d20ab-1809-4864-b57e-d62c64dc0170` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `1044615d-8566-4134-910e-b5220166b0a9` | `44d30de5-8739-4b92-a11c-53b0d561d0c5` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `11e79e01-415e-4c38-9429-3b2bb3157cd6` | `3ae09229-d70c-49f1-a50b-b4e923ff5707` | 2 | success | — | — |
| `14006896-96c5-4acd-b833-9d830e2f3101` | `ba912bad-c42f-417b-80dd-7455691bae9e` | 2 | success | — | — |
| `175c6473-dbbd-41a7-9b5a-e720f1ada72c` | `46590824-8755-43b4-a76f-b6d4b02419ce` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `182ae182-d5c2-4ab3-a45e-c312051fd04c` | `21721548-0e10-43b1-8f49-0a7d15cbfdb2` | 1 | success | — | — |
| `185d2e13-e620-483d-8fde-21441afb372e` | `1421bed3-2a1e-4ebb-96fa-7e46c687e090` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `1df34abe-29f9-4b4f-a897-ebb5101ae8fc` | `75ca466a-03a4-430c-862c-8c759f309b48` | 1 | success | — | — |
| `1f0df82e-498b-44cb-b66e-06c57d6d1890` | `95d89a43-9b6d-4b18-b30d-c2bd98f0bede` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `1f9c9b7b-d58a-4557-8f1a-ed2c441569cb` | `1600b837-a99d-42b8-acfa-105e0d6f4a12` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `217e972c-1b14-43f9-86e9-c40606e9f7bb` | `eb05f5d6-767f-4e58-bf93-d969f9c40a52` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `234abdc6-224c-4dab-b73b-565bebf51302` | `87593459-f52d-42d5-aac1-f91677ff9ce4` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `24c306c7-1fd0-4700-baa4-3a484cd46837` | `63f6ccbc-7060-4b59-b50d-755436f9f22a` | 1 | success | — | — |
| `2cb5ec08-7a37-4ec3-8258-52cd10ea1d73` | `655ff0c8-308c-406c-ad08-c7282f75784e` | 1 | success | — | — |
| `3236281e-8892-422f-8f46-f23e916ae834` | `bb38cdd8-3e4a-4c0b-93d2-97277fe6795d` | 2 | success | — | — |
| `35980fa4-b3f3-4057-adcd-28cb74b02523` | `42f4f206-af4b-49b4-94c3-d6ac207010cb` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `366461bb-fbe3-418a-ab65-04b184cf0140` | `5dea56d0-88e8-4c1a-a786-53fda5bca603` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `38c5670b-242e-403d-b921-0c2bbe1b2e66` | `319bf8e0-cc25-43f5-9dc8-5bf23a655044` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `3b2987f7-1ff4-48ba-9b55-8363a5783d53` | `89675844-f5f6-4114-8a1b-03065e4343ff` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `3cda0227-f309-40ea-989a-0411a8fa5460` | `058ee325-ed77-4b4c-8755-558e68c7ab75` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `3d427bac-d7cc-440a-829c-cc5c319ccc74` | `65666038-7463-49c0-bfad-9526b91d0d8f` | 2 | success | — | — |
| `3d5c16dd-44ed-44b7-af61-26dfe50d794a` | `2e8d4495-f966-4471-9241-c1bd0c17a8b2` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `3e858f0f-c235-4224-9783-d4dddbdf77a9` | `1583d476-069b-4928-9932-42607ceebb40` | 2 | success | — | — |
| `48652907-0196-4ec7-a3ad-c9ad3e1df6fa` | `e7f3856d-e196-4f53-9ab7-5bc9189a6983` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `4b87f14c-e188-4205-b612-a7cdfd634e7f` | `e1a7352d-a077-4372-8bc8-5f3afb5f7ceb` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `4cc30b02-93c4-4fac-a5d1-754a79222a35` | `15ceba58-e558-4bf4-868b-7fc5f6ed6533` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `4d46f103-1780-4000-9ecd-86b6dafb9ccf` | `858bbc2f-1437-4406-b1d5-07e21f2c1688` | 0 | skipped | upstream_preview_chapter_list_null | — |
| `537aab35-9d84-4f4f-a02a-d48c2a1234a7` | `901d3e0f-f9fb-42f0-b75c-cdab86ce9d22` | 2 | success | — | — |
| `6681979c-cfed-459d-8669-1f1d5f5d20e8` | `9cb66af3-18fa-427f-bd6e-d4ddcf0e95de` | 0 | skipped | upstream_preview_chapter_list_null | — |

### B-46与最终保护验收

34本来源试读任务17:00:37.363Z终态，自动sitemap任务 `c636f195-508d-4444-ba8b-2b061cb350bf` 于17:01:04.584Z完成，间隔 **27.221秒**；reason=preview_chapters_written、triggeredBy关联该来源任务，coveredItemCount13、triggerCount1。静态release ID与该自动任务相同。既有builder在web_app/RepeatableRead/READ ONLY下核对en31、de1、fr1、pt-BR1：34书页和21有效章节全部覆盖、缺失0。58本及原1977篇的2035书页/6044有效章节仍全覆盖，新58对应173章、旧1977对应5871章，意外PlotNovel章节和/go sitemap URLs均0。**两组均自动完成，无手动刷新，B-46已生效。**

最终IndexNow58/58 accepted、无熔断/429等待/死信/积压；目标草稿0、PlotNovel发布总2035，试读主worker积压0。原1977发布和635人工复核摘要、env SHA与六容器ID不变，六服务error/permission denied0。两个CPS参考仓HEAD及status与原快照逐字一致。未更改公开网址、封面原值、grants、迁移、依赖、环境变量、能力或白名单，未回填。

### 最终结论与治理

第三阶段乙 **PASS，全部完成**：58补发、34定向试读、公网原3样本和两组B-46自动覆盖均验收通过。历史公网误报STOP已由Owner明确裁定关闭，原始证据保留；新边界检查如出现禁止的独立码，仍按原停手口径停止。

[最终机器结果与Owner裁定](evidence/v061-release/phase3b-resume/complete-result.json)，[9项公网合并验收](evidence/v061-release/phase3b-resume/public-accepted.json)，完整原始日志/退出码/逐条计数/34书结果见新证据目录。PATCH台账、发布记录和原唯一发版日志补记同步更新；不新增第二条发版日志。CHANGELOG用原生成器core.abbrev=7更新，annotated v0.6.1仍指向原Final，ops独立分支不合入。Notion本轮五处已同步并回读PASS（2026-10-16T17:06:33.574Z），原历史297179字符在还原本轮指定更新后逐字一致；[最终回读收据](evidence/v061-release/phase3b-resume/notion-readback.json)。
