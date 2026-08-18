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

- [ ] `FEATURE_SITEMAP_AUTO_REFRESH` 与 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` 均默认 `false`。
- [ ] **D-7 关闭前禁止开启任一 Sitemap flag**；当前 `listPublishableLocales()=[]`，提前开启只会生成确定性失败任务。
- [ ] D-7 关闭且正式 locale 进入白名单后，先以 flags 全关完成正式 locale 直接读盘 dry-run。
- [ ] dry-run、真实 `SITE_URL` 与静态目录权限均验证后，可先开 enqueue flag，但此时 Worker allowlist 必须仍排除 `sitemap_refresh`，任务只允许保持 pending。
- [ ] 单独审批 Worker write flag 后，在同一次部署中设置 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=true` 并把 `sitemap_refresh` 加入 Worker allowlist，避免 write gate 关闭期间任务被消费为 failed。
- [ ] 任一 flag 关闭时不得发生静态 release 生成或 current symlink 切换。

## 发布门禁接线

- [ ] 当前生产调用点：`src/server/publish-gate/service.ts:361`。
- [ ] D/E 合入时由整合方在该调用点统一补 dispatcher handlers；P2-10 不修改 Stream A 文件，也不绕过 dispatcher 直接 enqueue。
