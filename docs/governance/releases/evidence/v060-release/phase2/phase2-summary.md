# v0.6.0 第二阶段原始结论摘要

RELEASE=PASS EXIT=0 host=haiyue-vps Final=493eb23b034b0410780228535b3e293e4ee91f9a
MAINTENANCE_ON=2026-10-14T07:50:17.442447+00:00
MAINTENANCE_OFF=2026-10-14T07:51:07.396574+00:00
MAINTENANCE_SECONDS=49.954127
NEW_MIGRATION_MS=2613.864

步骤0原文SQL读回：
```text
BEGIN
27|20261014120000_code_mode_upstream_code_guard
f|f|f|t|f|f|t|t
migration_owner|t|
```

各服务自部署起日志（原始总计数保留；postgres预期拒绝单独标识）：
| service | error raw | permission denied raw | expected probe | unexpected error | unexpected denial |
| --- | --- | --- | --- | --- | --- |
| web | 0 | 0 | 0 | 0 | 0 |
| worker | 0 | 0 | 0 | 0 | 0 |
| worker-light | 0 | 0 | 0 | 0 | 0 |
| scheduler | 0 | 0 | 0 | 0 | 0 |
| backup-timer | 0 | 0 | 0 | 0 | 0 |
| postgres | 1 | 1 | 1 | 0 | 0 |

GO_BEFORE status=302 location_sha256=cd3e05e05efaaf1b87106c931bc37d8852f5881773ac88cad333b7723acbb2e5
GO_AFTER status=302 location_sha256=cd3e05e05efaaf1b87106c931bc37d8852f5881773ac88cad333b7723acbb2e5
EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0
INDEXNOW_POST_STATUS=PASS breaker=false rateLimitWaiting=false dueUrls=0
EXTERNAL_ACCEPTANCE=PASS requests=5 proxy=http://127.0.0.1:7899
代码已部署，PlotNovel 尚未开通，前台行为不变。
