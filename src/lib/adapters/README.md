# src/lib/adapters/

**Owner: Codex（独占写入）**

## 用途

渠道适配器：把内部任务/领域模型转换为具体渠道（如畅读）的请求体，以及把渠道响应标准化为内部结构。对齐 CPS `src/lib/adapters/`（`channel.ts` 两方法接口 + `changdu*.ts` 实现）的角色，但契约需显著加宽、参数化（如 `projectType` 不得硬编码为模块级常量）。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

P1 任务表（`docs/p1/P1_IMPLEMENTATION_ASSIGNMENT.md` §3）当前未单列 Adapter 实现的任务编号；本目录与 `worker/`、`src/lib/tasks/` 同属 Codex 渠道同步链路，实现窗口预期贴合 **P1-07** 前后，具体编号以 Notion 台账为准。

## 特别纪律

- 🔴 **不得凭猜测写未经调研的渠道请求体**——每个字段必须有可核实的上游依据（抓包记录、官方文档或既有 CPS 只读参考中的实测证据），并在实现 PR 中注明依据；
- Adapter 层**绝不含网络调用之外的副作用**（不得在 Adapter 内直接写业务表）；
- 品类判别位（如 `projectType`）必须来自 `ChannelApp` 配置或 Adapter 能力声明，禁止写成模块级硬编码常量；
- 返回值需区分 `not_configured`（未配置）与请求失败两种语义，不得合并。
