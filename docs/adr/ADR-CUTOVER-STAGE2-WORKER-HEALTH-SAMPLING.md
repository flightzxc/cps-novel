# ADR：第二段 worker 健康采样与 nginx 回退边界

状态：accepted；Owner 于 2026-10-05 在本会话回传主控只读排查并明确授权。

## 背景

B 第四次完整发布及匿名验证通过，后台 worker health 返回上游 503，耗时 1.512 秒，nginx 限流 PASSED。Owner 回传主控结论：健康查询没有可用索引，冷读超过应用 1500ms 预算，产生 workerStatus=failed 的误报；随后容器、过期锁及连续 health 复验正常。第四次失败正文未由 Codex 保留，这项根因结论归属主控提供的证据，不改写此前独立调查的限制。

## 决定

- 本段 worker 验收改为预热一次，等待 10 秒，再取三次完整响应。三次中至少一次 HTTP 200、workerStatus=ok、expiredLocks=0，且预热及三次都没有 expiredLocks>0，才能通过。预热成功不充当采样成功。
- 合规的 workerStatus=failed/503 可由这组采样判定；三次全 failed，或任一次存在过期锁，则停止，不标记 B PASS、不进入 C，并保留已安装的 rehearsal，不因该 worker 检查恢复 nginx。
- 传输、认证、noindex、响应契约或其他站点验收异常继续按站点安装器备份恢复；本例外只覆盖 worker 探测状态，不放宽页面压测的 5xx 停止规则。
- 采样完整正文、HTTP 状态、耗时和响应头写入本轮受控目录；证据区分主控提供、Codex 实测及阻塞。新 B 开始时清除旧 B 完成标记，避免不完整的新轮次沿用旧 PASS。
- 查询部分索引由主控另派开发单，随 v0.5.8 发布。本段不改应用代码、数据库结构、模板或探测预算；其余第二段边界保持不变。

## 后果

采样通过说明本轮有健康结果且未观察到过期锁，不能证明冷缓存性能已修复；无索引查询及误报风险仍待 v0.5.8。worker 停止时 rehearsal 可以保留，但 B/C 不获通过，须由主控继续处理。

执行入口见 [命令单](../operations/PUBLIC_CUTOVER_STAGE2_OWNER_STEPS_2026-10-05.md)，结果见 [证据](../operations/PUBLIC_CUTOVER_EVIDENCE.md)。
