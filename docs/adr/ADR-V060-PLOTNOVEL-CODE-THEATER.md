# ADR：v0.6.0 接入畅读 PlotNovel 剧场（口令码模式）

- 状态：Owner 已拍板（2026-10-14），本分支已实现，待主控复核与发布。
- 来源：`开发单_v0.6.0_PlotNovel口令码剧场_2026-10-14.md`；业务方案 `方案_PlotNovel口令码剧场接入_调研_2026-10-14.md`；设计稿 `design-plotnovel/{Main,BookPage,Desktop}.dc.html`。
- 范围：登记第二个畅读剧场（PlotNovel）、目录扫描按机构分流、存量书目改挂、"推广已就绪"规则按剧场模式二选一、同名去重、首页轮播排除、前台口令码中间页与入口按钮。**不新增环境变量**；有 **1 个迁移**（`20261014120000_code_mode_upstream_code_guard`，26 → 27，见 D8：数据库层收紧 `upstream_code` 的读取）；改了 `infra/postgres/grants.sql`（见"授权边界"）。剧场模式配置本身（D1）仍不需要迁移。
- 分支 / 工作树：`feat/plotnovel-code-theater-v060` / `cps海阅/plotnovel-v060`，基线 `3ee7a9ff`（release/v0.5.15 收官）。
- 配套：运维手册 `docs/operations/PLOTNOVEL_THEATER_OPENING_2026-10-14.md`（发版后的 8 个有序步骤）；数据字典 `docs/governance/database-governance.md` §12 本版条目与 `database-schema-dictionary.jsonl` 的 `channel_app.config` 键契约。

## 背景

畅读（上游）有多个机构，同一个目录接口 `getlistpc` 把所有机构的书混在一起返回：MoboReader 是机构 3366，PlotNovel 是机构 1351。过去目录扫描不分剧场，**整页都记在"本次扫描任务所属的剧场"名下**，于是 PlotNovel 的 3,830 本英语书（生产 10-14 只读）早就被拉进库里，全部挂在 MoboReader 剧场下，其中 2,009 本领到了推广码、590 本在排队。

麻烦在于 PlotNovel 的书上游**只给口令码、不给网址**：读者要下载 PlotNovel App，在 App 里搜这个口令才能打开书。而我们的"推广已就绪"规则（`isPromoReady`）要求推广链接至少有一个网址（`web_url` / `app_url`），于是这批书一篇都发不出去。

本版做三件事：把这批书归到新的 PlotNovel 剧场；让"口令码模式"的剧场"有口令码就算就绪"；前台给读者一个中间页，展示口令码和下载按钮。

## 六项拍板（Owner 2026-10-14）

1. **中间页方案**：`/go/<站内码>` 之下的独立页面，内容照设计稿（书名、封面、大号口令码、复制按钮、三步说明、商店按钮，手机 / 电脑两种布局，默认"三步版"）。设计稿底部原有一行免责小字，运营 10-14 决定去掉（见 D7），页面上不再渲染。
2. **App 下载链接按剧场配置**，所有书共用（`channel_app.config.appStoreUrl` / `googlePlayUrl`）。
3. **与 MoboReader 同语种同名的书（约 20 本）只保留 MoboReader**，PlotNovel 那本不生成。
4. **口令码模式的书照常进站点地图、IndexNow、列表、分类、搜索；首页轮播不进。**
5. **新登记 PlotNovel 剧场**，存量改挂过去，目录扫描按机构分流。
6. **点击记录不做**（`/go` 的埋点逻辑不动，中间页不埋点，复制按钮也不埋点）。

## 设计决定

### D1 剧场模式存放在 `channel_app.config`，不迁移、不加环境变量

| 键 | 含义 | 缺省 |
| --- | --- | --- |
| `promoMode` | `"link"` 或 `"code"` | 缺省 / 拼错 / 非字符串一律 `link`（fail-closed） |
| `agencyIds` | 上游机构编号（字符串数组），目录分流用 | 空 |
| `codeModeLocales` | 口令码模式下哪些语种的书算就绪 | 空（等于没有书就绪） |
| `appDisplayName` | 按钮 / 中间页上的 App 名 | `PlotNovel` |
| `appStoreUrl` / `googlePlayUrl` | 中间页下载按钮 | 空（该按钮不渲染） |

