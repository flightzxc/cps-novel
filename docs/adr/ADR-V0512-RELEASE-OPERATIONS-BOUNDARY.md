# ADR：v0.5.12 分类、网址与依赖处理边界

状态：Owner已裁定；2026-10-08～10-09。

- Owner 2026-10-08 决定分类标题加 Novels，覆盖 H1/title/分享标题/面包屑，有意偏离 CPS，推翻 09-30 的“不加 novels”；作品数显示可浏览总数，/browse 同步。
- 过短文章网址采用方案乙：仅新生成时补本地化词，正常网址逐字节不变，已有网址不改、不回填。追加两处短语分类名文案。
- 第三方验收：网址后缀 15 词全部 PASS；分类三条文案 45 条中 32 PASS、13 NEEDS_CHANGE。Owner 10-09 保留 en 三条（运营原始要求名字后加 Novels，贴近搜索词）；ru/th/ko/zh-Hant 十条照 GPT 修改。
- 240 本上限来自 08-18 P2-08 Cursor 实现；Claude 复核“登记、不阻断”，未写触发条件。B-38 根治排 v0.5.13，对齐 CPS 数据库分页并计算总数；本版只是可浏览计数一致，不声称全量目录统计。
- 主控 2026-10-09 裁定：全量 audit 的 vitest 3.2.7 / tinypool 1.1.1 **在镜像里但运行时不加载，与 v0.5.11 相同，B-40 在 v0.5.13 处理**。原“不进镜像”表述错误；此前停止记录保留，Final 与归档不重做。B-40 评估 runtime-only 依赖/迁移镜像及 vitest 升级。
- Next 16.3.8 修复清单（来源 f4e641b）：GHSA-cjq9-62q9-8jv4 high；GHSA-3w37-wq28-93x7、GHSA-4jqv-mc3x-m676、GHSA-f87g-xv8r-7p7x、GHSA-mcj8-r9mp-w47p moderate；GHSA-39w2-rjm5-chcv low。

发布执行只升版、门禁和部署；生产audit仍须0critical/指定五high。B-38/B-40不在v0.5.12增加功能。Owner/运营负责网址预览及生成、任务名目视；71本生成后只读核对不阻断收官。回滚兼容标志另批。实测证据见[发布记录](../governance/releases/v0.5.12-preproduction.md)。
