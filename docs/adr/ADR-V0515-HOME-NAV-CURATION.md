# ADR：v0.5.15 首页题材导航改为运营勾选

- 状态：Owner 已决定（2026-10-10「全部按推荐」），本分支已实现，待复核与发布。
- 来源：B-38 方案「再议 B」，Owner 2026-10-09 排进 v0.5.15；业务方案 `方案_首页题材导航运营勾选_v0.5.15_2026-10-10.md`。
- 范围：前台首页那一排题材按钮改为"运营勾选的 ∩ 该语种有书的"分类；后台"分类管理"页加勾选面板；`canonical_tag` 加一列。不改分类页、页脚、详情页标签、站点地图，不改任何公开网址。
- 分支 / 工作树：`feat/home-nav-curation-v0515` / `cps海阅/home-nav-curation-v0515`。迁移 `20261010160000_canonical_tag_homepage_visible`。

## 背景

自 v0.5.13（B-38）起，首页题材导航显示"该语种所有有书的分类"。生产近似统计（2026-10-10）：英语 100 个按钮一字排开，印尼语 38、法语 29，小语种只有个位数。大部分用户只看得到前几个，运营没有任何办法挑选。后台虽有"分类管理"页，但生产的分类写入开关 `FEATURE_P2_06_5_TAG_ADMIN_WRITE` 是关的，页面上的编辑按钮全是灰的。

CPS 用 `Category.isHomepageVisible`（默认 true）解决同一个问题，首页只取勾选的分类。海阅照这个做法，但海阅分类有 123 个、按语种取交集、写开关为关，三处与 CPS 不同，见下文。

## 六个拍板结果

1. **字段与默认值**：分类表加 `is_homepage_visible BOOLEAN NOT NULL DEFAULT true`（对应 CPS `Category.isHomepageVisible`，同名同默认值）。默认全部显示，所以上线当天首页与上线前逐字一致；不在迁移里预置精选名单。
2. **后台形式**：`/categories` 页顶部一屏勾选面板 + 一次保存（全站一份名单，15 个语种共用，各语种再各自与"有书"取交集）。不照 CPS 在每个分类的编辑里单独勾——海阅 123 个分类、每页 20 个，从 100 个缩到 20 个要翻 7 页点约 100 次，每次一条审计。
3. **不受分类写入开关约束**：保存只要求分类读开关 + `tag:manage` + 两步验证 + 审计。写开关保护的是分类数据本身（停用分类会触发全站归属重算），首页勾选不改任何书属于哪个分类；为它打开写开关会把停用分类、改译名、改别名、改关键词这些高风险编辑一起放开。
4. **顺序**：沿用分类自身排序号（`sort_order`，再 `slug`），勾选只决定"显示哪些"，不改顺序。排序号可编辑另开单（会同时改变页脚前 8 个和详情页标签顺序，范围大）。
5. **交集为空**：这个语种首页不显示这一排，不回退成显示全部（与现在"没有分类就不显示"一致）。
6. **页脚不跟**：页脚仍是"有书的分类按排序前 8 个"。

## 硬性约束 H1～H9 与理由

