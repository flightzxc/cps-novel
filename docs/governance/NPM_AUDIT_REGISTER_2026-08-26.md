# npm audit 处置台账（2026-08-26）

> 取证基线：`ce7f0f1` + S16 提案 `240bad6`；命令：`npm audit --json`。
> 结果：`high=8`、`critical=0`（共 8 个被报告的 package node）。
> 本文只登记风险与处置路径，不修改 package/lockfile；两者 merge custodian 为 Claude。

## 1. 真实构成

| package | 来源 / 当前版本 | 实际边界 | 处置 |
| --- | --- | --- | --- |
| `next` | 直接依赖 `16.1.6` | 含 Server Components/Actions DoS、Server Function endpoint disclosure、App Router Middleware/Proxy bypass、SSRF 等公告；本项是上线安全升级，不得豁免为“未使用 next/image” | 另立 Claude custodian PR 将 `next` 与 `eslint-config-next` 同步升至 `16.3.3`，完成全门禁后再放行 |
| `postcss` | `next@16.1.6` 内嵌 `8.4.31` | 受 source-map 文件读取/路径穿越链影响；顶层 Tailwind/Vite 已是 `8.5.25`，但不能抵消 Next 内嵌旧版 | 随 Next PR 修复，不手工强制 dedupe |
| `sharp` | `next@16.1.6` 间接依赖 `0.34.5` | 受 libvips 继承漏洞影响。仓内零 `next/image` 调用只能说明当前业务无显式图像优化路径；Dockerfile 会复制完整 `node_modules`，因此 **不得声称 sharp 不在生产镜像** | 随 Next PR 复核升级结果；另立生产镜像依赖裁剪/可达性验收 |
| `prisma` | 直接 devDependency `6.19.2`，`@prisma/client` 同版 | audit 风险由 CLI 配置链引入；`npm audit fix --force` 给出 `6.12.0` 降级，会破坏已冻结的 CLI/Client 同版契约 | 禁止 force fix；限期延期至 **2026-09-09 或首次生产发布（取较早）**，到期前由 Claude 评估安全升级版本 |
| `@prisma/config` | `6.19.2` | Prisma CLI 配置链聚合项 | 与 Prisma 同期延期/同 PR 处理 |
| `deepmerge-ts` | `@prisma/config` 间接依赖 `7.1.5` | 递归对象图合并可导致栈耗尽；本仓无直接 import | 与 Prisma 同期延期，禁止绕过 Prisma 单独 override |
| `effect` | `@prisma/config` 间接依赖 `3.18.4` | RPC 并发下 AsyncLocalStorage context 污染；本仓无直接 Effect/RPC 调用 | 与 Prisma 同期延期，保留到期复核 |
| `nanoid` | PostCSS 间接依赖 `3.3.16` | 公告针对 custom generator `size=0` 无限循环；本仓无 nanoid import/自定义 generator | 限期延期至 **2026-09-09 或首次生产发布（取较早）**；优先随 Next/PostCSS lockfile 更新消除 |

## 2. 禁止的“修复”

- 禁止运行或合入整体 `npm audit fix --force`。当前建议同时包含 Next 跨补丁升级与 Prisma 降级，不具备可审核的单一意图。
- 禁止仅因“仓内没有 `next/image`”就声称 sharp 已从生产排除。Dockerfile 当前明确将 builder 的完整 `node_modules` 复制到 runner。
- 禁止为通过 audit 而手工 override Prisma 的间接依赖；必须保持 Prisma Client/CLI 同版和生成物验证。

## 3. Next custodian PR 必过验收

1. `next` + `eslint-config-next` 同步升至 `16.3.3`，只由 Claude custodian 修改 package/lockfile。
2. 重跑 typecheck、UI/backend/integration tests、build、eslint 和 `npm audit --json`。
3. 对 standalone 生产镜像做启动/健康/公开路由/admin 默认拒绝验收，特别回归 Server Actions 和 Proxy/Middleware 绕过公告所涉路径。
4. 核对 `sharp` 与 Next 内嵌 `postcss` 的实际 lockfile 版本；不以直接依赖版本推测间接依赖已修复。
5. 若 `npm audit` 仍有 high，逐项回填新的可达性、责任人和到期日；不得将旧台账直接标成“已解决”。

## 4. 镜像裁剪跟进

当前 runner 同时复制 `.next/standalone` 和完整 `node_modules`。另立跟进验证 web/worker/scheduler 是否需要同一份全量依赖，
并以实际容器启动、Prisma engine/CLI 命令、worker/scheduler 入口和恢复脚本为验收。未验收前不允许盲删生产依赖；
验收后以更小、可证明的运行时依赖集替代全量复制。
