# scripts/

**Owner: Codex（独占写入）**

## 用途

一次性/运维脚本：恢复演练脚本、项目隔离检查脚本（验证无 CPS 路径引用、CPS 工作区未被写入）等。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

按需（无固定单一任务）；已知会用到本目录的任务包括 **P1-06**（恢复演练脚本）与 **P1-13**（项目隔离检查脚本）。

## 特别纪律

- 脚本不得对 CPS 只读参考路径（`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`）产生任何写入，包括临时文件、日志、缓存；
- 隔离检查脚本需覆盖：无 symlink / submodule / 相对路径引用 CPS 目录；CPS 工作区 `git status --porcelain` 恒为 0 行。