真源是 `src/server/publication/theater-promo-mode.ts`（解析 + 剧场模式判定；商店链接只认 `https:` 绝对地址、不带账号口令，写坏了就当没配，`<a href>` 永远不会变成可执行脚本）。"代码模式开关"就是库里是否存在一个 `promoMode=code` 的剧场，所以不需要环境变量。MoboReader 登记时 `config = {}`，不存在 `promoMode` 的旧记录一律按 link 处理，零改动继续工作。

### D2 就绪规则：按剧场模式二选一，互不相交

| 模式 | 规则 |
| --- | --- |
| link（MoboReader） | `status = fetched` 且 `web_url` / `app_url` 去空白后至少一个非空——**逐字不变** |
| code（PlotNovel） | `status = fetched` 且 `upstream_code` 去空白后非空 且 `novel.locale` ∈ `config.codeModeLocales`（元素按原样比较，不裁剪、不改大小写） |

- 唯一权威是 `src/server/publication/visibility.ts` 的 `isPromoReady`；SQL 对应物 `promoReadySql` 与它**逐字符等价**（JS `trim` 的 25 个空白字符经 `btrim` 绑定参数传入给 link 规则的网址判断；口令码"是否非空"因 `web_app` 读不到 `upstream_code`，改读触发器维护的布尔列 `upstream_code_present`，触发器用同一套 25 个字符，见 D8；配置缺 `codeModeLocales` 时用 `coalesce(jsonb_typeof(…),'')` 守住 NULL；书的语种为空串时 JS 一律不就绪，SQL 用 `coalesce(locale,'') <> ''` 对齐——等价性测试在这两处抓到过真缺陷）。真实库用例逐字符证明。
- 调用点的 `select` 必须带共享片段 `PROMO_READINESS_SELECT`；**没带剧场信息的调用点按 link 判定**——口令码模式的推广对它不可见，失败方向是安全的（绝不会因漏改一处而把没有网址的推广放出去）。
- **防误伤**：MoboReader 剧场下"有口令码、没有网址"的推广仍然**不就绪**、不公开可见。JS、SQL、`/go`、公开列表、站点地图各有一份用例钉住。
- 数据库约束 `article_published_promo_link_check` 只要求"发布的文章挂了推广链接"（`promo_link_id IS NOT NULL`），不看网址，**无需改**（已核实）。
- 同步改动的调用点（开发单列的路径逐个核实过，并补了几处遗漏——`article-rebind`、`preview-opening.ts`、`home-carousel`、`theater-duplicates`）：发布门禁 `src/server/publish-gate/facts.ts`；详情页 / 章节页访问 `src/server/publication/access.ts`、`src/lib/site/queries.ts`；列表 / 搜索 / 分类计数 `src/lib/site/public-list.ts`、`src/lib/site/article-card.ts`；站点地图（粗预筛）`src/lib/seo/sitemap.ts`；IndexNow 资格 `src/lib/indexnow/eligibility.ts`；hreflang `src/lib/seo/novel-hreflang.ts`；试读补采 `src/server/publication/preview-enqueue.ts`、`scripts/preview-opening.ts`；换小说 `src/server/article-rebind/{guards,preview}.ts`；生成准入与执行 `src/server/content-creation/{eligibility,promo,generate}.ts`；首页轮播 `src/server/home-carousel/service.ts`、`src/lib/site/home-carousel-service.ts`。

### D3 目录扫描按机构分流

