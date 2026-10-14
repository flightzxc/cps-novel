### 2026-10-14 16:51 - codex（GPT-6，正式发版执行；JST）

**变更类型**：海阅v0.6.0 MINOR正式站部署，仅haiyue-vps。Owner明确授权Final `493eb23b034b0410780228535b3e293e4ee91f9a`；原RELEASE=PASS/EXIT=0，A～F PASS。代码已部署，PlotNovel尚未开通，前台行为不变。
**背景**：来源 `feat/plotnovel-code-theater-v060` 22提交，由 `integration/v0.6.0-2026-10-14@ca6dbcc9` 回收三个no-ff合并及 `7b998d1e` Turnstile记录/证据打码修复；主控逐项（含独立变异）、Fable两轮复核后发版。Owner10-14/15决定：PlotNovel中间页、按剧场配置商店链接、跳过20本同名书、首页轮播不放、存量改挂、不做点击记录；不保留免责小字；数据库层收紧；两步走先发代码、开通另行执行；未来新功能另开会话开发、主控只回收合并。
**变更内容**：口令码模式代码、派生布尔列/触发器/SECURITY DEFINER取码函数、web_app禁读上游口令码；27迁移/58业务表/字典1349-active1279。migration_owner执行迁移，grants由原脚本postgres单事务重放，函数属主migration_owner。10-14上游试读探测5本PlotNovel书全部成功、各3章，是探测结论，不代表剧场已开通。
**影响范围**：公开网址冻结；本轮未登记、改挂、激活剧场或改能力/领取批次/试读白名单，未改业务开关、搜索、nginx、证书、DNS或做IndexNow回填。生产env只改两个版本字段，cmp PASS；在线逻辑备份及restore-list PASS。
**验证方式**：既有第一阶段11397测试/37运行器/镜像E2E等成功证据按Owner批准有效；部署后health0.6.0/Final、五应用healthy、postgres CID不变。维护49.954127秒，新迁移2613.864ms；步骤0授权f/f/f/t/f/f/t/t、属主/secdef/search_path/EXECUTE/触发器及回填0/0/0通过；web_app预期拒绝、SAVEPOINT恢复后虚构码NULL；四应用Next16.3.8无开发依赖、投影0/0/0、IndexNow无熔断/429/积压、写闸/备份定时器PASS。五应用error/permissiondenied0，postgres仅预期主动探针1条，非预期0。外部5次全代理，同一/go前后302且Location SHA256均 `cd3e05e05efaaf1b87106c931bc37d8852f5881773ac88cad333b7723acbb2e5`；书页/分类/sitemap200、Continue reading、无PlotNovel。
**后续待办**：PlotNovel开通另行取得Owner授权并执行专门手册；回滚仅v0.5.15，兼容标志须Owner回滚时明确批准。Git annotated tag固定Final、生成CHANGELOG/台账/本条日志已写；Notion四处同步回读PASS（2026-10-14T08:02:20.999Z）。证据与详情见 [v0.6.0发布记录](releases/v0.6.0-preproduction.md)。

