# P2-06.5 · Changdu Source Taxonomy 四模型盲审交叉评审 · 最终报告

裁决对象：run `2026-08-15-changdu-real-b1-v2`，285 个 exact mapping key（`channel_app_id + exact raw-language scope + exact raw token`）。
裁决输入：四份互相独立的盲审结果（Reviewer A/B/C/D）+ 共同原始书证（source-token-evidence.jsonl 2,361 条、inventory、co-occurrence、locale 分布、CanonicalTag Candidate 119、LANE_B_REPORT）。
本轮未修改任何 A/B/C/D 原始输出、未修改 CanonicalTag artifact、未写库、未建生产 mapping、未联网。所有裁决均回到共同书证，多数票仅作为 agreement signal。

```text
CROSS_REVIEW_INPUT_QA=PASS
```

QA 明细：A/B/C/D unique mapping key 数均 =285；四方 key universe 与 inventory 完全一致（sha256 逐一匹配）；identity 字段（exact token / scope / book_frequency）四方零冲突；全部 MAP target 均存在于 119 artifact（stable_id 与 slug 逐一校验通过）；evidence.jsonl 覆盖全部 285 key；A 的结构性断言（每本书恰携带 2 个 token）在原始 JSONL 上复算成立（2,361/2,361）。CSV 行数差异（A=297、B=285、C=290、D=290）全部由 1:N edge 展开造成，已按 mapping_key 聚合后比较 edge set，未按行号 join。

## 总量结论

```text
TOTAL_MAPPING_KEYS=285

TIER_1_STRONG=104
TIER_2_GOOD=76
TIER_3_TARGET_CONFLICT=32
TIER_4_SPLIT=10
TIER_5_SOURCE_DIRTY=61
TIER_6_OWNER=2

AUTO_ACCEPTABLE_MAPS=147
AUTO_ACCEPTABLE_NEW_CANONICAL=41
AUTO_ACCEPTABLE_IGNORE_DROP=37
DEFER_SOURCE_DIRTY=49
OWNER_REVIEW_ITEMS=11
```

- 自动关闭 274/285（96.1%），覆盖 19,998 次 token-book 出现中的 93.3%。
- OWNER_REVIEW=11 个 key，折叠为 **10 行 Owner 决策**（见 OWNER_REVIEW_PACKAGE.csv），其中真正的产品决策只有 4 个：穿越重生 1:N、仙侠粒度、同人立项、EN Horror 回收方式；其余为安全/脏数据签署项。
- DEFER_SOURCE_DIRTY 49 key 仅占 3.0% 书目出现量——脏 token 高度集中在低频长尾，符合「先关高确定性、暴露真正危险项」的目标。

## A. 四模型总体一致性

**Decision agreement**：四家 decision 完全一致 152/285（53.3%）；3:1 = 93（32.6%）；2:2 或更碎 = 40（14.0%）。
**Decision+target agreement**：连 target/edge set 也完全一致 116/285（40.7%）。四家都判 MAP 的 107 个 key 里有 26 个 target 不同——**decision 共识明显高于 target 共识**，target 分歧集中在 facet 选择（modern-romance vs contemporary-setting、urban-hero vs urban-setting、marriage vs romance），这类分歧几乎全部可由「频道共现 + 书证」机械裁决，本轮 32 个 TIER_3 中 29 个已直接关闭。

各 reviewer 画像（原始 decision 分布 → 与最终裁决对齐率）：

| Reviewer | MAP | NEW | IGNORE | DROP | HR | 与最终裁决一致 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 162 | 48 | 32 | 3 | 40 | 245/285（86%） |
| B | 159 | 45 | 22 | 3 | 56 | 227/285（80%） |
| C | 176 | 52 | 23 | 6 | 28 | 204/285（72%） |
| D | 118 | 29 | 56 | 2 | 80 | 201/285（71%） |

- **A** 证据工作最扎实（唯一给出频道共现的结构性论证），对齐率最高；偏好 1:N（12 键展开），其中悬疑灵异族的 +suspense 副 edge 未被采纳。
- **B** 对 1:N 最保守（0 键展开，穿越重生的反对意见成为 P0 议题），且最敢做「反字面、按书证」映射（FR Xuanhuan→rebirth 7/7 书证成立）——这类映射证据常常最强，但因来源桶本身是错投产物，本轮多数未放行。
- **C** 覆盖率最高、最贴字面：贡献了最多可直接采纳的 MAP，但也产出了全部四家中最危险的几个字面映射（Adolescent→young-adult、幻想异能→superpowers、สยองขวัญ→horror，均被书证直接反证）。
- **D** 最保守（80 个 HR），对脏桶判断几乎全对，但一刀切成本高：对全部 Horror 键统一 0.47 HR，误伤了书证干净的日/俄/韩/阿/德 5 个 scope。