- 每本书按自己的 `agencyId` 落到**同渠道、同 `projectType`、`status = active`** 的剧场里 `config.agencyIds` 包含它的那一个（`src/lib/tasks/catalog-agency-routing.ts`）。
- 找不到（新机构、没有机构编号、同一个机构号被两个 active 剧场同时声明）→ 仍落在本次扫描任务的剧场下，**保持现状、不丢数据**，同时在每页结果与任务汇总里计数（`agencyRouting`：各剧场分到的书数，以及退回任务剧场的 `unmappedBooks` / `unmappedAgencies` / `ambiguousBooks`，最多记 20 个不同机构号），便于以后发现新机构。只记进任务结果、不打日志——`worker/handlers/moboreader.ts` 受 P2-05 合同约束，不得出现任何日志调用。
- **只有 active 的剧场参与分流。** 新登记的 PlotNovel 剧场默认 `registered_disabled`（CPS 同款"新建默认停用"），在运维手册规定的"改挂完成"那一步之前，目录扫描的落点与改动前完全一致，不会出现"存量还挂在 MoboReader、新书却落进 PlotNovel"的重复建档。
- 语种映射：`plotnovel` 与 `moboreader` 指向同一份畅读语种注册表（两者的上游是同一个接口，语种码含义相同）。
- "不完整"分支：口令码模式的剧场，有码没网址也写库；link 模式仍要求网址。

### D4 存量改挂（P3 级生产数据变更）

`scripts/rehome-plotnovel-source-items.ts`：把机构 1351 的书目与推广链接从 MoboReader 挪到 PlotNovel 名下。这不是改一个外键——下面这些东西都带着剧场编号：

1. `promo_link.idempotency_key = sha256("promo_link\n<剧场>\n<书目>\n<账号>\n<offer>")`，必须按新剧场**重算**；否则领取 handler 用新剧场算出的键找不到已有那一行，会再 upsert 一条并对已领的书发第二次真实 `getcode`（上游接口不幂等）。
2. `side_effect_intent.target_id` 存的正是上面那个键（防重复领取的最后一道闸），意图行的 `channel_app_id` 同步改挂，状态不变。
3. `source_label` / `source_label_mapping` 按剧场分账，标签投影要求同一剧场：为这批书用到的标签在 PlotNovel 下建一份（已有复用）并改指标签关联，把语种范围内的映射边**复制**（不是移动）过去。
4. 领取 handler 校验"书目所属剧场 == 任务里的剧场"，改挂后旧任务条目会全部失败；其它任务也是在书目、小说、文章上排队，改挂中途它们的前提会变。所以执行前不能有任何在途（`pending` / `processing`）的任务条目，也不能有进行中的目录扫描。"这批书的任务条目"按三种目标一起查，按 `target_id` 文本匹配（都是 uuid），不依赖 `targetType` 的拼写：
   - **书目编号**：领推广、物化、建小说（`targetType = novel_source_item`），以及试读补采的同步任务条目（`channel_sync_task_item.novel_source_item_id`）；
   - **书目所属的小说编号**：文章生成叶子（`targetType = novel`）、自动打标（`targetType = Novel`）；
   - **挂在这批推广链接上的文章编号**：文章发布（`targetType = article`）。

   闸门只看条目状态，所以对含这批书的领取批次必须「中止」，「暂停」不改条目状态、过不了闸门（手册步骤 2）。
5. 分类归属投影 `novel_effective_tag` 只认 **active** 剧场名下的标签与映射。改挂时 PlotNovel 还是 `registered_disabled`，这批书暂时没有归属；所以运维顺序是"改挂 → 置 active → 对账"，对账后归属与改挂前逐行相同（真实库用例钉着）。改挂与登记两个脚本的相关写入点已登记进 B-38 写入点登记表，分类为"运维脚本，跑完必须对账"。

闸门与执行方式：默认只读预演并打印各类计数；`--apply` 必须同时给 `--confirm REHOME_PLOTNOVEL_SOURCE_ITEMS`、`--expected-source-items N`、`--expected-promo-links M`，数量不符立即拒绝；前置闸门（未完成任务条目 / 进行中的扫描 / 唯一键冲突 / 数据异常 / **已发布文章**）任一不为 0 则拒绝并列出明细；单事务、持咨询锁、一条 `operation_audit`；可重复执行（第二次候选 0，改挂 0 行、不写审计）。

