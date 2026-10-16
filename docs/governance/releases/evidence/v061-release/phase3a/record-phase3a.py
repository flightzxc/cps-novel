from pathlib import Path
import json,hashlib,shutil,re
r=Path.cwd();o=r/'.tmp/v061-release/phase3a';e=r/'docs/governance/releases/evidence/v061-release/phase3a';e.mkdir(parents=True,exist_ok=True);x=json.loads((o/'phase3a-result.json').read_text());assert x['status']=='PASS' and x['generationCalls']==x['publishCalls']==x['applyCalls']==0
old=json.loads((r/'docs/governance/releases/evidence/plotnovel-bulk-publish-2026-10-15/threshold-review/render-only-result.json').read_text());known={i['novelId'] for i in old['diagnostic']['results']};assert len(known)==12
for row in x['prerender']['results']:row['previouslyDiagnosed10_15Wave1']=row['novelId'] in known
assert sum(not row['previouslyDiagnosed10_15Wave1'] for row in x['prerender']['results'])==46
x['sourceItemIdsSha256']=hashlib.sha256((o/'source-item-ids.json').read_bytes()).hexdigest();x['groupingSha256']=hashlib.sha256(json.dumps([s['group'] for s in x['surveys']],sort_keys=True,separators=(',',':')).encode()).hexdigest();(o/'phase3a-result.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
for p in o.iterdir():
 if p.is_file() and p.suffix in ['.json','.log','.py','.ts']:shutil.copy2(p,e/p.name)
text='''# PlotNovel B-47 补发与34本试读定向重跑运维记录（2026-10-16）

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

脚本0644复制到web /tmp，SHA256 `'''+x['opsScriptSha256']+'''`，宿主/容器字节一致。同一actor `71f0e655-0640-4f07-bcbb-041f027fa7cb`、admin/super_admin/active；角色web_app、事务只读。候选ID集合与交接固定58本完全相等，wave1单chunk58。

| 准入统计 | 数量 |
| --- | ---: |
| Population | 3860 |
| Eligible | 58 |
| already_exists | 1977 |
| promo_link_missing | 1186 |
| promo_link_not_ready | 635 |
| duplicate_title_in_link_theater | 4 |

清单SHA256 `'''+x['opsPlan']['manifestSha256']+'''`。容器文件 `/tmp/plotnovel-b47-20261016-manifest.json`；宿主0600文件 `/opt/cps-novel/shared/operations/plotnovel-b47-republish-2026-10-16/manifest.json`；本地证据原字节一致。乙阶段使用同一清单、actor、脚本和wave1，不重建候选。生成requestId `plotnovel-b47-republish-2026-10-16-w1-c1`，发布requestId `plotnovel-b47-republish-publish-2026-10-16-w1-c1`。

## 甲3：34本只读调查与固定分组

固定34个source item，原生worker_app、READ ONLY，按当前channel_app读回；**全部仍在MoboReader一组**（不沿用“部分已改挂”的假设）。novel.status=published34，可读章节0的34本，在途试读0。原preview-backfill-recovery入口不带--apply，candidateCount=34、truncated=false、batches=[]，credential preflight usable；失败分类MoboReader Preview read failed=34。未重跑上游，所以13本/21本预期尚未经本次执行核实。

| 分组 | channel_app | 数量 | 固定requestId | candidateCount |
| --- | --- | ---: | --- | ---: |
'''
for s in x['surveys']:
 g=s['group'];text+='| '+g['appCode']+' | `'+g['channelAppId']+'` | '+str(len(g['sourceItemIds']))+' | `'+g['requestId']+'` | '+str(s['report']['candidateCount'])+' |\n'
text+='\nsource-item源文件SHA256 `'+x['sourceItemIdsSha256']+'`；分组JSON按sort_keys与紧凑separators编码的SHA256 `'+x['groupingSha256']+'`。原命令和全量sourceItemIds见[证据JSON](evidence/v061-release/phase3a/phase3a-result.json)。乙阶段先重新调查；数量或分组变化即停，沿用原requestId和sourceItemIds。\n\n| sourceItemId | novelId | novel.status | 可读章 | 在途试读 |\n| --- | --- | --- | ---: | ---: |\n'
for row in x['grouping']['rows']:text+='| `'+row['sourceItemId']+'` | `'+row['novelId']+'` | '+row['novelStatus']+' | '+str(row['readableChapters'])+' | '+str(row['inflightPreview'])+' |\n'
text+='''
## 乙阶段：未授权、未执行

等Owner“批准补发”后，58本wave1生成任何失败立即停；发布拒绝/冲突立即停且不重试。目标总2035、目标草稿0、IndexNow58/58accepted，逐本报告试读成功/跳过/失败。B-46必须核对preview_chapters_written刷新与来源试读任务关联成功，既有builder只读校验书页及有效章节覆盖；开关false或全部试读结束30分钟仍未覆盖，按原手册只手动刷新一次并明确报告B-46未生效与原因。随机3篇合计最多10次代理请求，不跟随上游跳转。

34本先重新调查，不变才按固定组/requestId apply；预期13本写入非空章节、21本chapterList null跳过、失败0，实际按上游分布报告。有章节写入同样核对sitemap。IndexNow熔断/429/死信/非accepted、permission denied、主worker积压持续增长、原635或1977摘要变化立即停止，不自行修复。回滚需Owner另批兼容标志，固定目标v0.6.0 Final493eb23b034b0410780228535b3e293e4ee91f9a，保留已发布58篇。

## 证据与治理

[甲阶段完整证据](evidence/v061-release/phase3a/phase3a-result.json)，包含58本逐条原失败字段/预渲染状态、plan、精确清单SHA、34本分组与原survey命令、保护摘要。原日志、退出码与脚本保留；Notion同步回读收据随后登记。发版级开发日志只保留v0.6.1唯一条目，运维不重复新增发版条目。
'''
p=r/'docs/governance/releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md';p.write_text(text)
p=r/'docs/governance/releases/v0.6.1-preproduction.md';s=p.read_text().replace('第二阶段已部署验收通过；第三阶段甲只读预演中','第二阶段与第三阶段甲已完成，停手等待批准补发');s+='''

## 第三阶段甲：只读预演 PASS，已停手

58/58内存预渲染成功；原12+另46本失败字段均复现为cover_url/absolute_url。ops plan population3860、eligible58，与固定58本ID集合完全相等；blocked already_exists1977、promo_link_missing1186、promo_link_not_ready635、duplicate_title_in_link_theater4。同一super_admin校验通过；manifest SHA256 `ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639`。

34本当前全部属于MoboReader/channel_app `85c2fb3e-28f8-476a-83f2-9647e2206192`，published34、可读章节0、在途试读0；worker_app原入口survey candidateCount34/truncated=false/credential usable，requestId `preview-b42-34-2026-10-16-moboreader`已固定。未带apply，原1977/635摘要保持，生成/发布/试读apply各0次。详细[运维记录](plotnovel-b47-republish-and-preview-34-2026-10-16.md)。**等待Owner“批准补发”，不再执行业务操作。**
''';p.write_text(s)
p=r/'docs/governance/version-registry.md';s=p.read_text().replace('第三阶段甲只读预演中（2026-10-16 23:09:04 JST）','第三阶段甲只读预演PASS，停手待批准补发（2026-10-16 JST）').replace('只读预演中，补发待批准','只读预演PASS，补发待批准');a=s.index('### v0.6.0');s=s[:a]+'''- 第三阶段甲PASS：58/58预渲染，候选58精确相等，manifest SHA256 `ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639`。34本当前MoboReader一组、published34/可读章0/在途0，survey candidate34，固定requestId preview-b42-34-2026-10-16-moboreader；原1977/635摘要保持，业务调用0。[运维记录](releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md)。

'''+s[a:];p.write_text(s)
p=r/'docs/governance/development-log.md';s=p.read_text().replace('第三阶段甲只读预演完成后回报并停下；58补发/34apply待Owner另批','第三阶段甲58/58预渲染与固定58候选PASS，34本当前MoboReader一组survey candidate34、可读章0/在途0，原1977/635摘要保持；已停手，58补发/34apply待Owner另批');p.write_text(s)
(e/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(e.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))
print({'phase3a':'PASS','evidenceFiles':len(list(e.iterdir())),'manifestSha256':x['opsPlan']['manifestSha256'],'groupingSha256':x['groupingSha256']})
