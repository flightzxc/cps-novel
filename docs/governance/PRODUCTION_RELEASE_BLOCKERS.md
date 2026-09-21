# Production Release Blockers

本表只记录阻断生产发布的事项。它不授权在开发、验收或金丝雀流程中顺手执行高风险
修复；每项必须按其关闭条件另行审批和验收。

| ID | 状态 | 范围 | 事项 | 本轮约束 | 关闭条件 |
|---|---|---|---|---|---|
| `SEC-CREDENTIAL-KEY-ROTATION-2026-09-01` | `OPEN` | Production release | 海阅本地凭证加密键曾出现在受限工具输出中；值未写入仓库或报告 | Promo Claim / Book B E2E 本轮禁止轮换、禁止直接替换 key file | Owner 单独批准轮换方案；方案必须覆盖现有密文重加密、双版本或原子切换、回滚、凭证解密验证、旧键撤销和发布审计。关闭前不得生产发布 |

## 范围限定备注

### `SEC-CREDENTIAL-KEY-ROTATION-2026-09-01` · 预生产控制面首次启动（2026-09-21）

该 blocker **保持 `OPEN`，关闭条件一字未改**。本备注只记录一次范围判断，不构成豁免。

判断：其 `范围` 一栏是 **Production release**。2026-09-21 这一轮在 `haiyue-vps` 上做的是
**受保护预生产环境的控制面首次启动**，不是生产发布，因此不落在该 blocker 的阻断范围内。

该判断成立的前提（任一条不成立则此备注失效，须重新评估）：

- 使用的是 **2026-09-21 当天新生成**的密钥材料
  （`channel_credential_encryption_key_v1`、`channel_credential_fingerprint_key`），
  与曾出现在受限工具输出中的本地材料不是同一份；
- **不导入任何既有密文**，不做就地重加密，不替换任何 key file；
- **不写入任何真实渠道凭据**；
- 全部渠道写闸保持关闭（`FEATURE_NOVEL_CATALOG_SYNC` / `FEATURE_PROMO_LINK_CLAIM` /
  `FEATURE_INDEXNOW_*` / `FEATURE_NOVEL_TAG_AUTO` / `ARTICLE_*_ALLOW_WRITE` 等，
  由 `scripts/preproduction/preflight.sh` 逐条断言）；
- 该环境**不对公网开放**：主机 nginx 以 Basic Auth 为主访问控制，并在所有状态码上
  返回 `X-Robots-Tag: noindex, nofollow, noarchive`。

正式生产发布前，该 blocker 仍须按其原有关闭条件单独审批与验收。
