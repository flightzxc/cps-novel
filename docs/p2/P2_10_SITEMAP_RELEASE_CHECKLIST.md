# P2-10 Sitemap 上线单

## 部署环境

- [ ] Web 与执行 Sitemap 刷新的 Worker 均显式提供真实 `SITE_URL`。
- [ ] `SITE_URL` 是绝对 HTTP(S) origin，且不含凭证、path、query 或 fragment。
- [ ] 未使用 CPS 域名、localhost、fixture 域名或代码/镜像默认值。
- [ ] 在未设置 `SITE_URL` 时执行 `npm run build` 仍通过；该变量只在运行期请求或刷新任务中读取。
- [ ] 运行期缺失或非法 `SITE_URL` 时，robots/Sitemap 生成链路保持 fail-closed。

## 静态服务不变量

- [ ] `/sitemap.xml` 和 `/sitemap/[fileName]` 只读 `current` 静态 release；缺失返回 503，不查库、不动态生成。
      **运营 V2 更新（2026-09-30）**：release 存在但总索引没列出的分片（没有公开内容的语种、关闭的博客家族、
      超出实际分片数的序号）返回 **404**，不再是 503；503 只留给"还没有任何 release / 索引读不到"以及
      "索引列了却读不到文件"。旧 `site_categorypage_<语种>[_N].xml` 308 到同语种 `site_mainpage_<语种>.xml`
      （分类页已并入 mainpage；语种没有内容时 404）。
- [ ] 正式 locale HTTP dry-run 仅在 D-7 关闭后执行；fixture 验收只通过 generator 参数注入并直接读盘。

## PR2 开关门禁

- [ ] `FEATURE_SITEMAP_AUTO_REFRESH` 与 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` 均默认 `false`。
- [ ] **L10N P4 更新（2026-09-10）**：本条原文依据的 D-7"首发 locale 白名单"决策点与
      `listPublishableLocales()` 已随 P4 删除（`src/lib/locale/locale-canonical.ts`
      不再有白名单层；`docs/governance/port-registry.md` P4 §2.A）——`listPublishableLocales()=[]`
      这句技术描述已失实，请勿再照字面核对。现行两层模型下，`static-sitemap-generator.ts`
      的 `routeLocales` 默认即 `SITE_LOCALES`（15 个已注册语种，非空），分片是否有内容
      取决于该语种下是否存在真正公开可见的 Article（既有可见性谓词族），不取决于任何白名单。
      提前开启 flag 的风险因而变成"给尚无发布内容的语种生成空分片"而非"确定性失败任务"——
      是否已具备开启条件仍需 Owner 按当下真实发布数据重新判断，本条不代为拍板。
      **运营 V2 再更新（2026-09-30）**：上面"给尚无发布内容的语种生成空分片"的风险已消除——没有任何公开小说、
      （博客开启时）也没有公开博客文章的语种，总索引一个分片都不列（mainpage 也不列），直接访问 404。
      整站一个公开内容都没有时，刷新任务会因"没有任何公开 URL"失败并保留上一版 release（原有的防空发布保险丝）。
- [ ] 正式 locale 直接读盘 dry-run 先以 flags 全关完成。
- [ ] dry-run、真实 `SITE_URL` 与静态目录权限均验证后，可先开 enqueue flag，但此时 Worker allowlist 必须仍排除 `sitemap_refresh`，任务只允许保持 pending。
- [ ] 单独审批 Worker write flag 后，在同一次部署中设置 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=true` 并把 `sitemap_refresh` 加入 Worker allowlist，避免 write gate 关闭期间任务被消费为 failed。
- [ ] 任一 flag 关闭时不得发生静态 release 生成或 current symlink 切换。

## 发布门禁接线

- [ ] 当前生产调用点：`src/server/publish-gate/service.ts:361`。
- [ ] D/E 合入时由整合方在该调用点统一补 dispatcher handlers；P2-10 不修改 Stream A 文件，也不绕过 dispatcher 直接 enqueue。
