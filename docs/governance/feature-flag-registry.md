# Feature Flag Registry

| Name | Default | Readers | Scope |
| --- | --- | --- | --- |
| `FEATURE_NOVEL_CATALOG_SYNC` | `false` | manual task factory, MoboReader catalog Worker handler | Allows the proven read-only `getlistpc` catalog workflow to be queued/consumed. |
| `NOVEL_CATALOG_SYNC_ALLOW_WRITE` | `false` | manual task factory, MoboReader catalog Worker handler | Allows protected business writes only when the feature flag is also true and task mode is `apply`. As of Phase D (2026-09-06 施工工单_PhaseD_安全与运行态收口), the manual task factory's enqueue gate (`taskStatus`) also requires this to be `true` uniformly for `dry_run` and `apply` alike -- neither mode is claimable/consumed while it is `false`. |
| `FEATURE_P2_06_5_TAGGING` | `false` | Tagging resolver、Admin routes、bootstrap/backfill | CanonicalTag 总闸；仅 exact `"true"` 开启读取与管理面。 |
| `FEATURE_P2_06_5_TAG_ADMIN_WRITE` | `false` | CanonicalTag/mapping/manual snapshot Admin services | taxonomy、mapping 与 manual snapshot 写闸；仍需 `tag:manage`、2FA、request ID 与审计。 |
| `FEATURE_NOVEL_TAG_AUTO` | `false` | resolver、tagging task factory/worker | 允许读取 auto layer 与创建 auto task；不等于授权生产写入。 |
| `AUTO_WRITE_AUTHORIZED` | `NO` | auto classification Worker | 最终 Owner gate，仅 exact `"YES"` 放行 scoped auto apply；本次交付保持 `NO`。 |
| `FEATURE_INDEXNOW_OUTBOX` | `false` | `src/lib/indexnow/dispatch-handler.ts`'s `enqueueIndexNow`, `outbox.ts`'s `enqueueIndexNowFirstPublish`/`releaseDeferredIndexNowOutbox` | Allows the IndexNow outbox enqueue path to run at all (P2-11). |
| `INDEXNOW_OUTBOX_ALLOW_WRITE` | `false` | same as above | Allows `indexnow_outbox` rows to actually be written; both this and `FEATURE_INDEXNOW_OUTBOX` must be `true`. |
| `FEATURE_INDEXNOW_DELIVERY` | `false` | `src/lib/indexnow/sweep.ts`'s `sweepDueIndexNowDeliveries`, `worker/handlers/indexnow-delivery.ts` | Allows the delivery sweep to create `GenericTaskItem`s and the worker handler to run at all. |
| `INDEXNOW_DELIVERY_ALLOW_WRITE` | `false` | same as above | Allows the worker handler to call the real IndexNow API and write attempt/outcome data; both this and `FEATURE_INDEXNOW_DELIVERY` must be `true`. |

Both `FEATURE_NOVEL_CATALOG_SYNC`/`NOVEL_CATALOG_SYNC_ALLOW_WRITE` use exact `=== "true"` parsing. A `dry_run` may read and build a plan when the feature flag is true, but the P1 runtime strips its protected write before finalization. Phase D (2026-09-06 施工工单_PhaseD_安全与运行态收口) adds two independent layers on top of that pre-existing runtime strip: the MoboReader catalog/preview Worker handlers themselves never attach a `protectedWrite` closure at all when `mode === "dry_run"` (so there is nothing left for the runtime to strip, and a direct handler call outside the normal worker loop is covered too), and `finalizeTaskItem` (`src/lib/tasks/store.ts`) fail-closed refuses to invoke any `protectedWrite` a handler still attaches under a `dry_run` lease, forcing the item to `failed` with a `dry_run_protected_write_blocked` error/audit reason instead. `dry_run` never upserts a source item, writes a label, creates/binds a `PromoLink`, or materializes a preview, under any of the three layers.

Tagging 的三层开关独立：master 关闭时全体 fail closed；Admin write 只控制人工治理写；auto flag
只控制 auto layer/task。auto apply 必须同时满足 master、auto flag 与
`AUTO_WRITE_AUTHORIZED === "YES"`。本次 category public projection 只读 manual/mapped，不新增或
放宽任何 auto-write 路径。

