# Sitemap 手动刷新与 CLI

2026-09-26，工单 4。实现仍使用现有单 worker，不接每日调度。

## 后台

`/settings` 的 Sitemap 卡片需要 `settings:manage`。API `GET/POST /api/admin/sitemap`
在现有封闭注册表登记；POST 校验同源和请求 ID，服务层重新读取会话与权限。
填写原因后提交；显示“已入队”或“已合并”，不表示文件已生成。卡片每 10 秒读取状态，
显示在途任务、最近文件生成结果及当前已发布 release 的 URL 数量。生成失败时旧 release
仍可服务，所以“失败”与旧收录数可以同时出现。

`FEATURE_SITEMAP_AUTO_REFRESH=true` 和 `SITEMAP_AUTO_REFRESH_ALLOW_WRITE=true`
必须同时成立；否则不建任务、不写审计。开闸仍须遵守既有主机批准登记和发布流程。
本工单不变更主机开关。运行 worker 的既有白名单必须包含 `sitemap_refresh`，否则任务等待。

同一全局 scope 的并发点击共用 PostgreSQL 事务 advisory lock 和现有在途任务约束。
每个新请求写一条 `sitemap.refresh.request` 审计；同一 request ID 重放不重复审计。
审计和入队处于同一事务，审计失败会回滚任务。处理中收到新请求时，沿用既有
`followUpRequested` 机制：当前任务结束后最多追加一个刷新，确保请求之后的文章也被纳入。

## 命令行

使用已部署应用镜像的 **web 容器**（镜像已提供 `tsx@4.21.0`），在 `/app` 执行。
继承 web 的 `DATABASE_URL`（必须是 `web_app`）、`SITE_URL` 和当前功能开关。
不要使用 migration_owner、超级用户或 worker 凭据运行 apply；CLI 显式拒绝非 web_app。
既有 compose 的 web 服务已配置对应数据库 URL，无需复制或输出凭据。
本说明不授权执行远端操作。

```bash
# 默认也是 dry-run：只返回各语种全部 sitemap 家族的 URL 数及总数
# 不含 sitemap 索引自身，不等于小说篇数。
tsx scripts/generate-static-sitemaps.ts --dry-run

# 提交生成请求；可用同一 request ID 安全重试同一次请求。
tsx scripts/generate-static-sitemaps.ts --apply --reason '人工核对后刷新' --request-id sitemap-manual-20260926-01
```

Dry-run 在 PostgreSQL `READ ONLY` 事务中调用现有候选/可见性/分片计算，超时上限 120 秒。
不创建任务或审计，不创建目录、锁、状态文件或 XML，不改变 current release。
它使用实时数据生成一份统计快照，不承诺稍后 worker 看到相同数据。

Apply **只入队，不等待完成**，JSON `status` 是 `queued`、`coalesced` 或 `disabled`；
前两者包含 taskId，绝不报告“生成成功”。退出码 0 表示成功计算/提交，2 表示写闸关闭，
1 表示参数、角色或执行错误。新的一次刷新应使用新 request ID；复用已完成请求的 ID
仍返回原 taskId。CLI 审计 actor 为 `system / sitemap-cli`。

文件生成仅由现有 worker handler 执行；复用任务领取、租约/围栏、文件生成锁及 release
原子切换机制。CLI 没有直接文件发布分支，因此不会绕开 worker 的互斥策略。领取工作繁忙时
sitemap 可能等待，勿另开一个 worker 或直接调用生成器。通过后台卡片/任务中心查看结束状态。

## 本地验收

```bash
bash scripts/run-sitemap-refresh-postgres-verification.sh
npx vitest run tests/backend/sitemap-admin tests/backend/tasks/sitemap-refresh.test.ts tests/backend/seo tests/ui/admin-sitemap-card.test.tsx tests/ui/admin-settings.test.tsx
npm run typecheck
```

数据库脚本每次新建私有 PostgreSQL 16.14 容器和数据库，运行真实 web_app/worker_app
用例，退出即删除容器；不接已有业务库。未增加表、字段或 grants；该脚本也验证字典 drift。
