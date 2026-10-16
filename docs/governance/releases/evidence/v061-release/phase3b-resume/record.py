from pathlib import Path
import json,hashlib,shutil,re
r=Path.cwd();o=r/'.tmp/v061-release/phase3b-resume';e=r/'docs/governance/releases/evidence/v061-release/phase3b-resume';e.mkdir(parents=True,exist_ok=True);d=e/'remote';d.mkdir(exist_ok=True)
pull=json.loads((o/'11-finalize.log').read_text());assert pull['status']=='PASS' and pull['sanitizedSnapshotFiles']==0
for n,x in pull['files'].items():(d/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
x=json.loads((o/'complete-result.json').read_text());x['ownerResolution']=pull['files']['owner-resolution.json'];x['checkerTests']={'passed':7,'failed':0};x['checkerSha256']=hashlib.sha256((o/'boundary_checker.py').read_bytes()).hexdigest();x['sanitizedProductionSnapshots']=0;(o/'complete-result.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
for p in o.iterdir():
 if p.is_file() and p.suffix in ['.py','.json','.jsonl','.log']:shutil.copy2(p,e/p.name)
text='''## Owner裁定与续跑收官（JST 2026-10-17）

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
'''
for i in x['preview34']['items']:text+='| `'+i['sourceItemId']+'` | `'+i['novelId']+'` | '+str(i['contentWrites'])+' | '+i['status']+' | '+(i['reason'] or '—')+' | '+(i['failureKind'] or i['failureCode'] or '—')+' |\n'
text+='''
### B-46与最终保护验收

34本来源试读任务17:00:37.363Z终态，自动sitemap任务 `c636f195-508d-4444-ba8b-2b061cb350bf` 于17:01:04.584Z完成，间隔 **27.221秒**；reason=preview_chapters_written、triggeredBy关联该来源任务，coveredItemCount13、triggerCount1。静态release ID与该自动任务相同。既有builder在web_app/RepeatableRead/READ ONLY下核对en31、de1、fr1、pt-BR1：34书页和21有效章节全部覆盖、缺失0。58本及原1977篇的2035书页/6044有效章节仍全覆盖，新58对应173章、旧1977对应5871章，意外PlotNovel章节和/go sitemap URLs均0。**两组均自动完成，无手动刷新，B-46已生效。**

最终IndexNow58/58 accepted、无熔断/429等待/死信/积压；目标草稿0、PlotNovel发布总2035，试读主worker积压0。原1977发布和635人工复核摘要、env SHA与六容器ID不变，六服务error/permission denied0。两个CPS参考仓HEAD及status与原快照逐字一致。未更改公开网址、封面原值、grants、迁移、依赖、环境变量、能力或白名单，未回填。

### 最终结论与治理

第三阶段乙 **PASS，全部完成**：58补发、34定向试读、公网原3样本和两组B-46自动覆盖均验收通过。历史公网误报STOP已由Owner明确裁定关闭，原始证据保留；新边界检查如出现禁止的独立码，仍按原停手口径停止。

[最终机器结果与Owner裁定](evidence/v061-release/phase3b-resume/complete-result.json)，[9项公网合并验收](evidence/v061-release/phase3b-resume/public-accepted.json)，完整原始日志/退出码/逐条计数/34书结果见新证据目录。PATCH台账、发布记录和原唯一发版日志补记同步更新；不新增第二条发版日志。CHANGELOG用原生成器core.abbrev=7更新，annotated v0.6.1仍指向原Final，ops独立分支不合入。Notion本轮最终同步及回读收据随后登记。
'''
p=r/'docs/governance/releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md';s=p.read_text();a=s.index('## 当前状态：');b=s.index('## 固定身份与保护',a);s=s[:a]+'''## 当前状态：第三阶段乙全部完成，最终验收PASS（JST 2026-10-17）

Owner已将首次book_upstream_code_leak裁定为检查器误报并授权续跑。仅修正辅助检查器后，原3样本9项公网检查全PASS；禁止独立码命中0、偶然重合18次，新增HTTP9/累计12。58本补发已完成；34本按甲阶段固定组/requestId执行，13成功写21章、21本chapterList null跳过、失败0。两组B-46自动覆盖均通过，无手动刷新；保护摘要、env及容器保持，服务error/permission denied0。

甲阶段与首次停手历史证据保留，Owner裁定三项依据、最终34本逐项结果和收官见文末。

'''+s[b:];s=s.replace('## 第三阶段乙：58本补发完成，公网检查未通过后停手（JST 2026-10-17）','## 第三阶段乙首次停手历史（Owner后续已裁定检查器误报）');s+='\n\n'+text;p.write_text(s)
p=r/'docs/governance/releases/v0.6.1-preproduction.md';s=p.read_text();a=s.index('## 当前状态：');b=s.index('\n| 身份 |',a);s=s[:a]+'''## 当前状态：发版及第三阶段乙全部完成，最终验收PASS（JST 2026-10-17）

固定Final已部署；58本补发完成（总2035、草稿0、IndexNow58accepted、试读58成功/0跳过/0失败）。Owner已裁定首次公网口令码检查为误报，修正辅助检查器后原3样本完整矩阵PASS（新增HTTP9/累计12、独立码暴露0、偶然重合18）；随后按甲阶段原分组/requestId完成34本，13成功写21章、21null跳过、失败0。两组B-46均自动覆盖，无手刷。历史STOP与裁定证据保留。[完整运维收官记录](plotnovel-b47-republish-and-preview-34-2026-10-16.md)。
'''+s[b:];s+='''

## Owner裁定后乙阶段收官

首次book_upstream_code_leak为纯子串匹配6位数字与封面13位时间戳的偶然重合，Owner三项裁定证据已完整写运维记录。只修辅助检查器，数字边界匹配、偶然重合计数、独立命中位置分类/数字打码/HTML全码替换，7测试PASS。原3样本9项全PASS，新增HTTP9/累计12、禁止独立码0、偶然重合18，另1次未发出HTTP的TLS握手失败保留，未跟随上游。

34本重查candidate34后沿用原sourceItemIds/分组/requestId，一次apply：13成功写21章、21个upstream_preview_chapter_list_null跳过、0失败。B-46刷新c636f195-508d-4444-ba8b-2b061cb350bf与来源ba768571-d0da-4d92-bf79-3f4bd34e3a68关联，终态后27.221秒完成；en/de/fr/pt-BR共34书页及21有效章节覆盖0缺失。两组无手刷，58对应173章仍覆盖，原1977/635摘要、env和容器保持、六服务error/permission denied0、IndexNow/试读积压0。[最终乙结果](evidence/v061-release/phase3b-resume/complete-result.json)。乙阶段业务现已全完成，历史误报STOP不删除，由Owner裁定记录明确关闭。
''';p.write_text(s)
p=r/'docs/governance/version-registry.md';s=p.read_text();a=s.index('### v0.6.1');b=s.index('### v0.6.0',a);s=s[:a]+'''### v0.6.1 —— 已部署，58本补发及34本定向试读全部验收PASS（JST 2026-10-17）

- **PATCH**，Final `cb255e0f1c93041eda6aefeefbb541d7eddfc15f` / tree `34d2fcbc052762544cefec1f97466b2d1e786762`，来源fix/v061-cover-preview-sitemap、integration/v0.6.1-2026-10-16@3704cc0，发布分支release/v0.6.1-2026-10-16。B-47正文封面编码/B-42空正文跳过/B-46试读后sitemap均已生效；公开网址、数据库/sitemap/og/书页封面原值冻结。
- 27迁移/58表、字典1349/active1279，grants/依赖/环境变量集合不变，无回填。第一阶段37运行器与镜像归档全门禁PASS；第二阶段原RELEASE=PASS、维护48.926646秒、备份及授权/投影/运行态PASS。
- 固定58生成/发布/试读全成功，失败0、跳过0；总2035/目标草稿0/IndexNow58accepted。新58书页+173有效章及原1977篇/5871有效章全部覆盖，B-46来源关联自动刷新21.883秒完成。
- Owner裁定首次公网检查为6位数字纯子串匹配误报，三项依据完整留档。仅修检查器，数字边界匹配、偶然重合计数、独立命中位置分类与脱敏HTML取证，7测试PASS。原3样本9项全PASS，新增HTTP9/累计12、禁止独立码0、偶然重合18；另1次未发出HTTP的TLS握手失败保留。原STOP不删除，由Owner裁定明确关闭。
- 34本按甲阶段原MoboReader组/sourceItemIds/requestId preview-b42-34-2026-10-16-moboreader，一次apply：13成功写21章、21个upstream_preview_chapter_list_null跳过、失败0。B-46自动来源关联刷新27.221秒完成，en/de/fr/pt-BR共34书页+21有效章节0缺失，无手刷。主worker/IndexNow积压0，原1977/635摘要、env/容器保持、六服务error/permission denied0。
- annotated v0.6.1仍固定Final；CHANGELOG原生成器core.abbrev=7、PATCH台账、唯一日志补记、完整发布与运维证据已更新，Notion本轮最终同步回读随后留收据。ops HEAD c3578aa6f8c18bc0ee39bcd14da95703aaad3098独立留档不合入。回滚仅v0.6.0 Final493eb23b034b0410780228535b3e293e4ee91f9a，兼容标志须Owner另批。**全部业务验收已完成。** [发布记录](releases/v0.6.1-preproduction.md) · [运维收官](releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md)。

'''+s[b:];s=s.replace('| 已部署；58补发完成，公网检查STOP，34apply未执行 |','| 已部署；58补发/34试读/公网/B-46全PASS，Owner关闭误报停点 |');p.write_text(s)
p=r/'docs/governance/development-log.md';s=p.read_text();a=s.index('### 2026-10-16 22:09 - codex');b=s.index('\n### ',a+1);s=s[:b]+'''\n**Owner裁定后乙阶段收官（JST 2026-10-17）**：Owner明确首次book_upstream_code_leak为6位数字纯子串匹配误报，依据2035码均6位数字、96窗口约17.8%偶合/32动态推荐窗口变化及书页无取码路径，完整写运维记录。仅修辅助检查器，数字边界/长数字串偶合计数/位置脱敏与HTML全码替换，7测试通过；原3样本9项全PASS，新增HTTP9/累计12、禁止独立码0、偶然重合18，另1次TLS握手失败无HTTP。沿用甲阶段原组/sourceItemIds/requestId一次apply34本，13成功写21章、21个upstream_preview_chapter_list_null跳过、失败0；B-46自动关联刷新27.221秒完成，四语种34书页+21有效章0缺失，无手刷。58补发及173章覆盖保持，原1977/635摘要、env/容器不变、六服务error/permission denied0、IndexNow和试读积压0。业务全部验收PASS，旧STOP与原始证据保留，以Owner裁定关闭，不重发58篇。唯一发版日志仍为本条，治理最终同步回读随收官留证。\n\n'''+s[b:];p.write_text(s)
for p in e.rglob('*'):
 if p.is_file():assert not re.search(r'0x4[A-Za-z0-9_-]{12,}|postgres(?:ql)?://[^\s\"\']+:[^\s\"\']+@',p.read_text(errors='replace')),p
(e/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p.relative_to(e))+'\n' for p in sorted(e.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'))
print({'stage3b':'PASS','preview34':{'success':13,'skipped':21,'failed':0,'contentWrites':21},'publicHttpNew':9,'publicHttpCumulative':12,'evidenceFiles':sum(p.is_file() for p in e.rglob('*'))})