| 编号 | 约束 | 理由 | 钉住的用例 |
|---|---|---|---|
| H1 | 只过滤首页。`listPublicCategories` 的结果同时喂首页导航、页脚（`categories.slice(0, 8)`）、详情页"可链接分类集合"；三者的集合与顺序都不变，只在 `HomeBody` 交给 `HomeScreen` 的那一刻过滤 | 页脚与详情页标签链接是已收录页面的站内链接，网址冻结期内不能因运营勾选而变；过滤若发生在 `loadPublicCategories` 里会连带改掉这两处 | `tests/ui/home-nav-curation.test.tsx`；`tests/backend/site/category-link-set-equality.test.ts`；真实库 `homepage-nav-postgres.test.ts`、`consistency-invariants-postgres.test.ts` |
| H2 | 不新增查询：`loadPublicCategoryTags` 的 SELECT 多读 `ct.is_homepage_visible`，投影成分类列表项上的只读 `homepageVisible`（`PublicCategoryTag`）；卡片标签形状不动 | 首页一次渲染的语句条数已被 `public-query-budget` 精确钉死（冷 7 / 暖 5），勾选标记搭车同一条语句读出即可 | `tests/backend/site/public-query-budget.test.ts` |
| H3 | 顺序不变：过滤是保序的 `filter` | 方案决定 4 | `tests/backend/site/home-nav.test.ts`、`home-nav-curation.test.tsx` |
| H4 | 交集为空则不显示，不回退 | 方案决定 5；回退会让运营看到"取消了的又出现了" | 同上 |
| H5 | 保存不改 `canonical_tag.updated_at`：原生 SQL 只更新 `is_homepage_visible` | 分类页站点地图的 lastmod 取自它（`buildCategoryEntries`），勾选不是分类页内容变化；Prisma `canonicalTag.update` 会因 `@updatedAt` 自动改时间，所以不能用 | 单元：更新语句不含 `updated_at`；真实库：保存前后所有行 `updated_at::text` 逐行相等 |
| H6 | 不受写开关约束，但仍要读开关、`tag:manage`、两步验证、会话新鲜 | 方案决定 3 | `homepage-nav-admin.test.ts`（写开关 false 仍可保存；读开关 false / 无权限 / 两步验证丢失 / 伪造票据被拒）；真实库在 `FEATURE_P2_06_5_TAG_ADMIN_WRITE=false` 下保存 |
| H7 | 不触发归属重算，不拿投影锁 | 勾选不改任何书的分类归属；重算要持投影独占锁，生产约 1 秒 | 单元：`reconcileAllEffectiveTags` / `lockEffectiveTagProjectionExclusive` 未被调用；写入点登记表登记为 `not_membership_relevant` |
| H8 | 行锁用 `FOR NO KEY UPDATE`，不用 `FOR UPDATE` | `FOR UPDATE` 与归属表重算时给投影行做外键检查要拿的 `canonical_tag` 行 KEY SHARE 锁冲突，可能互相等待成死锁（见 `mutateAdminCanonicalTag` 里 `set_status` 那段注释） | 单元：SQL 形状；真实库：保存与全量重算并发 6 轮不死锁 |
| H9 | 网址冻结：不改 slug、链接拼法、跳转、canonical、hreflang、站点地图、robots | AI_WORKFLOW「公开网址冻结」；首页按钮的 `href` 仍由 `projectPublicTaxonomyTag` 生成 | `home-nav-curation.test.tsx`（链接逐字符）；真实库：取消勾选后分类页仍 200、页数映射仍含它 |

其余设计要点：

- 保存是"整份替换"：请求带保存后名单和页面加载时的名单（expected），事务内拿行锁后把当前可见集合与 expected 做**集合**比较，不等返回 409 `homepage_nav_conflict`（"名单已被别人改过，请刷新后再保存"），不会悄悄覆盖。名单里有不存在或已停用的分类返回 400 `invalid_homepage_nav`。
- 事务内锁顺序：请求号咨询锁 → 命名空间锁 `v0515:homepage-nav` → 幂等重放 → 行锁 → 比对 → 校验 → 更新 → 审计。同一请求号重复提交只生效一次；同一请求号换了内容、或被另一类分类写入复用，返回 `idempotency_conflict`（新动作进了 `CANONICAL_ACTIONS`，两边的幂等查询互相看得见）。
- 只更新启用中的分类；停用分类的值保持不动，也不参与"当前可见集合"的比较。
- 审计：动作 `tag.canonical.homepage_nav.replace`，`entityType: CanonicalTag`，`entityId: homepage-nav`，前后快照为按 slug 升序的可见名单，附本次新增 / 去掉；后台面板折叠区展示最近 10 条。
- 授权：`web_app` 对 `canonical_tag` 是表级 SELECT 与表级 INSERT/UPDATE，`worker_app` 表级 SELECT（另有表级 INSERT/UPDATE），`scheduler_app` 无该表权限，新列自动覆盖，`grants.sql` 不改。
- 缓存时效：勾选状态随分类名同一条 SELECT 每次现读，保存后下一次打开首页立即生效；"有没有书"沿用 B-38 的 60 秒矩阵缓存（现状不变）。

