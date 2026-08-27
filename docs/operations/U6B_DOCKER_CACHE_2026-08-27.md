# U6b 合入与 Docker 构建缓存清理回执 · 2026-08-27

## 结论

**U6b 已合入本地 main，回归通过；获批的单次构建缓存清理完成，实收 5.727GB。**
未删除镜像、容器或卷。金丝雀候选仍未验收，本次未调用上游；仍待 Owner 提供新 token
文件的绝对路径及已手测 200 的确认。

## U6b 提交与检查

| 对象 | 提交 / 结果 |
|---|---|
| 固定 U6b | `ce3cadac653aabe68dabbf0b7b380e4b0b93204f`，父提交 `30842b1` |
| 合入前 main | `6ed0faf78f3b31cb24b79562745bebeb3fa700dc` |
| main merge / 本次测试基线 | `72a991edc1947865d3887ccd640b4b93dc61b347` |
| merge 父提交 | `6ed0faf` / `ce3cada`，`--no-ff`，无冲突 |
| U5 / U6 修复 / U6b 祖先检查 | `00867ce` / `4f76cdb` / `ce3cada` 均 PASS |
| 未移动的分支 | `fix/u6-backend-acceptance@4f76cdb`、`feature/canary-preflight@41538ba` |

差异共 6 个文件、27 insertions / 30 deletions：

- 5 个生产文件仅改注释：catalog-sync actions、locale-canonical、novel-hreflang、seo-utils、
  text-to-slug。分别解析为 TypeScript AST，再以 `removeComments: true` 打印，与 `30842b1`
  的打印结果完全一致，均无解析错误。
- `tests/ui/locale-canonical.test.ts` 只改一条测试标题；用该标题的精确替换可重建整个新文件，
  测试体、断言及数量逐字不变。它不是新增或删除测试。
- `locale-canonical.ts` 不再把 language=5 归因于 C2b。说明准确指向 X8 getlistpc 的
  `5 → unknown → 4` 样本，但没有成对 languageName；5 继续 unknown。没有读回已删除材料、
  新建探针或修改注册表。
- 清理 D-7 后的陈旧白名单注释，`PUBLISHABLE_LOCALES=["en"]` 与运行逻辑均未改变。

### 本次合并后实际运行

Node 20.20.2；Node project 通过 CLI 使用 15000ms 超时，UI 默认配置不变。

| 检查 | 实际结果 |
|---|---|
| TypeScript 去注释等价 / UI 标题精确替换 | 5 / 5 与 1 / 1 PASS |
| typecheck | PASS |
| lint | 0 error / 3 条既存 IndexNow unused-arg warning |
| 完整 Node Vitest | 123 files passed / 10 skipped；1137 tests passed / 0 failed / 95 skipped |
| 完整 UI Vitest | 85 files passed；1369 tests passed / 0 failed / 0 skipped |
| Vitest 合计 | 208 files passed / 10 skipped；2506 tests passed / 0 failed / 95 skipped |
| git diff --check / 祖先关系 | PASS |

95 条均为原有未启用的真实数据库套件，不计为 PostgreSQL 通过。依赖、schema、grants、
Vitest 配置未变；本次没有重复 npm ci、Prisma 或 build。原 U6 完整安装、构建和前后门禁
记录保留在 [U6 backend 验收回执](U6_BACKEND_ACCEPTANCE_2026-08-27.md)，不冒称此次新跑。

## 获批缓存清理

Owner 明确授权后，仅在 `desktop-linux` / Docker Desktop 执行一次：

```sh
docker builder prune -f
```

前后均执行真实 `docker system df`，原始输出如下。

### 清理前

```text
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          41        4         41.31GB   11.4GB (27%)
Containers      9         9         724.4kB   0B (0%)
Local Volumes   49        5         3.181GB   2.908GB (91%)
Build Cache     402       0         32.57GB   5.727GB
```

### 清理后

```text
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          41        4         41.31GB   11.4GB (27%)
Containers      9         9         724.4kB   0B (0%)
Local Volumes   49        5         3.181GB   2.908GB (91%)
Build Cache     368       0         26.84GB   0B
```

prune 命令返回成功，报告 `Total: 5.727GB`。本次清理前实测也是 5.727GB；此前 9.97GB
是另一时点的观察，不作为本次回收量。未因缓存仍显示 26.84GB 而扩大清理范围。

前后比较 `docker image ls` 的 40 条可见 ID/tag 引用、9 个容器 ID、49 个卷名，均逐项相同。
以下三个回滚镜像引用及 ID 全部保留：

- `cps-novel:0.1.0-62453d2`
- `cps-novel:0.1.0-7a519cc`
- `cps-novel:0.1.0-d37506c`

只读 `docker exec cps-novel-x8-local-postgres-1 df -h /var/lib/postgresql/data /` 显示
Docker 文件系统总量 55G、已用 47G、可用 5.7G、使用率 90%。这只证明清理后可用空间，
不代表金丝雀 PG 测试或新镜像构建已经通过。未重试这些步骤，未继续删除资源；后续若仍
空间不足即停下，交 Owner 在 Docker Desktop 设置扩大虚拟磁盘配额，不以删更多资源替代扩容。

## 安全边界与继续条件

- 未运行 `docker system prune`、带 `-a` 的清理或任何镜像 / 容器 / 卷删除命令；没有清理
  `.playwright-cli/` 或其他既存材料。其 untracked 状态保持原样，未读取或提交。
- token 交接按 Owner 同意的协议：仓库外 0600 文件，只提供绝对路径并确认手测 200；后续
  由 Codex 通过正式凭证 UI 导入、validation，使用结束销毁文件并作凭证扫描 / supersede。
  当前未收到文件路径，因此没有读取凭证、查找未知 secret 文件或执行 UI 导入。
- 本次没有重建 / 替换运行拓扑；X8 app 容器仍使用 `cps-novel:0.1.0-d37506c`。main 的 D-7
  代码状态不能冒充当前运行镜像或候选 evaluator 的结果。
- 未 push、打 tag、部署、发布内容、打开 claimPromo / Sitemap / IndexNow 或执行 catalog 扩页。
  新页仍未扫描，不能据此判断上游 promo 覆盖率。
- 本次日志与前后资源清单位于 `.tmp/u6b-acceptance/`；只记录测试、容量和资源身份，
  未读取真实上游 token。

后续继续原顺序：隔离 PG 回归 → 包含修复的镜像与单项真实 preview → X8 / 金丝雀合入
（保留 U5、U6、U6b）→ 最终 main 全量门禁 / 镜像 → 扩页与同书候选验收。默认 FIFO 不批量
消费，剩余 preview pending 不按不存在的 6h TTL 推定过期。
