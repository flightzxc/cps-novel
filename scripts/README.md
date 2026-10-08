# scripts/

**Owner: Codex（独占写入）**

## 用途

一次性/运维脚本：恢复演练脚本、项目隔离检查脚本（验证无 CPS 路径引用、CPS 工作区未被写入）等。

## P2-06.5 Lane B

`p2-06-5-lane-b/` 提供独立只读的畅读 `seriesTypeList` 真实采样、B1 taxonomy 派生与 B2 CanonicalTag mapping 候选编译。入口与安全操作见 `docs/p2/P2_06_5_LANE_B_RUNBOOK.md`。

## P2-06.5 Tagging explicit task

`p2-06-5-production/tagging-backfill.ts` 只创建显式 `tagging.auto_classify` GenericTask。必须提供
`--lifecycle initialize_missing|reclassify_existing`、`--request-id`，并且恰好选择
`--novel-id`、`--locale` 或 `--all` 之一。默认 dry-run；apply 还必须满足 tagging 双闸和
精确 `AUTO_WRITE_AUTHORIZED=YES`。Scheduler 不注册此任务。

## P2-06.5 CanonicalTag v1 bootstrap

`p2-06-5-production/tagging-bootstrap.ts` is the ADR-P2-06-5-TAGGING-V3 §12 "explicit
bootstrap CLI" — the additive migration ships no seed data, so this is the only path
that can put the 123 CanonicalTag v1 rows, their zh translations, their deterministic
keyword lexicon, and the 196 approved Changdu B2 mapping edges into a real database
(PR #6 review finding B-3). It reads two hash-pinned authority files
(`docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json`,
SHA-256 `8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad`;
`docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/mapping-candidates-final.csv`,
SHA-256 `140057fea8e09980ab465c4eb780e228d07d69dab37d54bbab312da9cab82c38`) and refuses
to run if either file's bytes ever change. It is deliberately outside the
`mutateAdmin*` semantic layer — bootstrap is an "authority plane" operation per the
ADR, so it never fabricates an admin session and writes its own `OperationAudit` row
directly (mirroring `scripts/bootstrap-admin-identity.ts`).

Default is dry-run (reads the authority files, hash-verifies them, prints planned vs.
current database counts, writes nothing). `--channel-app <symbol>=<ChannelApp UUID>`
binds the mapping file's symbolic `changdu-app` identifier to a real row — the CLI
never guesses a "unique candidate" by name (ADR §12 step 3), and this binding is
validated against the database in both modes. `--apply` additionally requires
`--approver <adminIdentity UUID or username>` (must already exist and be `active`;
used only for `source_label_mapping.approved_by` — `canonical_tag` has no actor
column) and writes inside one transaction with an advisory lock. Every write is an
upsert by that table's natural unique key, so a re-run with unchanged source data
never duplicates or corrupts a row; a re-run with the *same* `--request-id` is a pure
replay (finds the committed audit row, writes nothing at all).

```bash
npx tsx scripts/p2-06-5-production/tagging-bootstrap.ts \
  --request-id <stable-request-id> \
  --reason "<change ticket/reason>" \
  --channel-app changdu-app=<ChannelApp UUID>

npx tsx scripts/p2-06-5-production/tagging-bootstrap.ts \
  --request-id <same-stable-request-id> \
  --reason "<same change ticket/reason>" \
  --channel-app changdu-app=<ChannelApp UUID> \
  --approver <adminIdentity UUID or username> \
  --apply
```

Run against the `migration_owner` connection (`web_app` lacks the write grants on
these tables) — see `docs/operations/OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md` §2.6 for
the X8 container invocation form. Never writes `novel_canonical_tag` — that table is
only ever written by the admin manual-tagging mutation path.

## Additional admin identity

`add-admin-identity.ts` adds an active `super_admin` to a nonempty identity table.
It is dry-run by default; `--apply` creates the identity and audit atomically.
The command reads `ADD_ADMIN_PASSWORD_FILE` inside the container, checks it
against the existing `admin` password hash, then makes a new salted hash.
It never accepts a password in argv or enrolls 2FA. Same-request-id retries
replay without another write. For the fixed preproduction values, read-only
secret mount, allowlist update and web-only restart, follow
`docs/operations/ADMIN_IDENTITY_ADD_2026-09-25.md`.

## MoboReader foundation registration

`register-moboreader-foundation.ts` 只登记冻结的 MoboReader / Changdu 基础档案，不创建凭证、
不访问上游，也不启用 capability。默认 dry-run；真实写入必须显式加 `--apply`：

```bash
MOBOREADER_FOUNDATION_OPERATOR=<operator> \
  npx tsx scripts/register-moboreader-foundation.ts \
  --request-id <stable-request-id> \
  --reason "<change-ticket/reason>"

MOBOREADER_FOUNDATION_OPERATOR=<operator> \
  npx tsx scripts/register-moboreader-foundation.ts \
  --request-id <same-stable-request-id> \
  --reason "<same-change-ticket/reason>" \
  --apply
```

已存在行的 metadata 不一致时脚本拒绝写入。新 capability 一律创建为
`registered_disabled`；已经通过受审计流程启用的同 metadata 行保留 `enabled`，本脚本不降级。

## 填充任务

按需（无固定单一任务）；已知会用到本目录的任务包括 **P1-06**（恢复演练脚本）与 **P1-13**（项目隔离检查脚本）。

## 特别纪律

- 脚本不得对 CPS 只读参考路径（`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`）产生任何写入，包括临时文件、日志、缓存；
- 隔离检查脚本需覆盖：无 symlink / submodule / 相对路径引用 CPS 目录；CPS 工作区 `git status --porcelain` 恒为 0 行。

## 模板 SEO 字段回写（TKD 对齐 CPS，2026-09-30）

`l10n/repair-template-tkd.ts` 把 15 个默认模板"原地更新"之后的新 `seoTemplate.metaTitle` 刷到**存量文章**
的 `Article.seoMetadata`（只写 `metaTitle`/`metaDescription` 两个键，自动跳过 `contentMode = manual`）。
薄壳；逻辑与全部安全闸在 `src/server/article-templates/tkd-repair.ts`（头注释有清单）。默认只预演；
`--apply` 需要预期篇数、备份、操作人与理由、执行清单、游标；**不要用前台应用角色 `web_app` 跑**，
用 `worker_app`。完整的 L2 流程与示例命令见脚本文件头注释。真实库验证：
`scripts/run-tkd-repair-postgres-verification.sh`。模板引导脚本 `l10n/article-template-bootstrap.ts`
的 dry-run 报告新增 `changes[]`，逐行列出将写入的行与差异字段——生产上 `--apply` 前应恰好是 15 行
`update`、每行只有 `seoTemplate.metaTitle`。

## 分类归属投影检查与对账（B-38，2026-10-09）

`ops/effective-tag-projection.ts` 对应 CPS `scripts/backfill-effective-tags.ts`，操作小说分类归属派生表
`novel_effective_tag`。规则、锁和"只写差异"的语义见 `src/server/tagging/effective-tag-projection.ts` 文件头；
**那个文件是全仓库唯一允许写这张表的地方**。在 worker 层执行（`worker_app` 对该表有读写删权限），
不打印连接串或密钥：

```bash
# 只读检查（默认）：全 0 退出 0，否则退出 3
npx tsx scripts/ops/effective-tag-projection.ts check
#   EFFECTIVE_TAG_CHECK missing=<n> extra=<n> changed=<n>
# 全量对账：必须同时带 --apply 和确认短语，缺一个就只做上面的只读检查
npx tsx scripts/ops/effective-tag-projection.ts reconcile --apply --confirm RECONCILE-EFFECTIVE-TAGS
#   EFFECTIVE_TAG_RECONCILE inserted=<n> updated=<n> deleted=<n> ms=<n>
```

什么时候用：发版后验收（`check` 必须全 0，迁移里已经一次建好，不需要回填）；回滚到上一版再前滚之后
（回滚期间旧代码不会重算）；以及**任何运维脚本直接改过映射 / 标签真源之后**（例如
`p2-06-5-production/tagging-bootstrap.ts`）——它们绕过了"同事务重算"的写入点，必须 `reconcile` 一次。
防漏登记用例 `tests/backend/tagging/effective-tag-write-path-registry.test.ts` 里这类脚本登记为
`ops_script_requires_reconcile`。真实库验证：`scripts/run-effective-tag-projection-postgres-verification.sh`。

