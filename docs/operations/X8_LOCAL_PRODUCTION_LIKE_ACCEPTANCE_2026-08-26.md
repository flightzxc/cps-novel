# X8 本地 Production-like 验收报告（2026-08-26）

## 结论

- 实现交付：**PASS**。六服务隔离拓扑、TLS/nginx、容量闸、PostgreSQL hardening、备份恢复、统一 CLI、静态防线和脱敏证据均已落地。
- 自动化基础设施验收：**PASS**。最终运行镜像上的 `accept` 全部通过。
- 完整业务全链路：**FAIL**。执行时未提供获授权的 MoboReader QA/read-only JWT，credential、真实 catalog、内容创建、发布门禁及 `/go` 链路不能执行；数据库保持零凭证、零业务夹具，未伪造 PASS。
- 2FA 主链路：**PASS**。首次登录、TOTP 启用、再次登录、challenge 和进入后台均通过。
- 2FA 一次性恢复码展示：**FAIL**。启用动作使 bootstrap session 失效后页面直接回到登录页，没有停留在一次性恢复码视图；列入既定 R1 follow-up。

## 验收身份与证据

| 项目 | 值 |
| --- | --- |
| 分支 | `feature/x8` |
| 基线 | `5459e0b2105f1d16ae6383c5d6f69fda9f6c4d89` |
| 实测 commit | `36f4237d6c775d7ab63c0143c5d73f05bbf101ae` |
| 自动验收时间 | `2026-08-26T10:43:34Z` |
| 应用镜像 | `cps-novel:0.1.0-36f4237` |
| 镜像 ID | `sha256:d92fad3d718c4bbb17ccb20549845d47fd9424a483e13f269971152b338c9e2a` |
| OCI revision | `36f4237d6c775d7ab63c0143c5d73f05bbf101ae` |
| 自动验收证据 | `.tmp/x8-production-like/evidence/automated-acceptance-20260826T104334Z.log` |
| 证据 SHA-256 | `edcd62082170feed9717ae5c0f36c2239dfa0db62981465fcb164a4a2f666d76` |
| TLS 证书 SHA-256 | `51155BF14BD94110F3027C513C4655DA326237144B5AA4ABBF8E93AC6BBDCA62` |

Playwright 未保存敏感页截图、snapshot、trace、video 或 storage state。报告不包含密码、JWT、TOTP、恢复码、数据库连接串或完整敏感响应。

## 分项结果

