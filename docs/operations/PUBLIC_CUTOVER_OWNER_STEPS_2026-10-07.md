# 正式切换：Owner 的 sudo 输入步骤

仅在 `CUTOVER_PREPARE=PASS` 后执行。脚本在物理 v0.5.9 release 目录运行：备份 nginx、重验暂停门禁、开启维护、修改两个域名变量、preflight、安装 public nginx、核对哈希及严格就绪。成功后保持维护，Codex 接续同镜像发布与外部验收。

本机工具禁止操作 Codex 和 Terminal 窗口，无法代你把密码输入交给终端。请在你自己的终端运行：

```bash
ssh -t -o KexAlgorithms=curve25519-sha256 haiyue-vps 'bash /opt/cps-novel/shared/cutover-public-20261007/owner-edge.sh'
```

sudo 提示出现时，只在该终端输入密码，不在聊天发送。所有 sudo 命令在同一 SSH 会话内执行。

脚本 SHA-256：`eadb22475550831d40e092fcf5c9f1372fc26c5e493180111b02d80888fab28b`。

成功输出 `CUTOVER_EDGE=PASS ... maintenance=ON`；失败输出保留真实错误，并按第 3 步要求恢复 nginx/env，维护保持开启。请回复“执行完成”或失败信息，勿发送任何秘密。

包装源：本地 `.tmp/public-cutover-2026-10/` 下 `owner-edge.sh`、`init.sh`、`checks.py`、`baseline.sql`（不提交包装或凭据）。本地/远端哈希已核对，11 个隔离检查场景和 Bash 语法通过。


原上传包装哈希（交互命令发布时已与服务器逐个比对）：

- `checks.py`：`1027607253e2cf8589f06d8373ef90e45073e9db0cd07d418296612f43e2a58d`
- `baseline.sql`：`c41a7dedddf73a5a923b78710692bd2cdb1028f370769923fb36ea7e5663685c`
- `init.sh`：`5e634d05335f9bfd9690cc78af8db7b36dcb728051a5639e1b0c1fde0f738773`
- `prepare.sh`：`9125e26091da2e2e488bbbff33677f676e6b3272fa7c1dd40a8be24e8fce38c8`
- `owner-edge.sh`：`eadb22475550831d40e092fcf5c9f1372fc26c5e493180111b02d80888fab28b`