无任何 reviewer 身份加权；对齐率差异完全来自逐键书证复核的结果。

## B. 建议新增 CanonicalTag（交叉验证后进入 v1）

四家共提出 4+9+7+8=29 个 NEW 提案 slug，语义归一后为 **10 个概念**（详见 NEW_CANONICAL_CROSS_REVIEW.csv）。交叉验证后建议 **6 个进入 v1**：

1. **`male-audience` 男性向**（16 键 / 1,684 本，支持 3/4）。audience facet 已有 female-audience，缺男性向属结构性不对称。D 的「运营旗」异议记录在案：女频/男频必须同进同退。
2. **`lgbtq-romance` LGBT+**（8 键 / 162 本，支持 4/4——slug 四家各异，语义归一为同一 identity）。119 零覆盖；boys-love/BL/耽美/วาย 建 alias 不建第二个 ID；AR/KO 单本键与 Bahaghari 因书证反证未挂入。
3. **`supernatural` 灵异**（6 键 / 156 本，支持 4/4）。中文灵异怪谈品类，suspense（推理紧张感）与 fantasy（异世界体系）均不等价；RU Мистика 纯度不足未挂入。
4. **`horror` 恐怖**（6 键 / 18 本，概念支持 3/4；D 认可缺口但拒绝用脏桶新建——通过只挂书证干净的日/俄/韩/阿/德/葡 6 键化解）。EN(68)/ID(19) 半脏桶 DEFER 待 book 级过滤回收（P1/P2）。
5. **`historical-fiction` 历史（架空/权谋）**（3 键 / 53 本，支持 4/4，A/D 的 alt-history 与 B/C 的 historical-fiction 边界归一取宽）。历史军事(13本)书证 8/9 为穿越争霸，一并挂入，不给 military。
6. **`gaming-esports` 游戏竞技**（2 键 / 23 本，支持 4/4，slug 词序归一）。

另有 2 个概念按 MAP_TO_EXISTING 关闭：**isekai**（2 本，并入 fantasy，登记 alias/gap）、**快穿**（幻想異能[zh-Hant] 4/4 书证为快穿，并入 time-travel，登记 gap 待 NLP 补细标签）。

## C. 不应新增（或本轮不新增）的提案

- **xianxia 仙侠修真**：2:2 硬分裂 → P0 Owner 决策，不自动新增。若从简：并入 eastern-fantasy + alias 导流（B/C 方案）。
- **fanfiction 同人**：四家名义 4/4，但纯净硬书证仅 ~8 本 + IP 合规未定 → P1 Owner 决策，暂缓。
- **boys-love**（B 单独提出）：lgbtq-romance 子集 → ALIAS_ONLY，避免把同一结果页切碎。
- **isekai / quick-transmigration**：概念真实但证据量（2 本 / 4 本）不足以支撑 v1 正式入口 → 并入上位 + 登记 gap。
- **Omegaverse/ABO、兽人/星际兽世、年代文/种田、西式历史言情**：书证中反复出现但**从来不是稳定 source token**（A 的观察被 EN Xuanhuan、KO 판타지、宦海商戰等键书证交叉印证）——属于渠道 taxonomy 盲区，只能靠 NLP 从简介抽取，不在本轮立项。
- **用脏桶字面新建**：多语 Horror（法/印尼/泰/土/越）、History 家族、Xuanhuan 家族——字面概念即使有价值，这些 exact key 的书证也不支持挂载。

## D. 最高风险 mapping（本轮防住/压下的错分类）

