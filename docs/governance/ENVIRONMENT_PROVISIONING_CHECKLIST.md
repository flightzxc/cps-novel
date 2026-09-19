# 环境开通与发布清单

本表记录环境级的**运营配置项**：这类值属于环境，不属于代码，不会随发布一起带过去。

🔴 **每一项都是「首次配置，后续发布只校验」**，不是每次发布都要重做一遍：
值一旦在某个环境配好，就一直留在该环境的数据库里，后续发布只需**确认它还是对的**
（照下面各项的「验收」做一次只读核对），确认无误即通过，**不要重复写入**。
重复写入不是幂等的补救动作——它会平白产生一条 `operation_audit`、顶掉别人刚改的
值，并让「这个值上一次是谁、为什么改的」这条线索断掉。

只有在**新开通一个环境**、或校验发现值不对（被改过 / 迁移重建过库 / 恢复了旧备份）
时，才执行配置动作。

它与 `PRODUCTION_RELEASE_BLOCKERS.md` 分工不同：那份表只登记**阻断发布**的高风险
事项；本表是常规步骤，不阻断发布，但漏掉会让环境跑在错误的配置上。

---

## 1. 站点品牌名（`SiteSetting.siteName`）

| 项 | 值 |
| --- | --- |
| 目标值 | `PulseNovel` |
| 执行方式 | **后台设置页**（`/settings` 的「站点名称」字段） |
| 何时执行 | **仅首次配置**：新环境开通时，或校验发现值不对时 |
| 每次发布 | **只校验，不写入**（见下方「验收」，全为只读核对） |
| 适用范围 | 每一个新开通的环境 + 生产 |
| 决策 | Owner 2026-09-20 |

### 🔴 必须从后台执行，不能用 SQL 绕过

直接 `UPDATE site_setting SET site_name=...` 会绕过三道既有保护：

1. `settings:manage` 能力位与会话新鲜度校验（`requireFreshAdminServiceMutation`）；
2. `expectedUpdatedAt` 乐观并发——并发编辑时该返回冲突，而不是后写覆盖先写；
3. `operation_audit`——与业务写**同事务**落审计（`CLAUDE.md` §5 修正 4 的事务边界）。

绕过这三条产生的是一条「谁在什么时候把站点名改成了什么」无法回答的变更。

### 为什么不做成自动默认值

新环境初始化出来的 `site_name` 是 `CPS Novel`，这**不是**某处显式写死的品牌名，而是
v0.2.0 foundation 迁移里这条语句的副产品：

```sql
INSERT INTO "site_setting" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP);
```

它不写 `site_name`，继承的是**当时**的列 DEFAULT（`'CPS Novel'`）。迁移按顺序执行，
这一行在任何后续迁移之前就已定型，而这张单例表此后再无第二次 INSERT。

因此：

- **改列 DEFAULT 无效。** 2026-09-19 曾加过这样一条迁移，2026-09-20 在一次性空库上
  跑完整迁移链实测：`column_default` 确实变成了 `'PulseNovel'`，行却仍是 `'CPS Novel'`。
  该迁移已整条回退——留着只会是一个运行时无效、却让人以为已生效的假象。
- **不用广泛回填。** `UPDATE ... WHERE site_name='CPS Novel'` 会同时改到所有尚未配置过
  的已有环境（含生产），绕过上面那三道保护。
- **不修改历史 foundation 迁移。**
- 也不为了一个品牌默认值单独新建一套 provisioning 机制。

将来若建立正式的环境开通流程，再把品牌配置纳入该流程；在那之前，本表就是唯一提醒。

### 验收（首次配置后做一次；此后每次发布重复这一节即可）

这一节全部是**只读**核对，不涉及任何写入。在该环境的公开页确认三处都跟随
（它们都读同一个配置项）：

- 页头与页脚字标（`BrandLockup`，DOM 上是 `[data-brand-slot="wordmark"]`）
- 首页 `<title>`
- `og:site_name`

