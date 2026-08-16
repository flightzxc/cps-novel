# P2-06.5 Lane C · C1 v3 修复后独立盲审结果

评审：Fable5，6 个独立会话（5 片 survivor + 1 片 suppression），全程盲审，
与实施方（Cursor）无关。来源已核验：5 份判定文件的写入时刻均晚于本轮发起，
未混入前一轮产物。

本文件只汇报判定分布与由此产生的证据，**不设通过门槛、不冻结参数**。
`AUTO_WRITE_AUTHORIZED=NO`。

## 一、两条独立路径给出同一个数

| 口径 | 精度 | 性质 |
| --- | ---: | --- |
| 配对回溯（同一批已审判定，只改选择集） | **73.78%** | 因果：判定固定，仅规则改变选择 |
| 新抽 200 本独立盲审（总体层，按语种加权） | **73.0%** | 独立样本对 v3 现状的估计 |
| 同上，未加权对照 | 73.7% | — |

两条互不依赖的路径落在同一点（73.0% / 73.78%），这比任何单一数字都更可信。

**读法纪律**：51.9% → 73.78% 是**配对**结论（同一批人工判定，只是规则改变了哪些边入选），
可归因于修复。新 200 本是**独立样本**，用于估计 v3 当前水平与发现残余缺陷，
**不得**与旧样本相减写成「51.4% → 73.0% 的提升」。

## 二、v3 当前精度

| 层 | 边 | SUPPORTED | UNSUPPORTED | UNCERTAIN |
| --- | ---: | ---: | ---: | ---: |
| 整体（含风险层） | 294 | 214（72.8%） | 73（24.8%） | 7 |
| 总体分层层 | 209 | 154（73.7%） | 48（23.0%） | 7 |
| 风险追加层 | 85 | 60（70.6%） | 25（29.4%） | 0 |

整书质量：GOOD 128（64.0%）／MIXED 27（13.5%）／BAD 41（20.5%）／UNCERTAIN 4（2.0%）。
对照 v2 的 GOOD 42.2%／BAD 33.8%。

## 三、误报结构已经改变

| 归因 | v2（653 边） | v3（294 边） |
| --- | ---: | ---: |
| `GENERIC_KEYWORD` | 144 | **9** |
| `MULTIPLE_MEANING` | 56 | **16** |
| `INCIDENTAL_MENTION` | 44 | 14 |
| `SECONDARY_CHARACTER` | 24 | 12 |

泛化词误报被基本清除；**剩下的主要矛盾变成同形异义（`MULTIPLE_MEANING`）**，
这类问题无法用语种规则解决，需要短语级证据或上下文判断。

## 四、残余高误报标签（n≥6）

| CanonicalTag | 边 | UNSUPPORTED |
| --- | ---: | ---: |
| `ct-v1-princess` | 6 | 66.7% |
| `ct-v1-crown-prince` | 6 | 66.7% |
| `ct-v1-student` | 7 | 57.1% |
| `ct-v1-werewolf-luna` | 17 | 47.1% |
| `ct-v1-betrayal` | 11 | 36.4% |

高精度对照组保持良好：`wealthy-ceo` 94.1%、`romance` 85.7%、`revenge` 87.5%、`crime` 80.0%。

## 五、SUPPRESSION SAFETY：B 级规则删错了 40%

从 v2 抽取 20 条被 grade-B locale 规则删除的边，独立盲审：

| 标签 | 语种 | 边 | 误删（判为 SUPPORTED） |
| --- | --- | ---: | ---: |
| chef | 西语 | 3 | 2（67%） |
| chef | 法语 | 5 | 2（40%） |
| chef | 葡语 | 3 | 1（33%） |
| chef | 德语 | 1 | 0（0%） |
| werewolf-luna | 意大利语 | 2 | 2（100%） |
| werewolf-luna | 西语 | 6 | 1（17%） |
| **合计** | | **20** | **8（40%）** |

被误删的是一个真实存在的子类型——「糕点师重生复仇」，西/法/葡三语各有实例
（`chef confeiteira aclamada`、Meilleur Ouvrier de France 大赛、《El Postre Más Dulce》）。
意大利语两条 luna 均为完整狼人设定（Branco 狼群、Alpha、Compagna Destinata）。

**结论：locale 不是正确的判据。** `chef` 是厨师还是老板、`luna` 是月亮还是狼人女首领，
取决于句子而非语言；西/法/葡三语同时存在两种用法，一刀切必然连坐。

### 与 survivor 侧交叉验证

`werewolf-luna` 在 survivor 侧仍有 47.1% 误报，在 suppression 侧又有 38% 误删——
**该关键词在两个方向同时失败**，说明裸词 `luna` 无论怎么按语种切都不成立，
需要短语级种子（如显式的 Luna 角色表述），或退出 description 证据。

## 六、一致性对照：实施方 vs 独立评审

前一轮由实施方写入的两片判定被保留下来，可与本轮独立评审逐边比对：

| 项 | 值 |
| --- | ---: |
| 可比边 | 129 |
| 一致 | 113（87.6%） |
| 实施方 SUPPORTED 率 | 65.1% |
| 独立评审 SUPPORTED 率 | 75.2% |
| 差 | **−10.1pp** |

16 条分歧中有 13 条是「实施方判 UNSUPPORTED → 独立评审判 SUPPORTED」。

**即实施方对自己的成果评分更严，而非更宽。** 隔离实施方与评审方在流程上仍然正确，
但本例中若混入其成果，偏差方向是**偏悲观**，不是自我美化。

## 七、给 Owner 的待决事项

1. **B 级 locale 规则**：证据显示 `chef` 四语种与 `luna@意大利语` 代价高于收益
   （买约 1.1pp 精度，误删 40%）。`luna@西语` 误删 17% 相对最轻。
   全部仍标 `LOW_EVIDENCE_LOCALE_RULE`，未冻结。
2. **`werewolf-luna` 双向失败**，建议作为独立议题处理，不要并入 locale 规则的取舍。
3. **`princess` / `crown-prince` / `student`** 是新暴露的高误报标签，样本量尚小（n=6~7），
   证据不足以立规则。
4. C1 参数仍为 `CALIBRATION_RECOMMENDATION_ONLY`。

## 八、状态

```text
POST_FIX_BLIND_REVIEW_STATUS=REVIEW_RETURNED
POST_FIX_REVIEWED_EDGES=294
POST_FIX_REVIEWED_NOVELS=200
V3_PRECISION_WEIGHTED=73.0%
V3_PRECISION_UNWEIGHTED=73.7%
PAIRED_RETROSPECTIVE_PRECISION=73.78%
SUPPRESSION_SAFETY_SAMPLE=20
SUPPRESSION_FALSE_REMOVAL_RATE=40%
INTER_RATER_AGREEMENT=87.6%
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE
AUTO_WRITE_AUTHORIZED=NO
OWNER_NEXT_DECISION=GRADE_B_LOCALE_RULE_DISPOSITION_AND_C1_PARAMETER_FREEZE
```
