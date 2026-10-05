# ADR：第二段按 Owner 决定收尾，外部压测延后与 X8 排重豁免

状态：accepted；Owner 于 2026-10-05 在本会话明确提供补证与收尾指令。

## 背景

A/B/C 主机准备和本地完整 nginx 矩阵已通过。原计划仍缺 NAS 最近成功记录、续期后凭据 worker 校验、X8 排重与外部压测；本机外部 HTTPS 直连此前被重置。Owner 现提供 NAS 日志并在后台提交凭据校验，指定本轮只读核对后结束第二段。

## 决定

- NAS 拉取以 Owner 在 NAS 上取得的日志/目录输出为来源；Codex 只读比对 VPS 同名 dump 大小与 `.sha256`。区分 Owner 取得的 NAS 证据和 Codex 的 VPS 比对，不冒充 Codex 登录 NAS 或重算 NAS 文件散列。
- 凭据校验由 Owner 提交，Codex 仅核对任务 `9f1d906b-88a9-402d-81e1-e71577765e16`、`credential.validate.completed` 审计及当前凭据 `last_validated_at`，不新建校验任务或续期。
- X8 到期排重由 Owner 豁免，理由为凭据每周过期、旧令牌自然失效。本机排重证据保留；X8 标注 `WAIVED（Owner）`，不标记实测 PASS、不访问 X8。
- 外部压测推迟到确定对外开放日期之前再做；本段限流逻辑验收采用已取得的 `NGINX_MATRIX_ALL=PASS`，保留其临时运行器就绪包装偏离。外部性能验收为 `DEFERRED（Owner）`，不是压测 PASS；不增加负载请求或调整模板数值。
- 异地完整恢复演练继续暂缓，沿用 [恢复暂缓 ADR](ADR-CUTOVER-STAGE2-DEFER-OFFSITE-RESTORE.md)。异地副本完整可恢复性未经实测。
- 上述证据和决定提交、推送到 `ops/cutover-stage2-2026-10` 后，第二段准备收尾并停止，不合并、不进入切换当天。

## 后果与边界

本地矩阵验证限流与隔离逻辑，不提供线上吞吐、延迟分位或容量结论。NAS 拉取成功、大小/散列一致与归档目录可读不能代替完整恢复。本段保留先前缺失记录与失败历史，豁免/暂缓不改写为 PASS。

站点继续保持受 Basic Auth/noindex 保护的 rehearsal、新域名普通路径拒绝；站点地址、应用、数据库结构、IndexNow、领取批次与限流模板不改变。本次结束仅适用于第二段准备，不构成公开上线许可，不安排自动后续任务。

证据及只读核对结果见 [PUBLIC_CUTOVER_EVIDENCE.md](../operations/PUBLIC_CUTOVER_EVIDENCE.md) 末尾的 Owner 收尾记录。
