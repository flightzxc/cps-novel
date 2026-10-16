from pathlib import Path
import json,re,shutil,hashlib,datetime
r=Path.cwd();o=r/'.tmp/v061-release/phase2';e=r/'docs/governance/releases/evidence/v061-release/phase2';e.mkdir(parents=True,exist_ok=True)
for name in ['01-initial','02-upload','03-artifacts','04-backup','05-recheck','06-env','07-launch','08-pull-deploy','09-post-check','10-step0','11c-external','12-protect']:
 assert json.loads((o/(name+'.meta.json')).read_text())['exitCode']==0,name
pull=(o/'08-pull-deploy.log').read_text();timeline=json.loads(pull.split('BEGIN_FILE=.timeline.json\n')[1].split('END_FILE=.timeline.json')[0]);events={x['event']:x for x in timeline};on=events['MAINTENANCE=ON']['at'];off=events['MAINTENANCE=OFF']['at'];duration=(datetime.datetime.fromisoformat(off)-datetime.datetime.fromisoformat(on)).total_seconds()
post=(o/'09-post-check.log').read_text();services=[json.loads(l) for l in post.splitlines() if l.startswith('{"service"')];health=json.loads(next(l.split('=',1)[1] for l in post.splitlines() if l.startswith('HEALTH=')));indexnow=json.loads(next(l.split('=',1)[1] for l in post.splitlines() if l.startswith('INDEXNOW_STATUS=')))
backup=(o/'04-backup.log').read_text();env=json.loads(next(l for l in (o/'06-env.log').read_text().splitlines() if l.startswith('{')));protected=json.loads((o/'12-protect.log').read_text().splitlines()[0])
x={'status':'PASS','stage':2,'authorizedBy':'Owner 批准部署，执行第二阶段与第三阶段甲；甲回报后停止','final':'cb255e0f1c93041eda6aefeefbb541d7eddfc15f','tree':'34d2fcbc052762544cefec1f97466b2d1e786762','host':'haiyue-vps','releaseExit':0,'maintenance':{'on':on,'off':off,'seconds':duration},'timeline':timeline,'env':env,'backup':{'path':re.search(r'BACKUP_ARCHIVE=(.+)',backup)[1],'bytes':int(re.search(r'^size_bytes=(\d+)',backup,re.M)[1]),'sha256':re.search(r'^sha256=([0-9a-f]+)',backup,re.M)[1],'pgRestoreList':'PASS'},'health':health,'services':services,'postgresContainerUnchanged':True,'migrations':27,'businessTables':58,'migrationChecksumsMatch':True,'grantsReadback':'PASS','effectiveTagProjection':{'missing':0,'extra':0,'changed':0},'indexnow':indexnow,'sitemapAutoRefresh':True,'preflightWriteGatesUnchanged':True,'nginxHashesUnchanged':True,'runtimeImageDeps':'PASS four apps no vitest/tinypool Next 16.3.8','publicProbes':json.loads((o/'external-results.json').read_text()),'protectedAfter':protected,'protectedIdentical':True,'generationCalls':0,'publishCalls':0,'previewApplyCalls':0,'deviations':[{'scope':'own read-only external checker','cause':'PostgreSQL nested JSON spans multiple lines; line parser failed before any HTTP request','attempts':['11-external exit1','11b-external exit1 diagnostic','11c-external exit0 fixed JSONDecoder.raw_decode'],'productChanges':False,'externalRequestsBeforeFix':0}]}
(o/'phase2-result.json').write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
for p in o.iterdir():
 if p.is_file() and p.suffix in ['.json','.jsonl','.log','.py'] or p.is_file() and p.name=='SHA256SUMS':shutil.copy2(p,e/p.name)