**不处理**（历史执行记录，改写等于篡改证据）：已结束的 `generic_task` / `channel_sync_task` 及其条目、`operation_audit`、`tracking_event`。后果只有一个：对历史失败条目点"重试"会在书目绑定校验上安全失败，需要重新建任务。

**比开发单多出来的一道闸：已发布文章。** 改挂会把这批推广链接的就绪规则从"有网址"换成"有口令码且语种在白名单"。如果已有"已发布"的文章挂在这些推广链接上，已被收录的页面可能变 404，违反"公开网址冻结"。生产实数这批书一篇都没发出去，预期为 0；脚本把这个预期变成闸门（`gate_published_pages`），不为 0 就拒绝，由 Owner 单独决定。

### D5 同名去重

口令码模式剧场的书，如果存在**同语种、同规范化书名**、属于**非口令码剧场**（即 MoboReader），**并且那本书有就绪的推广**，就不可生成（后台中文原因："MoboReader 已有同名书"）。

- 为什么对侧要"可用"：拍板的依据是"MoboReader 能直接跳转、转化更好"。对侧如果没有就绪推广（还没领到码、领取失败、没有网址），它自己都发不出去，这时再把 PlotNovel 那本排除，就是两本都不发。对侧没有就绪推广时，PlotNovel 这本照常可生成。（主控复核裁决，v0.6.0 复核后收紧。）
- "就绪"不另写一套口径：数据库里用 `readyPromoLinkWhere()` 做预筛（超集）并限定在非口令码剧场，逐行再用唯一权威 `isPromoReady` 复核。
- 规范化沿用换小说功能的 `normalizeNovelTitle`（CPS `normalizeName` 逐字移植）。只影响生成候选（候选行、入队准入、批量生成枚举），**不改任何已存在的数据**。
- 判定写成"对侧在非口令码剧场下存在"，不写死 `moboreader` 这个名字（K2 纪律：闸只认数据库）。
- 对侧 `title_normalized` 为 NULL 的老行退一步按"书名忽略大小写相等"取回候选再现算比对——所以运维手册要求改挂前先跑 `backfill-novel-title-normalized.ts` 把 NULL 清零。

### D6 首页轮播排除口令码模式

自动候选按"推广所属剧场 ∉ 口令码模式剧场"过滤；人工位若指向口令码模式的书，以 `carousel_code_mode_excluded` 拒绝。过滤用 `channelAppId notIn <口令码剧场编号>`，没有用 JSON 路径取反（JSON 路径对 NULL 的语义会让 link 模式的行也被误排）。

### D7 前台

**`/go/<站内码>`**

- link 模式：302 行为**逐字不变**（测试钉住目标地址、状态码、`no-store` 响应头和"记一次点击"；`findUnique` 的 `select` 也被测试钉死，**路由从不读取 `upstreamCode`**）。
- code 模式且就绪：302 到 **`/go/<站内码>/app`**；不就绪（状态不是 `fetched` / 口令码空白 / 语种不在白名单）→ 404。
- 为什么是单独的 `/app` 子路径而不是原地渲染：`/go/[code]` 已经是 `route.ts`，Next 不允许同一路径段上同时有 route handler 和 page；而 link 模式的 302 又必须逐字不变，所以 code 模式在同一个 handler 里 302 到子页面。

**中间页 `/go/<站内码>/app`**（约束）

- 在 `/go/` 之下（`robots.txt` 已 Disallow `/go`）；元数据显式 `noindex, nofollow, nocache`；动态渲染，Next 对动态页统一发 `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`；`<title>` 是通用的一句，不含书名、更不含口令码。
- 判定与列表、详情页走同一个 `isPromoReady`，不另写一份；找不到 / 已软删除 / 不是口令码模式 / 不就绪 → 404。
- 不记录点击，复制按钮不埋点（拍板第 6 项）。
- 两个商店链接任一缺失就不渲染那个按钮；都缺时显示 `Search "PlotNovel" in your app store`。
- **没有免责小字**：设计稿底部原有的 `PlotNovel is a third-party app. <站点名> may earn a commission.` 已按运营 10-14 的决定去掉（手机 / 电脑版都没有；文案模块里的 `disclaimer` 一并删除，用例钉住页面上不出现 third-party / commission 字样）。

