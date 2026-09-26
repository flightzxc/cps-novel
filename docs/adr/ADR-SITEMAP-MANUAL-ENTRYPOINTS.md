# ADR: Sitemap 手动入口只提交现有刷新任务

日期：2026-09-26。依据：Owner 本轮工单 4 和既有 Sitemap 刷新批准方案。

后台设置页与 CLI apply 都通过现有 enqueueSitemapRefresh 提交全局 scope，采用同一事务
审计和 request ID 重放。后台复用 settings:manage、同源校验及服务层会话重校验。
CLI 是受运维环境权限控制的带外入口，只接受 web_app 数据库角色，固定 system 审计身份。

CLI 不直接发布文件，也不启动第二个 worker。入队结果与生成结果明确区分；实际执行继续由
现有 worker 完成，保持 advisory lock、active scope、租约/围栏和文件锁/原子 release 发布路径。
处理中请求沿用现有的一次后续刷新标记。

Dry-run 只复用 sitemap family builder，在数据库 READ ONLY 事务里计算各语种 URL 数。
既不调用入队/审计，也不调用文件生成器。后台状态读只输出状态、时间和计数，不输出文件路径
或 worker 异常详情。无需新增环境变量、数据库结构或角色 grants。