**PR6 fix lane F（2026-09-06）：这四行此前从未接入运行配置。** X8 现场
`grep -i TAGGING docker-compose.yml .env.example scripts/lib/x8-levels.json`
零命中——本表格描述的语义一直存在，但没有任何一处运行配置真正透传这四个变量，导致
生产/X8 上 `/categories`、`/tags/canonical`、`/tags/mappings` 读到未设置的
`FEATURE_P2_06_5_TAGGING` 时以 `TaggingAdminError("tagging_disabled")` 崩到错误边界。
现已接入 `docker-compose.yml`（`web`/`worker`；`scheduler` 不消费，未接）、
`scripts/lib/x8-levels.json`（Level 0 全 `false`/`NO`；Level UAT、Level R 的
`FEATURE_P2_06_5_TAGGING`/`FEATURE_P2_06_5_TAG_ADMIN_WRITE` 为 `true`，
`FEATURE_NOVEL_TAG_AUTO`/`AUTO_WRITE_AUTHORIZED` 三级恒为 `false`/`NO`）与
`.env.example`。`scripts/acceptance/x8-validate-compose.mjs` 对
`FEATURE_NOVEL_TAG_AUTO`/`AUTO_WRITE_AUTHORIZED` 有独立于
`scripts/lib/x8-levels.json` 取值的硬编码断言（ADR guard），任何 level 渲染出
`true`/`YES` 都直接 FAIL。详见 `docs/p2/V020_RELEASE_CHECKLIST.md` §2/§3。

The four IndexNow flags (P2-11, `P2_07_12_一轮实施分工方案_2026-08-12.md` §三 Stream E) are deliberately two *independent* double-gate pairs rather than one pair shared by both capabilities, matching the round's rollout convention ("enqueue 先行、worker 后开", `P2-07-12-移植审计-2026-08-12/P2-11.md` §11 红旗5): operators can turn on outbox writes first to inspect accumulated candidate URLs/eligibility before the worker ever calls the real external IndexNow API. All four use exact `=== "true"` parsing, same as the pair above.
| `FEATURE_SITEMAP_AUTO_REFRESH` | `false` | Sitemap refresh enqueue adapter | Allows a filesystem-only Sitemap refresh task to be queued after publication. Disabled means no task row is created. |
| `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` | `false` | Sitemap refresh Worker handler | Allows the Worker to generate and atomically promote a static Sitemap only while `FEATURE_SITEMAP_AUTO_REFRESH` is also true. |

All flags use exact `=== "true"` parsing and default off. A catalog `dry_run` may read and build a plan when its feature flag is true, but the P1 runtime strips its protected write before finalization. Sitemap enqueue and filesystem promotion are separate gates: queuing requires `FEATURE_SITEMAP_AUTO_REFRESH`; Worker execution requires both Sitemap flags.

| `FEATURE_PROMO_LINK_CLAIM` | `false` | `src/lib/tasks/promo-link-claim.ts`'s task factory, `worker/handlers/promo-link-claim.ts` | Allows the promo-link claim task chain to run at all. The handler first performs the evidenced `getlistpc` readback; an explicitly enabled `claimPromo` capability may then permit one `getcode` mutation, followed by readback. Unknown recovery is readback-only. |
| `PROMO_LINK_CLAIM_ALLOW_WRITE` | `false` | same as above | Allows protected `PromoLink`/`SideEffectIntent` writes; both this and `FEATURE_PROMO_LINK_CLAIM` must be `true` and task mode must be `apply`. Necessary but not sufficient for the disabled `claimPromo` branch specifically — that also requires `ChannelCapability.status = 'enabled'` for capability key `claimPromo`. P0-S6 added the audited, evidence-required `scripts/set-channel-capability-status.ts` toggle; no automatic or unaudited path enables it. |
| `FEATURE_ARTICLE_SEO_VISIBILITY` | `false` | `src/server/publication/visibility.ts`'s `isHiddenFromPublicView`/`buildPublicArticleWhere`/`buildPublicListArticleWhere`, `src/server/publication/access.ts`'s `checkNovelArticlePublicAccess`, `src/lib/seo/sitemap.ts`'s `isVisibleCandidate`/`articleSitemapWhere`, `src/lib/indexnow/eligibility.ts`'s `isNovelIndexNowEligible`, and (worker process) `worker/handlers/sitemap-refresh.ts`'s `createSitemapFamilyBuilder`, `worker/handlers/indexnow-delivery.ts`'s `isNovelIndexNowEligible` call | C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25): gates whether public-site reads (on-site listing, detail-page reachability, sitemap, IndexNow) honor `Article.seoVisibility` (`public`/`seo_only`/`hidden`, C-24 axes foundation) at all. Exact `=== "true"` parsing. Consumed by BOTH the web and worker services — every function above defaults its own `env` param to `process.env`, and the worker's sitemap-refresh/indexnow-delivery handlers never override it, so each process reads its own copy; `docker-compose.yml` registers this var in both the web and worker service blocks. Only the scheduler never reads it (enqueue-only, no public-site read path to gate). |