| # | 验收项 | 结果 | 实测摘要 |
| --- | --- | --- | --- |
| 1 | 分支与 CPS 隔离 | PASS | 从指定 `main` 基线创建 `feature/x8`；只读使用 `git show v8.2.18:...`；禁止生产标识扫描与 compose 隔离校验通过。 |
| 2 | 六服务拓扑 | PASS | nginx、web、worker、scheduler、PostgreSQL、backup-timer 全部 healthy；仅 nginx 暴露 `127.0.0.1:80/443`，PostgreSQL 无宿主机端口。 |
| 3 | 网络与 volume 隔离 | PASS | edge/runtime 分离；nginx 仅在 edge，PostgreSQL 仅在 runtime；数据库、sitemap、WAL、备份均使用 X8 独立命名。 |
| 4 | PostgreSQL 迁移与 hardening | PASS | 迁移、角色 grants、`pg_stat_statements`、WAL archive 与角色级 statement/lock/idle timeout 均通过真实新会话验证。 |
| 5 | TLS 与 HTTP 跳转 | PASS | 证书 SAN 包含 `novel.test`、localhost 与 loopback；使用本地 CA 显式验证成功；HTTP 返回 308，HTTPS health 返回 200。 |
| 6 | 系统 hosts | FAIL | `/etc/hosts` 尚无 `127.0.0.1 novel.test`；自动化通过 Chromium host resolver 映射完成，不修改系统文件。 |
| 7 | 系统 CA 信任 | FAIL | `security verify-cert` 返回 `CSSMERR_TP_NOT_TRUSTED`；`mkcert -install` 需要操作者在自己的终端完成 sudo/Keychain 授权。 |
| 8 | nginx 安全与缓存边界 | PASS | `nginx -t` 通过；HSTS、nosniff、SAMEORIGIN、referrer policy 生效；登录等动态入口 `Cache-Control: no-store`；未使用 `proxy_ignore_headers`。 |
| 9 | real-IP 防伪造 | PASS | 注入 `X-Forwarded-For: 198.51.100.77` 后结构化日志仍记录 Docker 入口真实地址 `172.20.0.1`，未信任客户端伪造值。 |
| 10 | 容量闸 | PASS | AI/deep-page `limit_req` 动态返回 429；`limit_conn` 配置测试与隔离慢 upstream 阈值测试通过；覆盖 ClaudeBot、GPTBot、Bytespider。 |
| 11 | 管理员初始化 | PASS | 最终镜像内 bootstrap 首次写入已完成，同 request-id replay 为 `wrote=false`，未重复创建管理员或审计。 |
| 12 | 首次登录与 TOTP setup | PASS | Playwright 完成首次登录、生成密钥、浏览器内计算并提交 TOTP；密钥仅短暂存在于 sessionStorage，challenge 后立即删除。 |
| 13 | 一次性恢复码视图 | FAIL | setup 成功后 session 版本切换使页面直接回到 `/login`，没有可供操作者确认保存的恢复码视图；未抓取或记录恢复码。 |
| 14 | 再次登录与 2FA challenge | PASS | 第二次登录进入 `/two-factor/challenge`，TOTP 验证通过并进入 `/novels`。 |
| 15 | MoboReader foundation | PASS | channel/source/channel-app 注册成功；最终镜像 replay 为 `wrote=false`；仅 `getlistpc` enabled，其余 capability 保持 `registered_disabled`。 |
| 16 | 渠道账户与 credential validation | FAIL | 未收到获授权 QA/read-only JWT，未创建凭证；credential 表计数为 0。 |
| 17 | catalog dry-run | FAIL | 缺少有效 credential，无法进行真实上游 page 1/page size 20 调用。 |
| 18 | catalog apply 与双闸 | FAIL | 未执行真实 apply；验收结束后总闸与写闸均已关闭并重建 web/worker。闸状态本身验证 PASS。 |
| 19 | 内容创建与 Promo | FAIL | 无真实 source item，无法执行创建 dry-run/apply；Promo claim 始终关闭，未使用兜底夹具伪造上游链路。 |
| 20 | 发布门禁与 `/go` | FAIL | 无 Novel/Article/PromoLink，无法动态验证 `locale_not_publishable`、302、安全 Location、no-store 与 tracking event。相关静态/单元测试通过。 |
| 21 | robots/sitemap/health | PASS | `/robots.txt` 200 且引用 `https://novel.test/sitemap.xml`；无 current release 时 `/sitemap.xml` 为预期 503；内外 health 均为 200。 |
| 22 | backup timer 与 backup-now | PASS | 首启定时备份及手动备份均生成 dump、checksum、metadata；`pg_restore --list` 与一次性 smoke restore 通过。 |
| 23 | Launch-day SQL | PASS | analyst 只读 repeatable-read 会话执行五组 SQL，均成功完成；当前五组结果均为 0 行。 |
| 24 | 报告脱敏 | PASS | 仅保留状态、时间、commit、镜像/证据摘要、HTTP 状态和非敏感计数。 |

验收结束时业务表计数为：credential 0、source item 0、Novel 0、Article 0、PromoLink 0、tracking event 0。

## 最终安全状态

```text
SITE_URL=https://novel.test
ADMIN_CANONICAL_ORIGIN=https://novel.test
WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan
FEATURE_NOVEL_CATALOG_SYNC=false
NOVEL_CATALOG_SYNC_ALLOW_WRITE=false
FEATURE_PROMO_LINK_CLAIM=false
```

Promo 写闸、sitemap 自动刷新与 IndexNow 均保持关闭。真实 JWT 未进入 env、命令行、日志或报告。

## 回归结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS；仅 3 条既存 warning，无新增 warning |
| 完整 Vitest | PASS；209 files PASS、10 files SKIP；2492 tests PASS、95 tests SKIP |
| `npm run build` | PASS |
| compose config / nginx config | PASS |
| PostgreSQL timeout / extension / sitemap volume | PASS |
| backup restore / limiter integration | PASS |

相较基线，skip 数保持 95，未退化。

## 与真生产的已知差异

- mkcert 本地证书，不是公共 CA；系统信任尚未由操作者完成。
- `novel.test` 不是正式域名，hosts 项尚未由操作者完成。
- Docker Desktop 单机，不是 web/worker/DB 分离主机。
- 无 CDN/Cloudflare；入口只绑定 loopback，直接使用 Docker NAT 后的真实 `$remote_addr`。
- 应用镜像为固定 digest 的 linux/amd64 基础镜像，在本机 arm64 Docker Desktop 上仿真运行；正式构建需生成目标平台原生镜像。
- 备份仅留在本机，无异地对象存储、外部监控、证书自动轮换或公网流量。
- 当前容量阈值仅用于本地 production-like 验收，正式金丝雀前必须重新校准。

## 后续闸

- R1：把“setup 成功后恢复码一次性展示”的鸡生蛋回归加入 `admin-guards`，修复前不得把该子项记 PASS。
- R2：把 Action 全量 `"use server"` 扫描加入 `registry-parity`。
- 获得 QA/read-only JWT 后，重新执行本报告第 16–20 项；任何上游失败必须继续记 FAIL，不得以 fixture 替代真实 catalog 成功。