**入口按钮**（书页、章节页、底部浮条）：口令码模式文案为 "Read on PlotNovel App"，按钮下一行小字 "Free app · your book code is on the next page"；link 模式完全不变。

**口令码只出现在中间页**：书页、章节页、文章页的 HTML，站点地图，日志，视图模型都不出现上游口令码（`tests/backend/public/code-mode-leak.test.ts` 与原有"渠道真实码不进页面"用例并列钉住）。

**文章模板**：正文仍固化 `/go/<站内码>`；只在口令码模式下，把指向它的号召链接文字换成英文 "Read on PlotNovel App"（渲染之后的精确替换，不改模板数据、不碰别的链接）。

**文案**：只加英语，放在 `src/lib/locale/code-mode-copy.ts`，不进 15 语的 `messages/`（进去会触发"14 个非英语目录逐键齐全且不是英文原文"的完整性门禁，而 Owner 要求"不要自己翻译其它语种"）。

### D8 授权边界与数据库层收紧（`infra/postgres/grants.sql` + 迁移 `20261014120000_code_mode_upstream_code_guard`）

**要解决的问题**：口令码中间页要把上游口令码显示给读者。最初的做法是给 `web_app` 开 `promo_link.upstream_code` 的列级 SELECT——但列授权按行无法限制，`web_app` 在数据库层面就能读到**所有**推广链接（包含 MoboReader 的）的口令码。Owner 2026-10-14 决定"按数据库层收紧"：

| 角色 | 最终状态 | 原因 |
| --- | --- | --- |
| `web_app` | **对 `promo_link.upstream_code` 没有任何读权限**（`grants.sql` 里不授；直接读 → `permission denied`）。只读派生布尔列 `upstream_code_present`；对函数 `public.code_mode_upstream_code(text)` 有 `EXECUTE` | 就绪判断只需要"口令码是否非空"；中间页取码只能经函数 |
| `scheduler_app` | `promo_link` 列级 SELECT 增加 `channel_app_id`；新增 `channel_app` 列级 SELECT `(id, config)`；仍读不到 `upstream_code` 与 `upstream_code_present` | `queryActiveLocales` 复用的 `activePublicArticleWhere` 加了口令码模式的**粗**分支（只看推广所属剧场 `promoMode = code`，不碰口令码，不碰语种白名单） |
| `worker_app` | 不变（表级读写，目录同步 / 领取 / 站点地图都要读口令码）；函数没有 `EXECUTE` | |
| `analyst_ro` | 不变，读不到 `upstream_code` 与 `upstream_code_present`；函数没有 `EXECUTE` | |

**迁移里的三样东西**（一个迁移，`prisma migrate deploy` 一次到位）：

1. **派生布尔列 `promo_link.upstream_code_present`**（`BOOLEAN NOT NULL DEFAULT false`，加列不重写表）+ **触发器** `promo_link_upstream_code_present_sync`（`BEFORE INSERT OR UPDATE`，触发器函数 `promo_link_sync_upstream_code_present()`，SECURITY INVOKER）：每次写入都按 `upstream_code` 重算，`coalesce(btrim(upstream_code, <JS trim 的 25 个字符>), '') <> ''`，与 JS 的 `isNonBlank` 逐字等价；任何写入方给什么值都会被覆盖，伪造不了（用例钉着）。迁移末尾用一次"口令码原值写回自己"的空更新触发回填（不碰 `updated_at`，站点地图 lastmod 不受影响）。
   **为什么必须有它**：撤掉 `web_app` 对 `upstream_code` 的读权限之后，所有 web 侧的就绪判断（公开列表 SQL、详情 / 章节访问、发布门禁、可生成判定、首页轮播、hreflang……）都读不了"口令码是否非空"。就绪规则不能因此放宽，所以把"是否非空"这一个比特物化成一列，`web_app` 只读它。`PROMO_READINESS_SELECT` 与 `promoReadySql` 的口令码分支因此改读 `upstreamCodePresent` / `upstream_code_present`（JS 判定在没有布尔列时才退回看口令码本身，仅供能读它的角色与测试夹具用）。
