# ADR：v0.5.8 发版后的运营与演练边界

- 状态：Owner 已决定，2026-10-05 交接登记。
- 来源：Owner 本会话第二阶段授权；《交接提示词_Codex_v0.5.8发版_2026-10-05.md》的发版治理决定与进度。
- 范围：本次密码保护预生产发布之后的开放、备份恢复、凭据提醒和领取批次操作，不改应用功能或 Final 身份。

## 决定

1. 对外开放延期，待书籍同步、内容充实后再确定日期；期间保留 Basic Auth 和 noindex。新域名仍未开放，nginx 保持 rehearsal。
2. 异地完整恢复演练暂缓；故障时优先使用 VPS 本机备份按既有 runbook 回滚。现有逻辑备份的 restore-list 检查不等于完整恢复演练。
3. 不做凭据到期提醒，B-30 撤销；不创建提醒或自动化。
4. 领取批次继续暂停，恢复由 Owner 负责；本版没有第三阶段。
5. 代码回滚目标为 v0.5.7 Final bbb06253828d9fd338f0ece1749c2020d8ec4679。两个新增部分索引向后兼容，但 SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES 仍须 Owner 在回滚时明确批准；不 down、不删索引、不改 rehearsal。

## 已有进度与后续

上线第二段证书、rehearsal、worker_connections=4096 已完成；外部压测因本机网络无法直连，推迟到确定开放日期前，证据分支 ops/cutover-stage2-2026-10 @b4afb67。证书及外部压测进度来自交接，本轮不据此声明新的证书验收；本次只读确认 nginx 配置前后原字节、worker_connections 与域名路由保持原状。

NAS 已使用 GNU/BSD stat 跨平台及 LC_ALL=C 排序修复是来源交接说明，本轮未连接 NAS。暂停完整演练不取消既有备份，不修改 NAS 或备份入口。本 ADR 只登记已经作出的 Owner 决定，不创建新授权。
