# ADR: 预生产开放文章生成任务与 sitemap 自动刷新配置

Status: Owner 已批准（2026-09-26，日本时间）

## 背景

v0.4.3 已发布到预生产，但 worker 白名单尚未包含文章生成任务或 `sitemap_refresh`，且 sitemap 的功能开关与静态文件写入许可均为 `false`。单篇创建由 web 同步完成；批量创建和首次发布后的 sitemap 刷新依赖 worker。正式领取批次 `eba8f359-a569-43d7-bb55-b71fecc02f6e` 正暂停，其更早创建的约 6.5 万条领取条目会按 `created_at, id` 排在新任务之前；文章任务六小时后过期。

## Owner 裁决

1. 在 `haiyue-vps` 的预生产 worker 白名单追加 `article.generate.v1`、`article.generate.batch.v1`、`article.generate.batch.v2` 和 `sitemap_refresh`，保留原有项及顺序。
2. 选择方案 (a)：本轮只在目标机 env 开启 `FEATURE_SITEMAP_AUTO_REFRESH` 与 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE`，并在本 ADR 与版本台账记录；将 sitemap 写闸纳入写闸登记封闭枚举排进 v0.4.4。该闸只写静态文件卷，不写业务库，也不调用外部接口。这是 Owner 对现行登记 ADR 中新增写闸需先改代码规则的本次明确例外。
3. 允许在预生产发布测试文章；发布同时会将对应书目置为已发布。预生产外层基本认证和全站 `noindex` 继续保护公开页面。文章的发布、保留和下线均由 Owner 在后台决定并操作，执行配置变更者不代办。
4. 批量首测只显式勾选不超过 10 本，禁止选择“全部筛选结果”，以免一次展开约 1.4 万本并占满 worker 队列。
5. 仅限预生产，接受“开闸后首次真实生成 + 访问验收”替代发布清单要求的开闸前正式 dry-run；现版本没有命令行生成入口。
6. 后台手动刷新按钮、每日兜底刷新、命令行生成及 sitemap 写闸登记的代码补齐排进 v0.4.4，本轮不做。

## 实施与风险

- 本轮仅修改 `haiyue-vps` 的 `/opt/cps-novel/shared/env/preprod.env`，只重建 web 与 worker；不改代码、不发版、不重建 scheduler 或 postgres，也不操作领取批次及其任务状态。备份、SHA-256、三处 env diff、断言和容器前后身份记录见 v0.4.3 版本台账及本次交付。
- sitemap 开关必须先在 web 与 worker 生效，再由 Owner 首次发布测试文章；既有文章发布事件不会补发刷新。下线或撤回目前也不自动刷新，直到后续刷新机制补齐前，sitemap 可能暂时保留旧条目。
- 批量生成及首次发布后的 `sitemap_refresh` 必须在 Owner 恢复正式领取批次之前完成。恢复后，先进先出的旧领取条目可能让文章任务等到六小时有效期届满。
- 本轮开闸未纳入现行 preflight 的写闸登记枚举，因此靠 Owner 批准、主机 env 精确 diff、容器内生效值和首次真实生成验收留痕；v0.4.4 补上代码门禁与契约测试。

## 后续：v0.4.4

1. 后台提供手动刷新 sitemap 的按钮与状态反馈。
2. 在 scheduler 入队每日兜底刷新，由 worker 执行，以覆盖发布后的下线或撤回。
3. 提供命令行 sitemap 生成与正式 dry-run，恢复发布清单原有验收路径。
4. 将 sitemap 写闸加入预生产写闸登记封闭枚举，并同步 preflight、env 模板与契约测试。
