# P2-06.5 Lane C · 简介独立触发标签盲审结果（回收后）

对应样本包：`../2026-08-16-description-only-blind-review/`
评审：10 位独立评审并行盲审，每位 40 本，全程未见上游分类词。
本文件只汇报评审给出的分布与由此暴露的缺陷，**不设通过门槛、不冻结方案**，取舍由 Owner 决定。

## 一、回收完整性

| 检查 | 结果 |
| --- | --- |
| 判定条目数 | 653 / 653（无遗漏、无重复、无凭空多出） |
| 判定小说数 | 400 / 400 |
| 枚举与置信度合法性 | 全部通过 |

## 二、核心结论：三档精度

评审判定分布（判定单位＝「小说 × 提议标签」）：

| 口径 | 条目 | SUPPORTED | UNSUPPORTED | UNCERTAIN |
| --- | ---: | ---: | ---: | ---: |
| 整体（含风险追加层） | 653 | 323（49.5%） | 311（47.6%） | 19（2.9%） |
| 剔除 he/be 缺陷 | 515 | 321（62.3%） | 178（34.6%） | 16（3.1%） |
| he/be 缺陷单独 | 138 | 2（1.4%） | 133（96.4%） | 3（2.2%） |

**但整体那一行不能直接当作总体精度**——风险追加层是刻意的过采样，混进去会把数字压低。
去掉风险层、只用按比例分层的总体层，并按各语种在 4554 条候选边中的真实占比加权后：

| 口径 | 无偏估计（SUPPORTED 占比） |
| --- | ---: |
| **总体层，全部标签** | **51.4%** |
| **总体层，剔除 he/be** | **64.7%** |

（未加权的总体层为 51.9% 与 64.7%，与加权值几乎一致，
说明小语种保底配额没有实质扭曲估计。）

**读法**：现状产物里，简介独立触发的标签大约**一半**经得起"用户点这个标签找书"的检验；
把已备案的 he/be 缺陷剔除后升到约**三分之二**，但仍有约三分之一是误报。

## 三、he/be 缺陷：人工判定已坐实

| 口径 | 数值 |
| --- | ---: |
| 该缺陷在总体候选池中的占比 | 963/4554 = 21.1% |
| 样本中该缺陷条目 | 138 |
| 判为 UNSUPPORTED | 133（96.4%） |
| 判为 SUPPORTED | 2（1.4%） |

盲审在完全不知情的前提下，把这批边判成了近乎全灭。仅有的 2 条 SUPPORTED 是巧合——
简介里恰好另有明写的圆满结局文本（如 "lived happily ever after"），与 `he` 这个命中无关。

这确认了缺陷备案的判断：**该缺陷不是精度问题，是关键词种子错误**，无需再用人工评审去验证。

## 四、盲审新发现的缺陷（本轮开工时未知）

这些是评审独立发现、此前没有记录的问题：

### 1. `ct-v1-horror` — 命中的是"恐惧"情绪词，不是恐怖题材

n=22，UNSUPPORTED 86.4%。
触发词：`공포`×8、`horror`×6、`horreur`×3、`恐怖`×2。
韩语 `공포`、法语 `horreur` 在原文里描述的是人物的恐惧情绪，英文 `horror` 多为比喻用法（"the real horror began"）。
故事本身是背叛复仇情感剧，不是恐怖小说。**与 he/be 同类，属种子语义错误。**

### 2. `ct-v1-family` — `family` 是泛化词

n=46，UNSUPPORTED 76.1%。
绝大多数命中来自 "family ties"、"the Parks family"（家族姓氏）这类用法，
指向的是家族恩怨背景而非"家庭生活"题材。

### 3. 跨语言同形词：`chef` / `luna`

- `chef`：德语意为**老板**（`ihr Chef` ＝ 她的上司），命中的是办公室恋情，与厨师无关。
- `luna`：西/葡语意为**月亮**（`cada luna llena` ＝ 每逢满月），也常是**普通人名**或"月亮女神"，
  而非狼人女首领 Luna 这一设定。`ct-v1-werewolf-luna` 在拉丁语系的 UNSUPPORTED 率达
  44.4%。

### 4. 身份职业类标签普遍是"一笔带过"

`ct-v1-doctor` UNSUPPORTED 83.3%——
医生几乎都是产检、告知病情的功能性配角，甚至出现在作者生平介绍里。
这正是风险抽样预设的 `ROLE_ONLY` / `INCIDENTAL_MENTION` 失效模式，已被证实。

## 五、误报归因分布（UNSUPPORTED 条目）

| 归因 | 条目 |
| --- | ---: |
| `GENERIC_KEYWORD` | 144 |
| `MULTIPLE_MEANING` | 56 |
| `INCIDENTAL_MENTION` | 44 |
| `SECONDARY_CHARACTER` | 24 |
| `PAST_OR_BACKSTORY` | 14 |
| `NEGATION_OR_CONTRAST` | 8 |
| `ROLE_ONLY` | 7 |
| `TRANSLATION_DRIFT` | 6 |
| `OTHER` | 5 |
| `SETTING_ONLY` | 3 |

`GENERIC_KEYWORD` 与 `MULTIPLE_MEANING` 合计 200 条，
占全部误报的 64.3%——
**主要矛盾是关键词词典质量，不是简介权重本身。**

