
## F.2 首次发布补核通过（2026-10-11 03:33 JST）

Owner 随机选择 3 篇草稿正式发布符合本次验收要求，不要求固定为预先列出的文章。以正式库发布记录为准，这次实际样本是英、法、葡语各 1 篇，发布时间 2026-10-10 18:31:39.822–18:31:39.901Z（JST 10-11 03:31:39）；首次投递响应 18:32:05.366Z（JST 03:32:05.366）。

| 文章 / 语种 | Article ID | Outbox ID | 发布至 accepted 响应 |
| --- | --- | --- | --- |
| Tempting My Brother's Best Friend / en | `6fe88958-8609-4f1b-8bbd-2019502da5d1` | `f23bbae9-2676-4857-a23f-4000f0280a67` | 25.544秒 |
| La Revanche Parfumée de l'Ex-Femme Répudiée / fr | `af8acdca-924f-4aae-9619-447eb7369426` | `cca871de-7ce9-4c64-a126-40cc097adc3e` | 25.495秒 |
| Luz do Meu Destino (CASADA POR CONTRATO COM O VIÚVO) / pt-BR | `109bceaa-e8d0-4b99-b839-a41a277ef92b` | `0f855ba2-4a53-4118-abbb-5f9493b3f4b0` | 25.465秒 |

- **F.2=PASS**：三篇均 published，三条 outbox 均 accepted / source=admin.article.publish / event_type=article_first_publish / attempt_count=1 / HTTP200 / error=null；各自从正式发布到接受响应 25.544 / 25.495 / 25.465 秒，符合约 1～2 分钟要求，outbox accepted 状态更新时间为 18:32:05.370Z。
- 三条 URL 级 attempt（id=4/5/6）共用非空 `request_batch_id=3ef3e207-c94f-41d0-8b87-5b19a900c942`，每条 `batch_size=3`、attempt_state=completed/outcome=accepted；request_at/response_at 相同，因此本样本计数为 **urls=3 / httpRequests=1 / taskItems=1**。
- 对应 delivery task `9198b490-f115-47d7-abdf-c6090ef55b85` completed / total_count=1；唯一 taskItem `23be388a-1002-4b9f-b4c7-7cc5d70e7cd0` success，target_type=indexnow_batch，payload/result mode=batch，无旧单条 outboxId 载荷，result.requestBatchId 与上述请求一致，claimed=3 / HTTP200 / accepted。证实一条任务条目对应一次三 URL 请求。
- 只读 status：累计 accepted urls=6 / HTTP requests=4 / 成功 delivery taskItems=4（含旧版本 3/3/3）；HTTP200 urls5/requests3，HTTP202 urls1/requests1；scan taskItems success749。熔断关闭、无429等待、dueUrls=0、死信0、keyValidation=verified、无在途批次；最近10个 sweep 连续每分钟 enqueued。
- health 0.5.15 / Final `db623505539c3ca55f55b1270aab829b8db102d7` / metadata passed；生产 env SHA256 仍为 `823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603`。本次 PostgreSQL 事务明确 transaction_read_only=on；没有数据库写入、额外站点 HTTP 请求、开关修改、存量回填或 nginx 操作。外部站点验收累计仍 2/10。
- 早先 18:25Z 的首次查询尚无部署后发布记录、最近3篇为 draft；证据保留。实际正式发布发生在 18:31:39Z，之后只读补核通过；未把早先旧版本的3条 accepted 当成新样本。

**v0.5.15 已上线，批量首发不超过 100 篇的限制可以解除。** 本结论是交接验收限制的解除确认，没有修改任何业务开关。存量回填仍需两次单独放行，本次未执行。

原始只读 SQL、stdout/stderr/退出码和验证包装器见 [F.2 证据目录](evidence/v0515-release/f2/)；[f2-result.json](evidence/v0515-release/f2/f2-result.json)、[indexnow-status.json](evidence/v0515-release/f2/indexnow-status.json)、[f2-validation.log](evidence/v0515-release/f2/f2-validation.log) 记录逐篇时间和批次/条目的对应关系。更新同一条正式发版日志及台账，Final/tree/annotated tag/发布镜像保持原身份；本补核文档独立提交推送，Notion同步后回读收据补记。