2. **取码函数** `public.code_mode_upstream_code(p_public_redirect_code text) RETURNS text`：`LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public`；**属主就是执行迁移的 `migration_owner`**（本仓库迁移与 `grants.sql` 重放的统一身份；本仓库此前没有 SECURITY DEFINER 函数，B-15 的触发器函数也是由迁移执行者创建）；`REVOKE ALL ... FROM PUBLIC`，`EXECUTE` 只在 `grants.sql` 里授给 `web_app`（`grants.sql` 每次迁移后重放，开头会 `REVOKE ALL ON ALL FUNCTIONS`，所以迁移里授的权会被抹掉，必须写在 `grants.sql`）。
   它按站内码精确查一条 `promo_link`，**只有同时满足**以下条件才返回该条的 `upstream_code`，其它一律 `NULL`：未删除 ∧ `status = 'fetched'` ∧ 所属剧场 `config->>'promoMode' = 'code'` ∧ `upstream_code_present` ∧ 书的语种非空且是剧场 `config->'codeModeLocales'` 数组里的一项（元素按原样比较）。这与 `isPromoReady` 的口令码分支逐项一致（真实库用例用"配置 × 语种 × 口令码 × 状态"矩阵与 JS 对照）。标量函数、精确匹配，没有集合返回，没有可枚举的接口。
3. **`grants.sql`**：`web_app` 的列授权 `(web_url, app_url, upstream_code)` → `(web_url, app_url, upstream_code_present)`，加 `GRANT EXECUTE ON FUNCTION public.code_mode_upstream_code(text) TO web_app`。运行器把 `grants.sql` 重放两次，全库 ACL 摘要必须逐字相同（幂等）。

**中间页**（`loadCodeModePageData`）：先按站内码查一次推广链接（不选口令码），用 `isPromoReady` 判定，再经 `$queryRaw` 调这个函数取码；函数返回 `NULL`（数据库层不放行）就 404。其它任何 web 路径都拿不到口令码。

**数据字典合同**：`scripts/check-database-dictionary-drift.mjs` 的函数合同改为"零参数 SECURITY INVOKER 触发器函数"加"一个**明确白名单**的 SECURITY DEFINER 函数（`code_mode_upstream_code`）"；今后再新增任何 DEFINER 函数必须有意识地改这份白名单。字典 +4 条（字段 1、触发器 1、函数 2）。

### D9 公开网址冻结合规

- 不改任何已有页面的网址、跳转目标、canonical、hreflang、站点地图写法、robots。
- 新增的只有 `/go/<站内码>/app`（新页面，第一天起 `noindex`，不进站点地图）和口令码模式新书的新页面。
- 口令码模式推广链接的 `/go/<站内码>` 此前对外是 404（这批书没有发过一篇文章，站内码从未出现在任何公开页面里），现在 302 到中间页；这不是对已有跳转的修改。
- 改挂不改 `public_redirect_code`、不改 slug；已发布文章的拦截闸见 D4。

## 改挂流程（摘要）

发版后按手册顺序执行：登记剧场（默认停用）→ 暂停领取与目录扫描 → 改挂（预演 → 备份 → 带数量的 apply）→ 打开能力并把剧场置 active → 恢复领取 → 决定试读白名单 → 小批量生成与发布（单批 ≤ 500）→ 回滚。细节、命令与回读见 `docs/operations/PLOTNOVEL_THEATER_OPENING_2026-10-14.md`。

## 已知限制及触发条件

