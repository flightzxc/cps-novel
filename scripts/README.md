# scripts/

**Owner: Codex（独占写入）**

## 用途

一次性/运维脚本：恢复演练脚本、项目隔离检查脚本（验证无 CPS 路径引用、CPS 工作区未被写入）等。

## P2-06.5 Lane B

`p2-06-5-lane-b/` 提供独立只读的畅读 `seriesTypeList` 真实采样、B1 taxonomy 派生与 B2 CanonicalTag mapping 候选编译。入口与安全操作见 `docs/p2/P2_06_5_LANE_B_RUNBOOK.md`。

## 填充任务

按需（无固定单一任务）；已知会用到本目录的任务包括 **P1-06**（恢复演练脚本）与 **P1-13**（项目隔离检查脚本）。

## 特别纪律

- 脚本不得对 CPS 只读参考路径（`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`）产生任何写入，包括临时文件、日志、缓存；
- 隔离检查脚本需覆盖：无 symlink / submodule / 相对路径引用 CPS 目录；CPS 工作区 `git status --porcelain` 恒为 0 行。
