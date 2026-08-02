# src/features/admin-ui/

**Owner: Claude（独占写入）**

## 用途

后台管理界面的功能模块：渠道账户页、任务中心、批量操作向导等页面级功能实现。消费 `src/server/`（Codex）暴露的 API/Server Action 与能力位契约，不直接访问数据库。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-09（后台框架、菜单、字段与 CPS UI 复刻）** 填充。

## 说明

后台**页面与交互**归 Claude（对齐 `P1_OWNER_MINIMUM_CORRECTIONS.md` 修正 1 的职责分界澄清）；Codex 负责后台背后的 API、能力位与数据。
