# 版本台账

记录本项目对外可辨识的版本号变更和阶段里程碑。阶段完成不等于发布或部署。

## 同步纪律

版本号需在 `package.json`、`Dockerfile`、compose 配置之间保持同步一致。P1-12 已落地不可变
构建 metadata、Compose runtime 与 Health 身份一致性验证；正式远端 CI 和发布流程仍未配置，
不得把本地门禁结果登记为已发布。

## 台账

| version | task | description | local main / branch | status |
| --- | --- | --- | --- | --- |
| v0.1.0 | P1-04～P1-14 | P1 工程底座、Schema/运维、Worker/Scheduler、Auth/Credential、后台与公共 UI、阅读器、四容器/Health、最终测试和只读审计 | `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668` | **P1_LOCAL_COMPLETE；UNRELEASED；UNDEPLOYED** |
| v0.1.0 | P1-15 | P1 收口报告、风险债务登记与 P2 交接输入包 | `feature/v0.1.0-p1-15-closeout` | **WAITING_FOR_GPT_NOTION_AND_OWNER_GATE** |

## 远端同步状态

- P1 最终本地 `main`：`fb8cddbdf7c8ff6b566169eade4a89258e7db668`；
- 本轮只读观察的缓存 `origin/main`：`36c9ca6e8b39ec3041a845bb55d246412ac0ea79`；
- 本地 `main` 相对缓存 remote-tracking ref：ahead 52、behind 0；
- P1-15 未 fetch、未 push；远端服务器实时状态 `NOT_VERIFIED`；
- 未发布、未部署、未执行生产数据库操作。
