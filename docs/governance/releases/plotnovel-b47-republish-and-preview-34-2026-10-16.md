# PlotNovel B-47 补发与34本试读定向重跑运维记录（2026-10-16）

## 当前状态：第三阶段甲只读预演 PASS，已停手等待“批准补发”

Owner 已批准部署及第三阶段甲。第二阶段已部署验收通过；本轮只执行内存预渲染、ops plan 与 worker survey。生成0次、发布0次、试读apply0次、第三阶段甲公网HTTP0次。乙阶段不在本次执行范围内，必须由Owner看过本回报后明确说“批准补发”。

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

## 乙阶段：未授权、未执行

等Owner“批准补发”后，58本wave1生成任何失败立即停；发布拒绝/冲突立即停且不重试。目标总2035、目标草稿0、IndexNow58/58accepted，逐本报告试读成功/跳过/失败。B-46必须核对preview_chapters_written刷新与来源试读任务关联成功，既有builder只读校验书页及有效章节覆盖；开关false或全部试读结束30分钟仍未覆盖，按原手册只手动刷新一次并明确报告B-46未生效与原因。随机3篇合计最多10次代理请求，不跟随上游跳转。

34本先重新调查，不变才按固定组/requestId apply；预期13本写入非空章节、21本chapterList null跳过、失败0，实际按上游分布报告。有章节写入同样核对sitemap。IndexNow熔断/429/死信/非accepted、permission denied、主worker积压持续增长、原635或1977摘要变化立即停止，不自行修复。回滚需Owner另批兼容标志，固定目标v0.6.0 Final493eb23b034b0410780228535b3e293e4ee91f9a，保留已发布58篇。

## 证据与治理

[甲阶段完整证据](evidence/v061-release/phase3a/phase3a-result.json)，包含58本逐条原失败字段/预渲染状态、plan、精确清单SHA、34本分组与原survey命令、保护摘要。原日志、退出码与脚本保留；Notion五处已同步并回读PASS（2026-10-16T14:17:38.721Z），历史282397字符保持；[回读收据](evidence/v061-release/phase3a/notion-readback-final.json)已保存。发版级开发日志只保留v0.6.1唯一条目，运维不重复新增发版条目。