# Fixed Final tag created only after live acceptance; generated changelog is staged separately.
p=r/'docs/governance/releases/v0.6.1-preproduction.md';s=p.read_text();a=s.index('## 当前状态：');b=s.index('\n| 身份 |',a)
s=s[:a]+'''## 当前状态：第二阶段已部署验收通过；第三阶段甲只读预演中（2026-10-16 JST）

Owner 已明确“批准部署”，授权第二阶段与第三阶段甲。仅 haiyue-vps 已部署固定 Final，原 `RELEASE=PASS` / `RELEASE_EXIT=0`，维护 OFF。58 本补发和 34 本试读 apply 均未执行；第三阶段甲回报后必须停下，等待“批准补发”。
'''+s[b:]
a=s.index('第一阶段版本台账、发布记录、证据及推送完成；');b=s.index('\n\n',a);s=s[:a]+'''第一阶段版本台账、发布记录、证据及推送完成；部署验收后已在 Final 打 annotated v0.6.1，并以指定 core.abbrev=7 运行原 CHANGELOG 生成器。PATCH 台账和唯一正式开发日志已更新；Notion 同步及回读在第三阶段甲记录完成后执行。'''+s[b:]
s=s.replace('### 当前状态：Owner 要求等回家后继续，已暂停','### 历史状态：Owner 要求等回家后继续，当时已暂停')
s+='''

## 第二阶段：已部署与独立验收

- Owner 本会话批准部署；唯一主机 haiyue-vps。三次公开连接采样 1/1/0，部署前再次采样通过；两次 READ ONLY 暂停门禁 PASS，生成/发布/试读在途均 0。27 条迁移名称、checksum 与本版及 v0.6.0 完全一致，零新增迁移、无回填。
- env 改前 SHA256 `f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369`；备份 `/opt/cps-novel/shared/env/preprod.env.bak-v061-20261016T140753Z`。仅 APP_VERSION=0.6.1、NEXT_PUBLIC_BUILD_VERSION=v0.6.1 两行变化，脱敏 diff / cmp PASS；改后 SHA256 `23425e8289854167d53d91f1f3673e383239458f0ae76fb4a5c695559e224509`。FEATURE_SITEMAP_AUTO_REFRESH=true，只读报告，未修改。
- 原消费端 SHA/OCI/Final/tree/--load 全 PASS，使用离线不可变归档，没有在生产构建或拉取应用镜像。在线逻辑备份 763,037,272 字节、SHA256 `1ce6fd86c0098bfdbdfe947110409df03d58accfad28a97af5784f0065e6e591`，pg_restore --list 与 sha256sum -c PASS；文件 `/var/lib/cps-novel/backups/logical/cps-novel-v061-20261016T140451Z.dump`。
- 原 release.sh 显式 APPROVED_GIT_COMMIT=Final、PREPROD_APPROVED_MIGRATION=YES；migration_owner 检查无待迁移，postgres 单事务重放 grants，原 DATABASE_MIGRATION / DATABASE_GRANTS 均 PASS。维护 '''+on+' 至 '+off+'，共 **'+str(duration)+''' 秒**；RELEASE=PASS / exit0。
- health 0.6.1 / Final、metadataConsistency passed；五应用 healthy，postgres CID `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e` 保持。27 finished / 0 rolled_back、58 表；步骤0授权 f/f/f/t/f/f/t/t、函数属主 migration_owner / secdef=t / search_path 固定、仅 web_app 可执行、无 PUBLIC EXECUTE、触发器 O、派生一致 0/0/0。
- effective-tag 投影 0/0/0；IndexNow breaker closed、无429等待/死信/积压，key verified。四应用 Next16.3.8，无 vitest/tinypool；六服务部署以来 error/permission denied 均0。写闸、白名单和 nginx 摘要不变，BACKUP_TIMER=RUNNING。
- 公网仅4次代理GET（预算6）：PlotNovel / MoboReader 书页200、sitemap200、PlotNovel /go302→同一站内/app。Read on PlotNovel App 与 Continue reading 正确；HTML/Location 2039个受保护口令码匹配行均0。不跟随上游跳转，不保存正文或口令码。
- 635人工复核摘要 `ac2b4b10e414ef8c7520d718c72439140b5a3c1f7a34a1d9bbca44b6640a386f`；原1977篇摘要 `42499c6f369bbf44008e62715da659b0f68248e1b8d80c3ecc29a108c95d3f6c`，部署前后完全一致。
- 自写公网只读检查器按行解析 PostgreSQL 多行JSON，首次失败；诊断后以 JSONDecoder.raw_decode 修复、重跑通过，修复前HTTP请求0次。原日志全部保留，未改变产品或原门禁。

完整原日志、退出码、运输/备份/脱敏env/迁移grants/运行态/公网计数与偏差见 [第二阶段证据](evidence/v061-release/phase2/phase2-result.json)。
''';p.write_text(s)
p=r/'docs/governance/version-registry.md';s=p.read_text();a=s.index('### v0.6.1');b=s.index('### v0.6.0',a);s=s[:a]+'''### v0.6.1 —— 已部署正式站，第三阶段甲只读预演中（2026-10-16 23:09:04 JST）

- **PATCH**，Final `cb255e0f1c93041eda6aefeefbb541d7eddfc15f` / tree `34d2fcbc052762544cefec1f97466b2d1e786762`。来源 `fix/v061-cover-preview-sitemap`，已合入 `integration/v0.6.1-2026-10-16@3704cc028692510acc60fbc27187817535f97b23`，发布 `release/v0.6.1-2026-10-16`。
- B-47正文封面非英文编码、B-42空正文跳过、B-46试读写入后刷新sitemap，均已部署。公开网址及数据库/sitemap/og/书页图片封面原值冻结。27迁移/58表，字典1349/active1279；grants/依赖/环境变量集合不变，无回填。
- 第一阶段37运行器、完整发布门禁和归档镜像E2E PASS；ops真实库29/29、skipped0，两组变异被抓到并还原。ops HEAD `c3578aa6f8c18bc0ee39bcd14da95703aaad3098` 独立留档，不合入集成线。
- Owner批准部署后仅haiyue-vps原RELEASE=PASS/exit0，维护48.926646秒。env仅版本两行、cmp PASS，在线备份763037272字节/restore-list PASS；health0.6.1/Final/metadataConsistency passed、五应用healthy、postgres CID不变。
- 27finished/0rolledback/checksum与授权读回PASS、投影0/0/0、IndexNow无熔断/429/死信/积压；四应用Next16.3.8/无vitest和tinypool；六服务error/permission denied0，写闸、白名单、nginx摘要不变、备份定时器运行。4/6代理公网抽查全PASS、口令码匹配0；原1977发布和635复核摘要保持。
- annotated v0.6.1固定Final；CHANGELOG已用原生成器core.abbrev=7生成；PATCH台账、唯一正式日志、发布证据已完成，Notion待本轮只读预演后同步回读。**58本补发、34本试读apply未执行，须预演回报后Owner另说“批准补发”。** B-46实际触发与覆盖验收在乙阶段有章节写入后核实。
- Owner10-16四决定：只编码正文、批准定向34本重跑（执行待乙阶段）、null按空正文、旧章保留导致总试读超过3章的限制以后遇到再处理（preservedCount>0 && materializedCount+preservedCount>3）。[发布记录](releases/v0.6.1-preproduction.md)。回滚v0.6.0 Final493eb23b…，兼容标志须Owner另批。

'''+s[b:];s=s.replace('| 第一阶段完成，待Owner授权部署 |','| 已部署验收PASS；只读预演中，补发待批准 |');p.write_text(s)
entry='''### 2026-10-16 22:09 - codex（GPT-6，正式发版执行；时间 +0800 / JST 23:09）

**变更类型**：海阅 v0.6.1 PATCH 正式站部署，仅 haiyue-vps。Owner 明确批准第二阶段和第三阶段甲；14:09:04Z 原 RELEASE=PASS / exit0，维护OFF。补发与定向试读 apply 仍须 Owner 看过只读预演后说“批准补发”。
**背景**：10-15 PlotNovel放量因封面非英文地址留下58本生成失败；B-42空正文导致整本试读失败；B-46试读写入后sitemap收录延迟。来源 fix/v061-cover-preview-sitemap，经 integration/v0.6.1-2026-10-16@3704cc0 合入，本轮只发已集成修复及运维工具，固定Final cb255e0f1c93041eda6aefeefbb541d7eddfc15f。
**变更内容与Owner四决定**：B-47仅文章正文渲染时编码；数据库封面原值、sitemap、og和书页图片保持原值（公开网址继续冻结）。B-42空串/空白/null正文跳过、保留已有章节；Owner批准定向34本重跑，但执行等待第三阶段乙。null按空正文处理；旧章保留引致总试读超过3章问题以后遇到再处理，触发判据 preservedCount>0 && materializedCount+preservedCount>3。B-46写入/恢复/置stale后按来源试读任务入队刷新，沿用开关true，实际业务触发验收待乙阶段。
**影响范围**：三项修复已部署；27迁移/58表，字典1349/active1279、grants和依赖不变、无新环境变量/回填。env仅两个版本字段、其余cmp一致，Turnstile、写闸和白名单不变；未改nginx/证书/DNS、claimPromo能力或635人工复核。未生成、发布、重跑试读。
**验证方式**：第一阶段全门禁及37运行器PASS、全量0failed/无Unhandled、proxy1742、ops19单测+10真实库/skip0，非英文封面plan→generate→publish正文编码/DB原值保持。主控六组独立变异中两组首轮存活，补承重用例后全部被捕获；本轮ops旧版本身份与失败策略两组变异亦捕获、还原干净。服务器原SHA/OCI/Final/tree/--load PASS，在线逻辑备份763037272字节/SHA1ce6fd86…e6e591/pg_restore清单通过。维护14:08:13.209745Z–14:09:02.136391Z共48.926646秒；原migration_owner检查无待迁移、postgres单事务grants重放通过。health/五应用健康、postgres CID保持、27迁移checksum/授权函数触发器读回PASS、投影0/0/0；IndexNow闭闸无熔断429死信积压，Next16.3.8/四应用无vitest和tinypool、六服务error/permissiondenied0、备份定时器运行。4/6公网代理GET通过，HTML和Location口令码匹配0，原1977篇/635人工复核摘要一致。自写公网检查器多行JSON解析问题已修正，修正前HTTP0次，原产品门禁不变。
**后续待办与治理**：第三阶段甲只读预演完成后回报并停下；58补发/34apply待Owner另批，B-46覆盖在有章节写入后验收。annotated v0.6.1固定Final、原生成器core.abbrev=7 CHANGELOG、PATCH台账、唯一发版日志和第二阶段证据完成；Notion本轮同步回读随后留收据。回滚仅v0.6.0 Final493eb23b034b0410780228535b3e293e4ee91f9a，SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES须Owner回滚时明确批准。完整[发布记录](releases/v0.6.1-preproduction.md)。

'''
p=r/'docs/governance/development-log.md';s=p.read_text();assert '### 2026-10-16 22:09 - codex' not in s;a=s.index('\n### ')+1;s=s[:a]+entry+s[a:];p.write_text(s)
# Evidence hash list over non-secret saved files.
(e/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(e.iterdir()) if p.is_file() and p.name!='SHA256SUMS'))
print(json.dumps({'stage2':'PASS','maintenanceSeconds':duration,'evidenceFiles':len(list(e.iterdir()))}))