> 详情页 / 列表页的 `<title>` **不带** `| PulseNovel` 后缀是本仓库的既有契约——
> `normalizeMetadataTitle` 会主动剥掉尾部的 `| 站点名`，品牌走 `og:site_name`。
> 看到没有后缀不要当成缺陷去「修」。

`SiteSetting` 有 30s 进程内 TTL 缓存（`getSiteSetting`），后台写入路径会调
`invalidateSiteSettingCache()`；若你是用别的方式改的值，最多等 30s 才会在前台生效——
这也是一条「为什么该走后台」的旁证。

---

## 2. 数据库统计信息（`ANALYZE`）

| 项 | 值 |
| --- | --- |
| 目标 | `public` schema 下**每一张有行的表**都有列统计（`pg_stats` 非空） |
| 执行方式 | 对该环境的库执行一次 `ANALYZE;` |
| 何时执行 | **首次配置**（迁移 + 种子 / 恢复备份之后），以及每次**批量导入内容之后** |
| 每次发布 | **只校验，不执行**（下方校验语句为只读） |
| 发现时间 | 2026-09-20 真实数据 UAT |

### 为什么这是运营项，不是代码项

2026-09-20 实测：`/ko` 首页每次加载 **5.1 秒**，并发刷新时撞上 `web_app` 角色的
`statement_timeout=30s` 直接 500。

真因不在代码里——是 `channel_app` 这张**只有 1 行**的注册表从建库起就没被分析过
（`pg_stats` 零条目，`last_analyze` / `last_autoanalyze` 均为 NULL）。没有列统计，
规划器对 `ca.status = 'active'` 只能套默认等值选择率 `0.005`，把
`source_label_mapping ⋈ channel_app` 估成 1 行（实际 196），于是整条分支看起来
近乎免费，先展开了 178 万行的标签扇出，才轮到最具选择性的 `novel_id IN (...)`。

只补一句 `ANALYZE channel_app`，查询一字不改就从 **2,696ms → 0.68ms**。

🔴 **这类表永远等不到 autovacuum。** autovacuum 的 analyze 阈值是
`50 + 0.1 × reltuples`；写一次就不再变的小注册表（`channel_app`、`channel`、
`channel_capability` 这一族）改动数永远够不到，从建库到下线都不会被自动分析。
本次普查时 `public` 下有 20+ 张表零统计。

统计信息是**环境属性**：新建库、恢复备份、PG15+ 统计计数器因非正常关闭被重置，
都会让它重新消失。所以它属于本表，而不是某次代码发布。

### 执行

```bash
psql "$DATABASE_URL" -c "ANALYZE;"
```

整库 ANALYZE 只更新统计信息，**不改任何数据、不持有长锁**，可在线执行。
本次在 5.4 万行量级的库上实测耗时 **11 秒**。

### 校验（只读）

```sql
-- 期望返回 0：有行却没有列统计的表
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relkind = 'r'
  AND c.reltuples > 0
  AND NOT EXISTS (
    SELECT 1 FROM pg_stats s
    WHERE s.schemaname = 'public' AND s.tablename = c.relname
  );
```

> 不要用 `pg_stat_user_tables.last_analyze IS NULL` 当判据：PG15+ 的统计计数器
> 存在共享内存里，非正常关闭会被清零，于是**已经分析过**的表也会显示 NULL。
> 本次普查里 54 张表有 49 张 `last_analyze` 为 NULL，但其中大多数 `pg_stats`
> 是有内容的。唯一可靠的判据是 `pg_stats` 有没有条目。

### 代码侧已有的兜底

`src/lib/site/public-taxonomy.ts` 把首页那条分类查询改写成先物化目标行，
统计缺失时把最坏情况从 2,696ms 封顶到 15ms（统计齐全时的代价是 +0.4ms）。
**那是兜底，不是替代**——本项仍要做，否则整库其它查询没有这层保护。
