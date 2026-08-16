# P2-06.5 Lane C · 修复 C1 v3 可复现性（交付 Cursor）

> 单一任务，范围很窄。**不要顺手做别的。**
> `AUTO_WRITE_AUTHORIZED=NO` 保持不变。

仓库根：`/Users/chenweifeng/Documents/cps海阅/p2-06-main-merge`（分支 `main`）。
注意 `产品原型及文档/cps海阅` 下有同名目录，不是这个。

---

## 一、问题

`scripts/p2-06-5-lane-c/owner-final-c1.mjs` 目前是这样：

```js
async function loadLexiconOverride() {
  fail("C1 v3 lexicon override is excluded from the accepted Phase 1 baseline");
}
```

同时这三个文件仍处于**未跟踪**状态：

```
scripts/p2-06-5-lane-c/lexicon-eligibility.mjs
docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-16/keyword-eligibility-v1.json（含 .sha256）
tests/backend/p2-06-5-lane-c/lexicon-eligibility.test.ts
```

后果：

1. 拿 HEAD 的代码带 `--lexicon-override` 跑 v3 会**直接抛错退出**
2. `lexicon-eligibility.test.ts` 的 6 个用例失败（它们断言覆盖层行为，而代码拒绝加载覆盖层）
3. **authoritative C1 v3 产物的生成者不在版本控制内** —— 这违反 Lane C 全套哈希可复现纪律

## 二、你此前的判断与 Owner 决定不一致

那句 `excluded from the accepted Phase 1 baseline` 是一个**主动设计判断**：把 v3 覆盖层排除在已验收基线之外。

Owner 的决定是相反的，原话界限如下：

> 批准修复 v3 可复现性：提交 `lexicon-eligibility.mjs`、eligibility overlay、对应 tests，
> 并恢复 `owner-final-c1.mjs` 的真实 import。
> **提交这些文件只表示 authoritative v3 可从 HEAD 重现，不代表 B 级规则或 C1 参数已 Owner Frozen；
> B 级继续标 `LOW_EVIDENCE_LOCALE_RULE`。**

也就是说：「不冻结」≠「不入基线」。**产物必须可复现，参数依然不冻结。**这两件事互不冲突。

---

## 三、要做的事

1. **恢复真实 import**：`owner-final-c1.mjs` 重新从 `./lexicon-eligibility.mjs` 引入
   `loadLexiconOverride` / `normalizeSeed` / `overlayRuleKey`，删掉抛错桩与内联替身。
2. **把三个文件纳入版本控制**（外加 `scripts/p2-06-5-lane-c/c1-v3-compare.mjs`，若它是 v3 对比报告的生成者）。
3. **不要改动覆盖层内容**。`keyword-eligibility-v1` 的 sha256 必须仍是
   `781916c970dc81735080f425fb9441c4484daf92ee534c82e1e48c04d8d259e4`。
   B 级两条规则保持 `"grade": "B"` 与 `LOW_EVIDENCE_LOCALE_RULE` 标注不变。
4. **不要重跑 C1 v3 覆盖既有产物**。既有 v3 目录是权威产物，不可覆盖。

## 四、验收（这才是"可复现"的实证）

**文件提交了不算数。** 必须实证复现：

1. 用 HEAD 的代码，带同样的 `--lexicon-override`、同样的 `--run-id`、同样的 `--generated-at`，
   把 C1 v3 重跑到一个**临时目录**。
2. 把临时目录产出的每个产物 sha256，与既有
   `artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v3/scored/lane-c-run-manifest.json`
   里登记的值**逐条比对**。
3. 全部一致才算通过。有任何一条不一致，说明代码与产物已经漂移，必须查清原因再交付。
4. 跑完删掉临时目录，**不要留下第二份 v3**。

同时必须满足：

- `npm run test:backend` **全绿**（当前基线 46 文件；修复前有 6 个失败）
- `node scripts/p2-06-5-text-calibration.mjs verify-owner-final-c1 --tracked-output-dir docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v3` 返回 `ok: true`
- 两个冻结哈希不变：CanonicalTag `8bc8cdae…`、c1-input `046fe923…`
- 生产副作用扫描干净：无 `@prisma/client`、无 `fetch(`、无适配器引用

## 五、不要碰

- `scripts/p2-06-5-lane-c/description-only-blind-review.mjs` —— **有他人未提交的改动**，勿动勿覆盖
- `docs/p2/p2-06-5-lane-c/reviews/` 下的任何目录（四个评审包与结果均已定稿）
- `docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v3/` 的内容（状态块与清单已重钉并复验）
- CanonicalTag 产物、B2、生产库、Worker

不要新增 ADR，不要写实施方案，不要重开架构讨论。

## 六、交付时报告

```text
V3_REPRODUCIBLE_FROM_HEAD=            # YES / NO
ARTIFACT_HASHES_MATCHED=              # n/n
BACKEND_TESTS=                        # passed/total
TRACKED_MANIFEST_VERIFY=              # ok / failed
CANONICAL_SHA256_UNCHANGED=           # YES / NO
C1_INPUT_SHA256_UNCHANGED=            # YES / NO
OVERLAY_SHA256=781916c9...            # 必须不变
GRADE_B_STILL_LOW_EVIDENCE=           # YES / NO
AUTO_WRITE_AUTHORIZED=NO
```

做完即停。参数冻结仍待 Owner。
