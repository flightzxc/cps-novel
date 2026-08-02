# 搬运符号登记表（Port Registry）

本表登记所有从 CPS 只读参考仓库搬运到本项目的符号（函数、类型、常量、表结构片段、组件等）。

🔴 **纪律：每个从 CPS 搬入的符号都必须在此登记，未登记即视为违规。** P1-14（最终代码和架构审计）将逐条核对本表与实际代码，任何搬运但未登记的符号视为不符合项。

## 基线

- `baseline_commit` 统一为 CPS 只读参考仓库的固定基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`
- CPS 只读参考路径：`/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux`（详见仓库根 `CLAUDE.md`）

## `port_kind` 取值说明

| 取值 | 含义 |
| --- | --- |
| `COPY` | 原样复制，未做实质性改动 |
| `ADAPT` | 复制后做了改造（如泛化、参数化、重命名） |
| `PG_REIMPLEMENT` | 语义/思路保留，但因 SQLite → PostgreSQL 差异而重新实现 |
| `PATTERN_ONLY` | 只借鉴设计模式/组织形态，不搬运具体代码 |

## 登记表

**本轮（P1-04）尚未搬运任何 CPS 代码，表内仅有表头，无数据行。**

| symbol | source_file | source_lines | baseline_commit | port_kind | changed_what | owner |
| --- | --- | --- | --- | --- | --- | --- |

## 使用说明

- `symbol`：被搬运的具体符号名（函数名/类型名/表名/字段名/组件名等），一行一个符号，不得用文件级粗粒度笼统登记；
- `source_file` + `source_lines`：CPS 参考仓库中的精确文件路径与行号区间；
- `changed_what`：即使 `port_kind = COPY`，也需注明"原样复制"；`ADAPT`/`PG_REIMPLEMENT` 必须具体说明改了什么；
- `owner`：登记该符号的执行方（Claude 或 Codex）。