| 编号 | 限制 | 触发条件（出现即另开单处理） |
| --- | --- | --- |
| L1 | 后台没有剧场管理页，商店链接 / 剧场配置只能经脚本（`register-plotnovel-theater.ts`）改，且每次一条审计。CPS 的 `/changdu-theaters` 本版不照搬 | 运营需要自助改链接，或者出现第三个剧场 |
| L2 | 口令码模式文案只有英语，且只对 `codeModeLocales = ["en"]` 生效 | PlotNovel 出现非英语书时：**先补译文**（把 `code-mode-copy.ts` 搬进 `messages/` 过完整性门禁），**再**把语种加进 `codeModeLocales`。在此之前如果有人先改了配置，其它语种页面会以英语原样出现这些文案 |
| L3 | 配置里的 `codeModeLocales` / `agencyIds` 等没有改配置的脚本开关；`register-plotnovel-theater.ts` 把登记内容当冻结事实，配置被手工改过会报 `metadata_drift` 而不是悄悄覆盖 | 需要调整语种白名单 / 机构编号时：先改脚本里的 `PLOTNOVEL_THEATER` 常量并随版本发布，或经 Owner 批准的 SQL 后同步常量 |
| L4 | 没有口令码模式的"紧急关闭"开关：公开可见性随配置实时变化，但把 `codeModeLocales` 清空要走 SQL | 第一次需要紧急下线口令码模式页面时（受"公开网址冻结"约束，下线本身需要 Owner 单独批准） |
| L5 | 改挂脚本没有逆向脚本；数据层回滚以改挂前的备份为准，改挂后若已领取 / 已发文，不建议回滚数据 | 需要把 PlotNovel 书目挪回 MoboReader 时 |
| L6 | 口令码只校验"去空白后非空"，不校验格式 / 长度 | 上游口令码出现异常形态（含空格、过长）导致页面展示或复制出问题时 |
| L7 | 同名去重只认"同语种 + 规范化书名相等"；对侧 `title_normalized` 为 NULL 的老行靠"忽略大小写相等"兜底，书名只差标点的极少数书可能漏判 | 改挂前回填 `title_normalized` 后仍发现漏判时 |
| L8 | 取码函数 `code_mode_upstream_code()` 是 `web_app` 取得口令码的**唯一**途径，它信任调用方传入的站内码是合法的；知道某个口令码模式剧场就绪推广的站内码就能拿到它的口令码（这本来就是中间页的功能）。站内码是随机码，函数是标量精确匹配，不能用通配符、前缀、批量探测 | 出现任何新的 Web 侧代码想读口令码（新增带 `upstreamCode` 的查询，或新增调用该函数的地方）时，先改这条限制与字典白名单再动；要把函数改成按会话 / 来源限流或加访问审计时 |
| L9 | 站点地图 / 活跃语种的口令码分支是**粗**预筛，口令码为空或语种不在白名单的推广也会被放过，由逐行 `isPromoReady` 复核剔除（与 link 模式"`not: ''` 放过纯空白网址"同一个已接受的缺口） | 站点地图出现空分片或明显多余的语种时 |
| L10 | 目录扫描里"同一个机构号被两个 active 剧场同时声明"会退回任务剧场并计数，不报错 | 告警计数 `ambiguousBooks` 非 0 |
| L11 | 点击 / 复制不埋点（拍板第 6 项），无法统计"口令码到达率" | 运营需要口令码页转化数据时 |
| L12 | **标签映射两套账会漂移**：改挂只在改挂那一刻把 MoboReader 名下的映射边**复制**一次到 PlotNovel 名下，之后两个剧场各自维护映射（`source_label_mapping` 按剧场分账，分类归属投影只认同一剧场内的标签与映射）。MoboReader 以后新增 / 修改的映射不会自动出现在 PlotNovel 名下，反之亦然 | 分类对账 `effective-tag-projection.ts check` 在置 active 并对账之后仍出现 PlotNovel 名下的 `missing`（归属缺失）；或映射审批页出现 PlotNovel 的待映射标签。处理：先看缺的是哪些标签 / 语种范围；若只是 MoboReader 后来新增的边，写一个"把 MoboReader 名下新增的映射边增量复制到 PlotNovel"的同步脚本（照改挂脚本第 5 步的 `INSERT … NOT EXISTS`，幂等）；若两边口径本来就该一致，则合并口径（让投影对同渠道各剧场共用一份映射），那是迁移级改动，另开单评估 |

## 与开发单的偏离和补充

