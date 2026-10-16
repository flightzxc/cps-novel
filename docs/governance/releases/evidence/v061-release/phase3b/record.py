from pathlib import Path
import json,collections,hashlib,shutil,re
r=Path.cwd();o=r/'.tmp/v061-release/phase3b';e=r/'docs/governance/releases/evidence/v061-release/phase3b';e.mkdir(parents=True,exist_ok=True)
remote=json.loads((o/'15-pull-evidence.log').read_text());d=e/'remote';d.mkdir(exist_ok=True)
for n,x in remote['files'].items():(d/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
(d/'execution-journal.json').write_text(json.dumps(remote['journal'],indent=2)+'\n');assert len(remote['journal'])==2 and [v['event'] for v in remote['journal']]==['generate','publish']
account=json.loads((o/'13-final-account.log').read_text());stop=json.loads((o/'14-stop-snapshot.log').read_text());cover=json.loads((o/'10c-coverage.log').read_text());public=json.loads((o/'public-result.json').read_text());diag=[json.loads((o/n).read_text()) for n in ['public-diagnostic.json','public-diagnostic-exact-normalization.json']]
assert len(account['previews'])==58 and all(i['status']=='success' for i in account['previews']) and sum(i['contentWrites'] for i in account['previews'])==173
assert public['status']=='STOP' and stop['status']=='STOP' and all(x['matchedCodes']==0 for x in diag)
assert account['refreshes'][0]['status']=='completed' and account['refreshes'][0]['params']['reason']=='preview_chapters_written'
assert not any(p.name.startswith('preview-apply-') for p in d.iterdir())
x={'status':'STOP','approval':'Owner明确批准第三阶段乙，固定58补发与甲阶段固定分组/requestId重跑34；保留全部停手条件','final':'cb255e0f1c93041eda6aefeefbb541d7eddfc15f','opsHead':'c3578aa6f8c18bc0ee39bcd14da95703aaad3098','manifestSha256':'ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639','publishedNew':58,'publishedTotal':2035,'targetDrafts':0,'generation':stop['waveStatus']['generation'],'indexnow':stop['waveStatus']['indexnow'],'preview58':{'success':58,'skipped':0,'failed':0,'contentWrites':173,'items':account['previews']},'b46':{'effective':True,'previewTask':account['tasks'][0],'refresh':account['refreshes'][0],'manualRefreshCalls':0,'secondsAfterPreviewTerminal':21.883},'coverage':cover,'publicAcceptance':public,'publicDiagnostics':diag,'externalHttpTotal':3,'preview34':{'applyCalls':0,'candidateCount':34,'grouping':stop['preview34Grouping'],'surveys':stop['preview34FinalSurvey'],'reasonNotApplied':'public_acceptance_gate_failed_before_apply'},'protection':stop['protection'],'logs':stop['logs'],'stop':stop['stop'],'deviations':[{'kind':'own readonly SQL transport fixture','error':'Argument list too long from 1977-ID filter passed as docker argument','fix':'psql input via stdin, no SQL or gate semantics changed'},{'kind':'own readonly coverage fixture','error':'docker cp preserved host uid1000 on mode0600 temporary input and manifest; app uid1001 could not read','fix':'manifest owner restored1001:1001/mode0600 with SHA unchanged; independent fixture input0644; use known novelIds instead of joining source-item table unavailable to web_app','servicePermissionDenied':0},{'kind':'public acceptance STOP','error':'first book_upstream_code_leak check failed; first matched count/context not preserved by original checker','readonlyRecheckMatchedCodes':[0,0],'conclusion':'unresolved; gate not waived; no further business commands'}]}
(o/'phase3b-result.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
exclude={'preview-apply-remote.py','coverage-v3-remote.py','coverage-v3.ts'}
for p in o.iterdir():
 if p.is_file() and p.name not in exclude and p.suffix in ['.py','.ts','.json','.jsonl','.log']:shutil.copy2(p,e/p.name)
paragraph='''## 第三阶段乙：58本补发完成，公网检查未通过后停手（JST 2026-10-17）

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
'''
for i in account['previews']:paragraph+='| `'+i['novelId']+'` | `'+i['sourceItemId']+'` | '+str(i['contentWrites'])+' | '+i['status']+' | — | — |\n'
paragraph+='''
### 执行偏差与证据

只读监督器的1977-ID保护过滤最初超出单命令参数长度，改用stdin传psql，原查询口径不变。覆盖辅助程序复制临时文件时保留host uid1000，导致应用uid1001读不到；恢复manifest属主1001:1001、模式0600并复核原SHA不变，检查夹具另用0644输入和甲阶段已知novelIds过滤；没有执行不可授权的source-item查询。全过程服务permission denied0；原ops脚本、编排和门禁未改。原失败日志保留。公网检查异常独立保留为STOP，不作为已修复夹具问题处理。

[乙阶段完整结果与逐条证据](evidence/v061-release/phase3b/phase3b-result.json)，[远端停手快照](evidence/v061-release/phase3b/remote/STOP.json)。技术状态为“58本完成，公网验收未通过，34本待处理”，不登记为乙阶段全完成。Notion同步及回读收据在治理收尾补齐；发版日志仍只有原v0.6.1唯一条目。
'''
p=r/'docs/governance/releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md';s=p.read_text();a=s.index('## 当前状态：');b=s.index('## 固定身份与保护',a);s=s[:a]+'''## 当前状态：58本补发已完成；公网验收未通过，34本apply未执行

Owner已批准第三阶段乙。58本生成/发布/试读、IndexNow与B-46覆盖验收完成；随机公网检查在第一篇book_upstream_code_leak断言停下，随后两次只读复核未复现，尚不能裁定首轮原因。按停手条件保留全部已发布内容，34本固定分组和requestId保留、apply0次，等待Owner裁定。

甲阶段历史预演结果保留如下，乙阶段执行、停点与逐本结果见文末。

'''+s[b:];s=s.replace('## 乙阶段：未授权、未执行','## 乙阶段既定执行规则（方案历史，实际结果见下方）').replace('等Owner“批准补发”后，58本wave1生成任何失败立即停','既定规则：58本wave1生成任何失败立即停');s+='\n\n'+paragraph;p.write_text(s)
p=r/'docs/governance/releases/v0.6.1-preproduction.md';s=p.read_text();s=s.replace('第二阶段与第三阶段甲已完成，停手等待批准补发','58本补发完成；公网检查未通过停手，34本apply未执行');a=s.index('Owner 已明确“批准部署”');b=s.index('\n| 身份 |',a);s=s[:a]+'''Owner已明确批准部署及第三阶段乙补发。固定Final已部署验收通过，58本已完成生成/发布/试读、IndexNow58accepted及B-46自动刷新覆盖；公网首篇书页口令码检查未通过，按停手条件停止后续业务操作。两次只读复核未复现但首轮原因未裁定；34本apply未执行。[乙阶段完整运维记录](plotnovel-b47-republish-and-preview-34-2026-10-16.md)。

'''+s[b:];s+='''

## 第三阶段乙：部分完成并按公网门禁停手

Owner已批准。58生成/发布全部成功，发布拒绝冲突0、总2035/草稿0/IndexNow58accepted；试读58成功/0跳过/0失败，非空写入173章。B-46自动任务92554c1b-f02f-4ae1-aa3f-43f5f15677db完成，与来源试读29c70278-aa65-4787-9c46-8a3400c3fe6c关联、reason=preview_chapters_written，终态后21.883秒完成；58新书页+173有效章节及旧1977篇对应页面全覆盖，无手刷。

公网随机第一篇book_upstream_code_leak检查未通过，即停；两次脱敏只读复核均0命中，首轮计数/上下文未保留，原因未裁定，不能登记公网通过。总代理GET3/10、不跟随上游、不输出口令码或正文。34本原组/requestId只读重查candidate34、可读章0/在途0，apply0。原1977/635摘要、env和容器保持，六服务error/permission denied0。远端STOP文件及[完整乙证据](evidence/v061-release/phase3b/phase3b-result.json)保留，待Owner裁定后续，不自行越过门禁或重发58篇。
''';p.write_text(s)
p=r/'docs/governance/version-registry.md';s=p.read_text();a=s.index('### v0.6.1');b=s.index('### v0.6.0',a);section=s[a:b];section=section.replace('第三阶段甲只读预演PASS，停手待批准补发（2026-10-16 JST）','58本补发完成；公网验收异常停手，34本apply未执行（JST 2026-10-17）');section+='''- 第三阶段乙Owner已批准；58生成/发布/试读成功，失败0、总2035/草稿0/IndexNow58accepted；B-46自动关联刷新终态后21.883秒完成，58书页+173有效章全覆盖，无手刷。公网首篇口令码检查未通过，两次只读复核未复现但原因未裁定；GET3/10，34本候选仍34、apply0，当前STOP。原1977/635摘要不变、六服务error/permission denied0。[乙阶段运维记录](releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md)。

''';s=s[:a]+section+s[b:];s=s.replace('| 已部署验收PASS；只读预演PASS，补发待批准 |','| 已部署；58补发完成，公网检查STOP，34apply未执行 |');p.write_text(s)
p=r/'docs/governance/development-log.md';s=p.read_text();a=s.index('### 2026-10-16 22:09 - codex');b=s.index('\n### ',a+1);section=s[a:b];section+='''
**乙阶段运维补记（JST 2026-10-17）**：Owner已批准补发。58本生成/发布/试读全成功（失败0、跳过0）、总2035/目标草稿0/IndexNow58accepted；173非空章节，B-46自动刷新与来源任务关联并在终态后21.883秒完成，58书页+173有效章及原1977篇对应页面覆盖全PASS，无手刷。随机公网首篇book_upstream_code_leak检查未通过后停手，两次只读复核0命中、首轮原因未裁定；累计GET3/10，原1977/635摘要、env/容器保持、六服务error/permission denied0。34本原组/requestId候选仍34、apply0，不能登记乙阶段全完成。自写只读SQL传输参数长度与临时文件属主问题均修正，原ops和门禁不变；公网检查STOP独立留证，待Owner裁定后续。[乙阶段记录](releases/plotnovel-b47-republish-and-preview-34-2026-10-16.md)。

''';s=s[:a]+section+s[b:];p.write_text(s)
# Evidence scanner rejects secrets, raw database credentials and Turnstile literals.
for p in e.rglob('*'):
 if p.is_file():assert not re.search(r'0x4[A-Za-z0-9_-]{12,}|postgres(?:ql)?://[^\s\"\']+:[^\s\"\']+@',p.read_text(errors='replace')),p
(e/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p.relative_to(e))+'\n' for p in sorted(e.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'))
print(json.dumps({'recorded':'STOP','publishedNew':58,'preview34ApplyCalls':0,'externalHttp':3,'evidenceFiles':sum(p.is_file() for p in e.rglob('*'))}))