## 六、语种差异（总体层）

| 语种 | 候选池条目 | 抽样 | SUPPORTED | 剔除 he/be 后抽样 | SUPPORTED |
| --- | ---: | ---: | ---: | ---: | ---: |
| 英语 | 1876 | 201 | 26.9% | 109 | 47.7% |
| 语种19（上游无名） | 837 | 89 | 75.3% | 89 | 75.3% |
| 语种20（上游无名） | 719 | 80 | 77.5% | 80 | 77.5% |
| 法语 | 338 | 40 | 77.5% | 40 | 77.5% |
| 西语 | 242 | 25 | 40.0% | 24 | 41.7% |
| 葡语 | 197 | 21 | 71.4% | 21 | 71.4% |
| 菲律宾语 | 119 | 9 | 22.2% | 5 | 40.0% |
| 印尼 | 81 | 7 | 71.4% | 6 | 83.3% |
| 日语 | 76 | 7 | 57.1% | 7 | 57.1% |
| 德语 | 32 | 3 | 33.3% | 3 | 33.3% |
| 土耳其语 | 13 | 3 | 33.3% | 1 | 100.0% |
| 韩语 | 12 | 2 | 0.0% | 2 | 0.0% |
| 意大利语 | 6 | 2 | 50.0% | 2 | 50.0% |
| 越南语 | 6 | 2 | 100.0% | 2 | 100.0% |

中日韩语种（语种19/20，即中文简繁）精度约 **75–78%**，明显高于英语。
英语剔除 he/be 后仍只有约 48%，说明**拉丁语系的关键词匹配质量系统性弱于中文**——
中文种子（穿越／重生／嫡女）多为题材专名，拉丁种子里混入了大量日常词。

## 七、抽样层对照（验证风险抽样有效）

| 层 | 条目 | SUPPORTED | UNSUPPORTED | UNCERTAIN |
| --- | ---: | ---: | ---: | ---: |
| 总体分层层 | 491 | 255（51.9%） | 221（45.0%） | 15（3.1%） |
| 风险追加层 | 162 | 68（42.0%） | 90（55.6%） | 4（2.5%） |

风险层精度显著低于总体层，说明风险单元的设计确实命中了高危形态，不是随机噪声。

## 八、整书质量评价

| 评价 | 本数 |
| --- | ---: |
| GOOD | 169（42.2%） |
| MIXED | 89（22.2%） |
| BAD | 135（33.8%） |
| UNCERTAIN | 7（1.8%） |

## 九、标签两极分化

**表现最好**（≥8 条边）：

| CanonicalTag | 条目 | SUPPORTED |
| --- | ---: | ---: |
| `ct-v1-time-travel` | 53 | 100.0% |
| `ct-v1-werewolf-alpha` | 11 | 100.0% |
| `ct-v1-rebirth` | 23 | 95.7% |
| `ct-v1-wealthy-ceo` | 24 | 91.7% |
| `ct-v1-romance` | 23 | 91.3% |
| `ct-v1-mafia` | 9 | 88.9% |
| `ct-v1-revenge` | 12 | 83.3% |
| `ct-v1-marriage` | 9 | 77.8% |
| `ct-v1-divorce` | 17 | 76.5% |
| `ct-v1-legitimate-daughter` | 11 | 72.7% |

**表现最差**（≥8 条边）：

| CanonicalTag | 条目 | UNSUPPORTED |
| --- | ---: | ---: |
| `ct-v1-happy-ending` | 93 | 96.8% |
| `ct-v1-tragic-ending` | 45 | 95.6% |
| `ct-v1-horror` | 22 | 86.4% |
| `ct-v1-doctor` | 12 | 83.3% |
| `ct-v1-family` | 46 | 76.1% |
| `ct-v1-chef` | 8 | 75.0% |
| `ct-v1-princess` | 10 | 60.0% |
| `ct-v1-crown-prince` | 10 | 50.0% |
| `ct-v1-werewolf-luna` | 18 | 44.4% |
| `ct-v1-emperor` | 10 | 40.0% |

这个分化是本轮最有价值的信号：**问题不是"简介权重该不该等于标题"这个全局参数，
而是特定标签的关键词种子质量。**`time-travel`、`werewolf-alpha`、`rebirth`、`wealthy-ceo`
这类题材专名接近满分；`happy-ending`、`tragic-ending`、`horror`、`family` 这类
被泛化词或情绪词污染的标签接近全灭。

## 十、状态

```text
DESCRIPTION_ONLY_BLIND_REVIEW_STATUS=REVIEW_RETURNED
REVIEWED_EDGES=653
REVIEWED_NOVELS=400
POPULATION_PRECISION_WEIGHTED=51.4%
POPULATION_PRECISION_WEIGHTED_EXCL_KNOWN_DEFECT=64.7%
KNOWN_DEFECT_PRECISION=1.4%
NEW_SEED_DEFECTS_FOUND=ct-v1-horror; ct-v1-family; chef(de); luna(es/pt)
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
RECOMMENDED_DESCRIPTION_WEIGHT=OWNER_REVIEW_REQUIRED
AUTO_WRITE_AUTHORIZED=NO
```

未修改任何 C1 产物、未改关键词、未重跑、未写库。
