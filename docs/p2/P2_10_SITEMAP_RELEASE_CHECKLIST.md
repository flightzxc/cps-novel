# P2-10 Sitemap 上线单

## 部署环境

- [ ] Web 与执行 Sitemap 刷新的 Worker 均显式提供真实 `SITE_URL`。
- [ ] `SITE_URL` 是绝对 HTTP(S) origin，且不含凭证、path、query 或 fragment。
- [ ] 未使用 CPS 域名、localhost、fixture 域名或代码/镜像默认值。
- [ ] 在未设置 `SITE_URL` 时执行 `npm run build` 仍通过；该变量只在运行期请求或刷新任务中读取。
- [ ] 运行期缺失或非法 `SITE_URL` 时，robots/Sitemap 生成链路保持 fail-closed。

## 静态服务不变量

- [ ] `/sitemap.xml` 和 `/sitemap/[fileName]` 只读 `current` 静态 release；缺失返回 503，不查库、不动态生成。
- [ ] 正式 locale HTTP dry-run 仅在 D-7 关闭后执行；fixture 验收只通过 generator 参数注入并直接读盘。

## PR2 开关门禁

PR2 合入后在本节登记 enqueue/worker 双闸及 D-7 开启顺序；PR1 不提供任何生产 flag 默认值。
