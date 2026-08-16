# P2-06.5 Lane C · Owner Final 状态

本文件是 Lane C 的最终治理制品。`runs/2026-08-17-owner-final-c1-final/` 下的报告是
**生成器的机械产物**，其中的状态字串仍是校准期口径；以本文件为准。
之所以不回头改那份报告，是因为改动会破坏它刚刚验证过的逐字节可复现性。

## Owner Final 决定

1. **全部 Grade B locale suppression 已撤销**——`chef` 的 de/fr/es/pt 与 `luna` 的 es/it 均不再存在。
   依据：suppression safety 抽查 20 条被删边，8 条判为真阳性（**误删 40%**），
   locale 一刀切的代价不可接受。
2. **`werewolf-luna` CanonicalTag 保留**，但**裸词 `luna` 不再允许在 description 中独立触发**。
   title 行为不变，因为本轮没有 title precision 证据。
   未来仅允许经独立证据验证的明确 phrase seed；模糊场景交 Offline LLM。
3. **C1 全局参数冻结**：`titleWeight=30 / descriptionWeight=30 / threshold=30 / maxTextTags=3`。
4. `princess` / `crown-prince` / `student` **只登记观察项，未新增任何 suppression rule**。

## 覆盖率 before/after

| 指标 | v2 | v3 | FINAL |
| --- | ---: | ---: | ---: |
| text_hit | 0.3596 | 0.3061 | 0.3088 |
| description_only | 0.3034 | 0.2412 | 0.2435 |
| zero_hit | 0.6404 | 0.6939 | 0.6912 |
| description-only 边 | 4554 | 3218 | 3222 |

v3 → FINAL 集合闭合（(小说,标签) 对为单位）：

```text
3218 − 62 + 66 = 3222
移除：ct-v1-werewolf-luna 62
新增：ct-v1-chef 65（locale 规则撤销后恢复）
      其余为 cap 腾位
```

覆盖率相对 v2 的下降是预期结果：用更少但更可信的文本标签，替换高覆盖低精度。

## 可复现性

从 HEAD 重跑 FINAL，**11/11 产物哈希逐条命中**。
传 `--run-id 2026-08-17-owner-final-c1-final` 即自动套用冻结时间戳，无需手工传 `--generated-at`。

覆盖层版本注册表同时钉住 v1 与 v2，因此**已材料化的 v3 运行仍然可复现**。

## 状态

```text
LANE_C_STATUS=FINAL
TEXT_PARAMETER_STATUS=FROZEN
TITLE_WEIGHT=30
DESCRIPTION_WEIGHT=30
THRESHOLD=30
MAX_TEXT_TAGS=3
GRADE_B_LOCALE_RULES=REMOVED
WEREWOLF_LUNA_BARE_DESCRIPTION_KEYWORD=DISABLED
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE
AUTO_WRITE_AUTHORIZED=NO
C1_FINAL_RUN_ID=2026-08-17-owner-final-c1-final
C1_FINAL_SAMPLE_COUNT=10000
KEYWORD_ELIGIBILITY_VERSION=keyword-eligibility-v2
KEYWORD_ELIGIBILITY_SHA256=e796ba1ed79b344f790a70853d2e9773d6265e307615b2a60da28b90a6164854
FINAL_REPRODUCIBLE_FROM_HEAD=YES
FINAL_ARTIFACT_HASHES_MATCHED=11/11
C1_V2_TEXT_HIT_RATE=0.3596
C1_FINAL_TEXT_HIT_RATE=0.3088
C1_V2_DESCRIPTION_ONLY_RATE=0.3034
C1_FINAL_DESCRIPTION_ONLY_RATE=0.2435
```