1. 中间页路径是 `/go/<站内码>/app`，口令码模式的 `/go/<站内码>` 302 过去（原因见 D7）。开发单只要求"在 `/go/` 路径下"。
2. 改挂脚本多一道"已发布文章"闸（D4）。
3. 删除了只有测试在用的 `isCodeModeBookReady`：它按"裁剪后"的白名单判定，与唯一权威（原样比对）口径不同，留着就是埋第二套口径。
4. 数据库层收紧（D8，Owner 10-14 复核后追加）：开发单原本是"不加迁移"，现在有 1 个迁移。撤掉 `web_app` 对 `upstream_code` 的读权限后，就绪判断读不了"口令码是否非空"，所以迁移里除了取码函数还多了派生布尔列 `upstream_code_present` 与维护它的触发器——这是撤权限的必要配套，不是额外功能。
5. 中间页底部免责小字按运营 10-14 的决定去掉（D7）。

## 参考了 CPS 的哪些实现（只读标签 v8.7.3）

- **剧场模型与"新建默认停用、领取关闭"**：`src/lib/changdu-theater/contract.ts`（状态 `inactive` / `active`，领取档位 `off` / `manual` / `auto_after_sync`）与 `src/lib/changdu-theater/service.ts`（新建时 `status: "inactive"`、`promoClaimMode: "off"`，并写变更记录）。海阅对应：新剧场 `registered_disabled`，4 条能力记录 `registered_disabled`，每次实际改动一条 `operation_audit`。
- **K2"领取闸只认数据库、不留写死名单"**：`src/lib/changdu-promo-claim-theaters.ts`。海阅对应：代码模式 = 库里存在 `promoMode=code` 的剧场；同名去重判定为"对侧在非口令码剧场下存在"，不写死 `moboreader`。
- **前台口令码卡片**：`src/components/site/share-code-card.tsx`（口令码 + 复制按钮的交互与"复制后短暂变为已复制"）。海阅对应：`CopyCodeButton.tsx`，**去掉了** CPS 的复制埋点（拍板第 6 项）。
- **CPS 没有实现口令码模式**，就绪规则的二选一、目录按机构分流、中间页均为新做，按本单约束。

## 验证

- 单元 / 契约：`tests/backend/publication/{theater-promo-mode,visibility,promo-ready-where,js-trim-whitespace-set}.test.ts`、`tests/backend/tasks/{catalog-agency-routing,moboreader}.test.ts`、`tests/backend/foundation/register-plotnovel-theater.test.ts`、`tests/backend/content-creation/{theater-duplicates,code-mode-cta}.test.ts`、`tests/backend/home-carousel/code-mode-exclusion.test.ts`、`tests/backend/public/{go-redirect,code-mode-page,code-mode-leak}.test.ts`、`tests/ui/{code-mode-interstitial,code-mode-entry-buttons}.test.tsx`。
- 真实库（一次性 postgres:16.14 + 真实角色 + 真实迁移 + 真实 grants）：`scripts/run-plotnovel-theater-postgres-verification.sh`，覆盖目录分流、改挂（成功 / 数量不符 / 未完成任务 / 已发布文章 / 重复执行 / 唯一键冲突）、就绪规则 JS ↔ SQL 逐字符等价（含触发器算出的布尔列）与防误伤、`scheduler_app` 的 `queryActiveLocales` 不被拒、领取批次能挑到 PlotNovel 的书、同名去重；**数据库层收紧**（`tests/integration/plotnovel/code-function-postgres.test.ts`）：`web_app` 直接读 `upstream_code` 的 13 种形态全部 `permission denied`；取码函数在口令码模式就绪行返回口令码，link 模式 / 语种不在白名单 / 非 fetched / 空白口令码 / 已删除 / 不存在 / 通配符一律 `NULL`，并与 `isPromoReady` 做"配置 × 语种 × 口令码 × 状态"矩阵对照；函数属主 / SECURITY DEFINER / 固定 `search_path` / `EXECUTE` 仅 `web_app`；触发器伪造不了；`worker_app` / `scheduler_app` 不变；中间页取数端到端。运行器把 `grants.sql` 重放两次（全库 ACL 摘要逐字相同），最后跑数据字典漂移检查。
