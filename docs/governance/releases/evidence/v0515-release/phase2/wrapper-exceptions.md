# 本次包装器异常与恢复

- pull-deploy 在原发布仍运行时尝试读取完成文件，远端子命令 exit=1。首次日志和退出码保留；等待原 RELEASE=PASS / EXIT=0 后，pull-deploy-complete 成功取得四份原始文件。未重跑部署或更改门禁。
- post-extra 首次错误地把 worker-light 的宿主 env 变量名 WORKER_LIGHT_TASK_ALLOWLIST 当作容器 env 名。原 docker-compose.yml:446 映射为 WORKER_TASK_ALLOWLIST；按原配置修正读取，post-extra-corrected exit=0。首次日志/退出码与修正前后包装器均保存，未修改 env/Compose。
- 本地提取 post-db 数值的一次即席 Python 命令多写一个右括号（SyntaxError: unmatched ')'），未执行读取或写入；去掉括号后成功读出 16.301ms / 69.369237s。工具原始输出保留在会话，异常在此登记。
- 辅助进程查询中远端 rg 不可用（exit=127），改用 grep 完成只读查询；本地两个猜测的文件路径不存在，随后读取原 .yml 和真实路径。均非仓库门禁失败。

所有仓库原门禁通过；无门禁覆盖、SQL 写入、回滚、重试部署或业务开关变更。