`FEATURE_ARTICLE_SEO_VISIBILITY` is a **single gate, deliberately not a double-gate pair** — this is the one place in this table that needs a "why is there only one flag" note rather than a "why are there two". The "一 flag 一函数、双闸" discipline every pair above follows exists to separate *reading/planning* a protected business write from *actually performing* it (dry-run vs. apply, enqueue vs. worker execution). This flag gates nothing but public-site **reads** — there is no write for a second gate to protect. While it is `false`, every Article is read as if `seoVisibility` were `public` (today's pre-C-25 behavior, byte-identical), but the admin filter/column/editor controls are **not** gated by it at all — they read and write the column unconditionally, so operators can pre-stage `seo_only`/`hidden` values before the public-facing behavior is switched on ("后台先行、公开后开", the same rollout convention this repo's IndexNow outbox/delivery pair already uses for its own enqueue-before-worker sequencing).

`FEATURE_PROMO_LINK_CLAIM`/`PROMO_LINK_CLAIM_ALLOW_WRITE` follow the same "一 flag 一函数、双闸" discipline and exact `=== "true"` parsing as every pair above. dry-run walks the real §3.9/§3.10 decision tree (feature flag, TTL, scope resolution, already-fetched short-circuit, existing-promo pre-read) but makes zero adapter calls and zero writes regardless of the write-allow flag — see that handler's own header comment for the full decision table.

| `FEATURE_ARTICLE_BLOG` | `false` | `src/app/(admin)/articles/page.tsx` (header "新建博客" button render), `src/app/(admin)/articles/new-blog/page.tsx` (page-level `notFound()` kill switch), `src/server/content-creation/blog.ts`'s `createBlogArticle` (service-level fail-closed), and (C-29) `src/server/publication/access.ts`'s `checkBlogArticlePublicAccess`, `src/app/blog/page.tsx`/`src/app/blog/[slug]/page.tsx`, `src/lib/seo/sitemap.ts`'s blog sitemap family (`createSitemapFamilyBuilder`), `src/lib/indexnow/eligibility.ts`'s `isBlogIndexNowEligible` (predicate only — not yet wired to a live enqueue/recheck call site, see that function's own doc comment) | C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28) added the capability; C-29 (§三/C-29) extends it to the public read side. Off means: the header button does not render, `/articles/new-blog` 404s, the creation service refuses even a direct call, `/blog` and `/blog/{slug}` both 404, and the sitemap emits zero `blogpage` files. Exact `=== "true"` parsing, default off. |
| `ARTICLE_BLOG_ALLOW_WRITE` | `false` | same as `createBlogArticle` above | Second key: even with `FEATURE_ARTICLE_BLOG` on, `createBlogArticle` validates its input but performs zero writes unless this is also `true` — "功能开了也不写库", same discipline every double-gate pair above follows. |

`FEATURE_ARTICLE_BLOG`/`ARTICLE_BLOG_ALLOW_WRITE` follow the same "一 flag 一函数、双闸" discipline and exact `=== "true"` parsing as every other pair in this table — unlike `FEATURE_ARTICLE_SEO_VISIBILITY` above, this one genuinely is a pair, because "新建博客" is a protected business *write* (the first write path in this codebase that can create an Article with `novel_id IS NULL`), not a read-side gate. `ARTICLE_BLOG_ALLOW_WRITE` stays **web-only** — `createBlogArticle`'s only caller is the admin Server Action, no worker/scheduler caller (grepped before registering). `FEATURE_ARTICLE_BLOG` itself is **NOT web-only as of C-29** — `src/lib/seo/sitemap.ts`'s `createSitemapFamilyBuilder` also reads `isArticleBlogEnabled(env)` (default `process.env`) to decide whether to emit the `blogpage` family, the same shape `FEATURE_ARTICLE_SEO_VISIBILITY`'s worker consumption already has, so `docker-compose.yml`'s `worker` service block now carries `FEATURE_ARTICLE_BLOG` too (NOT `ARTICLE_BLOG_ALLOW_WRITE` — the worker never performs the blog write, only reads the flag to gate sitemap emission). `src/lib/indexnow/eligibility.ts`'s `isBlogIndexNowEligible` also reads this flag but is not yet called from any file under `worker/` — the natural call site (`worker/handlers/indexnow-delivery.ts`'s drift-recheck) has no blog `IndexNowOutbox` row to ever recheck this round, because the enqueue-on-publish call for a blog Article is still skipped by `publish-gate/service.ts`'s `dispatchFirstPublicPublication` guard (`txResult.novelId !== null`) — that file was out of scope this round (reserved for a concurrent workstream), so only the standalone, independently-tested eligibility predicate ships; wiring the actual enqueue is a follow-up. `tests/backend/flags/article-blog-flags-passthrough.test.ts` asserts the current registration shape (web-only `ARTICLE_BLOG_ALLOW_WRITE`, worker-registered `FEATURE_ARTICLE_BLOG`).

