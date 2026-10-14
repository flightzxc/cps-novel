包装器JSON与JSONL解析检查通过；本机/go请求仅执行一次，未重试。生产docker exec不带-i、外层stdin为DEVNULL；只读SQL在容器内通过heredoc输入psql，并强制只读事务。失败stderr仅记录摘要，成功输出限定为计数、身份、配置一致性和任务ID。
甲4辅助样本/副作用意图基线读取初版按单行解析JSON，Postgres json_agg复合行输出跨行导致失败；10与10a失败stdout/退出码/错误摘要保留。10b修正为完整JSON解码，验证3样本/2638意图，10c正式预演PASS。没有重做备份、写回填数据或执行任何改挂；原预演门禁未改。
