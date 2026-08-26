# scripts/

**Owner: Codex（独占写入）**

## 用途

一次性/运维脚本：恢复演练脚本、项目隔离检查脚本（验证无 CPS 路径引用、CPS 工作区未被写入）等。

## P2-06.5 Lane B

`p2-06-5-lane-b/` 提供独立只读的畅读 `seriesTypeList` 真实采样、B1 taxonomy 派生与 B2 CanonicalTag mapping 候选编译。入口与安全操作见 `docs/p2/P2_06_5_LANE_B_RUNBOOK.md`。

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