| `FEATURE_ARTICLE_NOVEL_REBIND` | `false` | `src/app/(admin)/articles/_components/article-rebind-panel.tsx`（编辑页面板渲染开关）、`src/server/article-rebind/service.ts`（服务层 fail-closed）、（C-30B）批量换绑页面 `notFound()` 与批量服务 | C-30A/C-30B（施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.5/附录 E）总闸：换绑能力（单篇 + 批量）是否存在。关闭时编辑页不渲染换绑面板、批量页 404、服务层对直接调用也 fail-closed。 |
| `ARTICLE_NOVEL_REBIND_ALLOW_WRITE` | `false` | 同上（单篇换绑服务的写入路径；C-30B 批量执行/续跑） | 第二把钥匙：即使总闸打开，换绑本身（单篇写入两字段、批量执行/续跑）在这把钥匙也打开之前零写入。🔴 **不覆盖**批量预览快照自身的写入——见下一行的单闸例外。 |

`FEATURE_ARTICLE_NOVEL_REBIND`/`ARTICLE_NOVEL_REBIND_ALLOW_WRITE` 遵循与本表其余每一对相同的
"一 flag 一函数、双闸"纪律与精确 `=== "true"` 判定——换绑是一次保护性业务写入（两字段原子替换），
不是只读能力。🔴 **一处明写的单闸例外（施工工单 §4A.5 明确要求"执行方不得静默改成双闸或改成无
闸"）**：C-30B 的批量预览快照写入（`article_novel_rebind_preview` 行）只受总闸 `FEATURE_ARTICLE_
NOVEL_REBIND` 保护，**不**受 `ARTICLE_NOVEL_REBIND_ALLOW_WRITE` 约束——理由与本表 `FEATURE_
ARTICLE_SEO_VISIBILITY` 那条单闸说明同形：预览快照由运营自己触发、带 30 分钟过期、没有任何业务
副作用（从不触碰 `Article.novelId`/`promoLinkId`，也从不调用单篇换绑服务），而"先看清楚再看开
写"对渠道故障切换这个场景有真实运营价值——同"后台先行、公开后开"（`FEATURE_ARTICLE_SEO_
VISIBILITY`）/"enqueue 先行、worker 后开"（IndexNow outbox/delivery 两对）同一节奏。该例外由一对
正/负向测试钉死，禁止被"优化"成双闸或无闸。C-30A（单 1）只登记这两把钥匙与本行说明；预览快照
写入代码本身是 C-30B（单 2），本行提前把契约写清楚，避免那段代码落地时临时决定。两把钥匙均**仅
Web 进程消费**——`worker`/`scheduler` 无任何调用点（换绑能力全部经 Server Action 触发，grep 后确
认无消费方），故 `docker-compose.yml` 只在 `web` 服务块登记，不进 `worker`/`scheduler`。

| `PUBLIC_TRACKING_WRITE_DISABLED` | `false`（未设置 = 写入开启） | `src/lib/flags/feature-flags.ts` 的 `isPublicTrackingWriteDisabled`，唯一调用方为 `src/app/go/_lib/tracking-guard.ts` 的 `shouldRecordGoRedirect`（再由 `src/app/go/[code]/route.ts` 调用） | RC-6 安全阀：置真时 `GET /go/[code]` 不再写 `TrackingEvent` 行，跳转行为（302/404、目标 URL、`Cache-Control: no-store`）完全不受影响。用于刷量高峰或数据库写压力下的临时止血。 |

| `ADMIN_TWO_FACTOR_ENFORCEMENT` | `true`（未设置 = 强制） | `src/lib/auth/two-factor-enforcement.ts` 的 `readTwoFactorEnforcement`/`isTwoFactorEnforced`，调用方遍布 `src/lib/auth/capabilities.ts`（`requireAdminTwoFactor`）、`src/server/auth/guards.ts`（`enforceAdminSessionTwoFactor`）、`src/app/(admin)/_lib/page-guard.ts`、`src/app/(admin-auth)/login/_actions.ts`、`src/app/(admin-auth)/_lib/auth-session.ts`（`postAuthDestination`） | RC-10 全局开关：`false` 时后台跳过强制 2FA 注册/挑战，任何未完成 2FA 的会话都被当作已完成；`true`（默认）时行为与 RC-10 之前逐字相同。 |

`ADMIN_TWO_FACTOR_ENFORCEMENT` 取值解析也不是简单 `=== "true"`（与下面的 `PUBLIC_TRACKING_WRITE_DISABLED` 同类，但失败方向相反），单独说明：

1. **不是能力开关，是强制开关，且失败方向是"保持强制"。** 规范值是 `true`（强制，默认）/`false`（关闭）；`required`/`disabled`（2026-09-04 首版用的词形）作为同义词继续被接受，trim 后大小写不敏感。唯一能关闭 2FA 强制的精确值是 `false` 或 `disabled`；未设置、`true`、`required`、拼错的值（`Disable`/`off`/`0`/`no`）一律解析为强制。这是本登记表里唯一一个"认不出的值 → 更严格"的 flag——刻意如此：这是安全边界，不是普通功能开关。
2. **默认值必须是 `true`。** `.env.example`、`docker-compose.yml` 的 `web` 服务、`scripts/lib/x8-levels.json` 的 Level 0/Level R 均显式或隐式落在 `true`；唯一允许 `false` 的是 `scripts/lib/x8-levels.json` 的 Level UAT（`X8_LEVEL=uat` 本地拓扑）。
3. **关闭时打一次启动期告警。** `warnTwoFactorDisabledOnce()`（同文件）在进程内只 `console.error` 一次，由 `scripts/two-factor-enforcement-preflight.ts` 在 `scripts/start-web.sh` 里、`node server.js` 启动前调用；不在每次请求的 guard 里调用，避免刷屏。

| `ADMIN_LOCAL_IDENTITY_SEED` | 未设置（= 拒绝） | `scripts/ensure-local-admin-identities.ts` 的 `requireLocalIdentitySeedAllowed` | RC-11：本地 X8 `admin`/`admin2` 两账户种子脚本的硬门禁；同时是该脚本内 `hashAdminPassword` 12 位密码下限的唯一豁免条件（`minLength: 1`，仅在此脚本自己的执行路径内生效，不改 `hashAdminPassword` 默认值）。 |

`ADMIN_LOCAL_IDENTITY_SEED` 与 `ADMIN_TWO_FACTOR_ENFORCEMENT` 同一失败方向（未设置/拼错 → 更严格），但不是同义词精简开关——严格精确匹配（trim 后区分大小写），唯一放行值是精确的 `allow`：

1. **不是能力开关，是运维种子脚本的一次性豁免闸。** 只有 `scripts/lib/x8-levels.json` 的 Level UAT（`X8_LEVEL=uat`）导出 `allow`；Level 0、Level R 均导出空字符串，`scripts/ensure-local-admin-identities.ts` 精确匹配 `"allow"` 时才继续，其余任何值（含空字符串、`true`、大小写变体、首尾空格）一律 fail-fast。
2. **生产必须不设。** 见 `docs/p2/V020_RELEASE_CHECKLIST.md` §2；真实部署的 `docker-compose.yml`/`.env.example` 都不声明这个变量，与 CPS 无需长度豁免（无长度校验）不同，这是本仓专属的、刻意收紧的一次性豁免面。

`PUBLIC_TRACKING_WRITE_DISABLED` 是本登记表里**唯二的例外**，两处都是有意为之，不是疏漏：

1. **默认开而非默认关。** 上面每一个 flag 都是「能力开关」，默认关 = 能力不启用 = 安全。这一个是「停写开关」，默认关 = 写入照常发生。搬自 CPS `getTrackingWriteStatus`（`src/lib/cps-tracking.ts:42-56`，v8.3.6 `16f2e4cfca51f46af0dede899ecf6242a770bbd0`）但**默认值反转**：CPS 生产默认 `1`（`.env.example:160`、`docker-compose.yml:92`）因为它另有归因信号；本仓 `/go` 是唯一归因信号，未设置必须等于「写」。
2. **取值解析不用 `=== "true"`，而是照搬 CPS `isTruthyEnv` 的 `/^(1|true|yes|on)$/i` + `trim()`**（`src/lib/cps-tracking.ts:585-587`）。理由是失败方向：其它 flag 认不出的值 → 能力保持关闭 = 安全；这一个认不出的值 → 写入保持开启，即安全阀在最需要它的时刻静默失灵。运维在事故中按 CPS 习惯写 `on`/`yes`/`TRUE`、或在 Compose `environment:` 条目里留了尾空格（Compose 不会去掉），在严格匹配下都会变成静默 no-op。非真值（`0`/`false`/空/乱码）仍按「未停写」处理，安全默认保持为开。
