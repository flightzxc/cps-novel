# src/lib/app/

**Owner: Codex（独占写入）**

## 用途

应用级元数据：版本号、构建信息、运行时身份常量。

## 唯一真源

```
src/lib/app/app-version.ts
```

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-12（前后端契约联调和本地 Compose）** 落地——版本常量要与 Docker/compose 一起定，才能同时建立同步测试。

## 特别纪律

- 版本号必须在 `package.json` / `Dockerfile` / compose / `app-version.ts` 之间保持一致，并有锁定测试；
- 构建元数据（version / commit / builtAt）烘焙进镜像且**不可被 env 覆盖**——CPS 曾因 `.env` 残留旧版本号污染 `/api/health` 指纹而发生事故；
- `/api/health` 用烘焙值检测陈旧 env 污染；
- 镜像参数 fail-closed，不给 `latest` 兜底。