## 与 CPS v8.7.2 的对照

| 项 | CPS | 海阅（本改动） | 结论 |
|---|---|---|---|
| 字段 | `Category.isHomepageVisible Boolean @default(true)` | `CanonicalTag.isHomepageVisible`，默认 true | 照搬 |
| 前台过滤 | `getHomepageCategories()`：`isHomepageVisible: true` + 启用，按 `sortNo, id` | 勾选 ∩ 该语种有书，按分类排序号、再 slug | 多一层"有书"交集（B-38 已有） |
| 后台 | 分类编辑弹窗里一个复选框；`updateCategory` 只校验登录，无审计 | 分类管理页一屏勾选面板；`tag:manage` + 两步验证；写审计；乐观比对 | 形式按决定 2；权限与审计按海阅后台规矩加严 |
| 写入开关 | 无 | 生产分类写入开关为关，首页勾选不受它约束 | 决定 3 |
| 名单范围 | 全站一份 | 全站一份（15 个语种共用） | 一致 |

## 改判触发条件

出现下列任一情况，本决定需要重新评估，不得直接改代码：

1. **要按语种分别勾选**（例如日语想放与英语不同的一排）：需要把字段拆成"分类 × 语种"的关系，保存接口、面板、审计快照、迁移都要重做，并重新评估首页给各分类的内链权重（见下）。
2. **要让页脚也跟着勾选**：页脚链接是已收录页面的站内链接，改变它等于改变站内链接图，需要重新对照网址冻结清单并由 Owner 解冻或书面豁免。
3. **要让详情页标签的可链接集合、分类页、hreflang 或站点地图读勾选**：同上，且会让"分类页返回 200 的集合 = 页脚 = 可链接集合 = 站点地图"这条 B-38 一致性不变量失效，需要先改 `consistency-invariants-postgres.test.ts` 的口径并重新评估收录影响。
4. **要让排序可编辑或首页改成按书数排序**：会同时改变页脚前 8 个与详情页标签顺序，另开单。
5. **要把保存纳入分类写入开关**（例如运维认为首页勾选也应受写开关保护）：只需把 `replaceHomepageNavSelection` 的读开关检查换成 `requireTaggingMutation`，但上线前必须先请运维打开写开关，等于同时放开分类全部编辑能力。
6. **取消勾选后 Google 收录或抓取明显变化**：取消勾选的分类少了一个"从首页指过去"的站内链接，首页给它们的权重会变少（它们仍被站点地图、详情页标签和页脚前 8 个链接）。如观察到收录受影响，应调整运营挑选，或评估上面第 2 条。
7. **分类写入由上游同步自动造出来**：目前分类只随发版由运维脚本导入，新增分类默认显示几乎只影响上线那一刻；若改成自动建分类，默认值需要重新评估。

## 验证

- 单元 / UI：`tests/ui/homepage-nav-admin.test.ts`、`homepage-nav-panel.test.tsx`、`home-nav-curation.test.tsx`、`tagging-admin-contract.test.ts`、`categories-disabled-state.test.tsx`；`tests/backend/site/home-nav.test.ts`、`category-link-set-equality.test.ts`、`public-query-budget.test.ts`。
- 真实库（一次性 postgres:16.14、真实角色与 grants）：`scripts/run-effective-tag-projection-postgres-verification.sh`（含 `homepage-nav-postgres.test.ts`）、`scripts/run-public-list-postgres-verification.sh`（含 `consistency-invariants-postgres.test.ts` 新增一例）。
- 发版后只读抽查（各一次请求）：首页题材条与上线前一致（默认全勾）；站点地图对应分片里分类页的 lastmod 与上线前一致。
