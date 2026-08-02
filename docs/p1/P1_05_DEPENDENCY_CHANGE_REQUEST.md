# P1-05A Dependency Change Request

**Owner of package files：Claude**

**Requester：Codex**

**Status：REQUESTED_NOT_APPLIED**

## 精确依赖

| package | section | exact version | purpose |
| --- | --- | --- | --- |
| `@prisma/client` | `dependencies` | `6.19.2` | PostgreSQL 类型安全客户端 |
| `prisma` | `devDependencies` | `6.19.2` | Schema format/validate、Migration CLI |

建议由 Claude 使用 `--save-exact` 合并，不使用 `^` 或临时未锁版本：

```text
npm install --save-exact @prisma/client@6.19.2
npm install --save-dev --save-exact prisma@6.19.2
```

## 选择依据

- CPS 固定参考工作区已安装并锁定 Prisma `6.19.2`；本轮使用该 CLI 对新 Schema 做了不连接数据库的只读 validation。
- 与当前 Node `>=20.9.0` 工程基线兼容，不要求修改 tsconfig、Next 配置或运行时模块格式。
- P1-05A 不需要 `pg`、`@prisma/adapter-pg` 或其他数据库依赖；若后续改变 Prisma engine 策略，必须另提依赖请求。

## 边界

- Codex 本轮未修改 `package.json` 或 `package-lock.json`。
- 依赖合并后只允许先运行 `prisma validate`；没有 Claude Schema PASS 仍不得生成 Migration。