1. **Adventure 家族 ×10 键（约 430 本）**：字面「冒险」，实为男频 fallback 桶（EN 键共现男频 200/235 + 图书 35，FR 55/55，RU 14/14；内容从情色合集到狼人复仇完全异质，还混入「测试邮箱」测试数据）。若按字面 MAP adventure，是本批最大规模的错分类。已按非内容桶 IGNORE 关闭（P2 签署项）。例外两键有真实语义：JA 冒険→adventure（唯一真冒险 scope）、zh-Hant Adeventure（拼写错误 token，10/10 男频战神/赘婿）→urban-hero。
2. **青少年标签装成人内容（282 本，分级安全）**：ES Adulto Joven(52)/PT Jovem Adulto(46) 为露骨情色已 DEFER；EN Young Adult(184) 四家一致 MAP 但书证偏熟，已标记分级复核（P2）。C 对 zh-Hant Adolescent 的 young-adult 字面映射被 3/3 成人豪门书证反证，未放行。
3. **Xuanhuan 罗马化家族 ×9 键（64 本）**：全部失真（替嫁总裁/二次机会言情/兽人 Omegaverse），同 scope 中文「玄幻奇幻」正常工作证明是错投。全部 DEFER，未让言情灌入东方玄幻页。
4. **History=故事 假朋友家族 ×7 键（113 本）**：法/西/俄/葡/印尼/菲 + EN 混装桶全部 DEFER；仅 VI History、KO 역사、JA 歴史、TH ประวัติศาสตร์、AR Histoire 书证真实古言，已 MAP。
5. **穿越重生整桶 1:N（651 本）**：3/4 主张双标，但逐书书证显示单本几乎只属其一，双标必然制造约半数假阳性——升级为 P0，未自动放行。
6. **跨 scope 同字符串语义分裂实证**（维持 raw-language scope 的直接证据）：`狼人`[zh-Hant]=豪门婚恋 vs 海外 Werewolf≈100% 命中；`都市`[JA]=女频现言 vs `都市`[zh]=男频爽文；`古代言情`[AR/IT]=黑帮/现言 vs [zh]=真古言；`Modern`[EN]=男频(40/40) vs 其余 Modern=女频现言。任何一处跨 scope 复制结论都会直接错分类。

## E. Owner 最小裁决包

285 键中 274 键已自动关闭；OWNER_REVIEW_PACKAGE.csv 共 10 行：

```text
P0 ×2  穿越重生 1:N（651本，本轮最大单点） / 仙侠 xianxia vs eastern-fantasy（55本）
P1 ×2  fanfiction 是否立项（~10本） / EN Horror 半脏桶回收方式（68本）
P2 ×5  YA 分级复核（282本） / Для взрослых 方向（6本） / History 家族签署 / Xuanhuan 家族签署 / Adventure 家族 IGNORE 签署
P3 ×1  低频证据不足长尾（意语26本、阿语46本两个 scope 扩样后重判）
```

每行均含「如果选 A 会发生什么 / 如果选 B 会发生什么」与建议方案；TIER_1/TIER_2 的 180 键未向 Owner 转嫁任何一项。

## 附：流程侧发现（不影响本轮裁决，建议跟进）

- CanonicalTag artifact 内疑似流程残留 3 行：`ct-v1-split:time-travel+rebirth`（拆分决策记录而非检索入口，本轮无任何 verdict 指向它）、`ct-v1-power-dynamics-review`、`ct-v1-mutual-first-experience-review`（-review 后缀）。建议 Owner 核对是否应从 119 中移除。
- 生产语料混入测试数据：《这是测试书籍》（JA 冒険桶）、《测试邮箱》（EN Adventure 桶）。
- 韩语/印尼 scope 存在大量 `원-PD166`/`En-PD168` 型占位书名，标题证据密度低（不影响 token 语义判定，已按共现+简介补证）。
- `Adeventure`（拼写错误）与 `げんかん`（疑似「玄幻」损坏转写）说明来源本地化标签表存在人工/机器录入错误；`げんかん` 的 mapping identity 不稳定，已 DEFER。
- 阿语 scope 下出现法语 token、意语/阿语 scope 下出现中文 token：包装错乱按书证独立判定，未当作语义证据。
- Lane B 报告 `TAXONOMY_DISCOVERY_NOT_SATURATED`：本轮结论对「已发现 token 的语义」有效，不保证低频 token 无遗漏；意语（26 本）/阿语（46 本）scope 建议扩样。

## 交付物清单

| 文件 | 内容 |
| --- | --- |
| CROSS_REVIEW_MATRIX.csv | 285 key 逐条四方对比 + 裁决（289 行，含 2 个 1:N verdict 的 4 条 edge 展开，parent_mapping_key 标注） |
| NEW_CANONICAL_CROSS_REVIEW.csv | 11 行语义归一后的新概念交叉验证（10 概念 + boys-love alias 裁决） |
| OWNER_REVIEW_PACKAGE.csv | 10 行 P0–P3 Owner 决策项（含通俗后果说明） |
| FINAL_CROSS_REVIEW_REPORT.md | 本报告 |
