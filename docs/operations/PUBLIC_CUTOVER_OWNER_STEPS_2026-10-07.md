# 正式切换：Owner 的 sudo 输入步骤

仅在 `CUTOVER_PREPARE=PASS` 后执行。脚本在物理 v0.5.9 release 目录运行：备份 nginx、重验暂停门禁、开启维护、修改两个域名变量、preflight、安装 public nginx、核对哈希及严格就绪。成功后保持维护，Codex 接续同镜像发布与外部验收。

本机工具禁止操作 Codex 和 Terminal 窗口，无法代你把密码输入交给终端。请在你自己的终端运行：

```bash
ssh -t -o KexAlgorithms=curve25519-sha256 haiyue-vps 'bash /opt/cps-novel/shared/cutover-public-20261007/owner-edge.sh'
```

sudo 提示出现时，只在该终端输入密码，不在聊天发送。所有 sudo 命令在同一 SSH 会话内执行。

当前重试脚本 SHA-256：`9384ed4a260c24b92b672f17cf3b0776c595ea639910bb6614ed6bfc4d42b531`。首次执行脚本的历史哈希见下方原上传记录。

成功输出 `CUTOVER_EDGE=PASS ... maintenance=ON`；失败输出保留真实错误，并按第 3 步要求恢复 nginx/env，维护保持开启。请回复“执行完成”或失败信息，勿发送任何秘密。

包装源：本地 `.tmp/public-cutover-2026-10/` 下 `owner-edge.sh`、`init.sh`、`checks.py`、`baseline.sql`（不提交包装或凭据）。修正版本地/远端哈希已核对，16 个隔离检查场景和 Bash 语法通过。


原上传包装哈希（交互命令发布时已与服务器逐个比对）：

- `checks.py`：`1027607253e2cf8589f06d8373ef90e45073e9db0cd07d418296612f43e2a58d`
- `baseline.sql`：`c41a7dedddf73a5a923b78710692bd2cdb1028f370769923fb36ea7e5663685c`
- `init.sh`：`5e634d05335f9bfd9690cc78af8db7b36dcb728051a5639e1b0c1fde0f738773`
- `prepare.sh`：`9125e26091da2e2e488bbbff33677f676e6b3272fa7c1dd40a8be24e8fce38c8`
- `owner-edge.sh`：`eadb22475550831d40e092fcf5c9f1372fc26c5e493180111b02d80888fab28b`

## 首次执行失败后的接续（15:22 JST）

首次 public 安装与哈希检查成功，严格 TLS 就绪检查返回 curl60；脚本已回退 nginx/env 并保持维护。当时要求先停止重试，执行只读诊断；Owner 已于 15:29 JST 完成以下诊断，结果见后续接续说明：

```bash
ssh -t -o KexAlgorithms=curve25519-sha256 haiyue-vps 'bash /opt/cps-novel/shared/cutover-public-20261007/tls-readonly-diagnostic.sh'
```

诊断脚本 SHA256：`2f3183c8f39ce232e645ed22ca7a84281c7985b2c01e7004679682b5258ab8fb`。仅显示公钥证书 SAN/有效期/指纹、指定窗口 nginx 控制日志、原配置及恢复前安全备份哈希；不读取私钥，不修改配置，不 reload，不发布应用。

## 只读诊断完成后的修正版重试（15:32 JST）

公开证书 SAN 覆盖三个正式域名，时间有效，备份哈希匹配。首次 TLS 失败根因仍未确证；修正版在安装前记录 nginx master/worker PID，安装后最多十轮等待旧 worker 全部退出、新 worker 出现，才开始原有严格 HTTPS 检查。master 改变或交接超时立即失败；curl60 仍立即失败，不使用 -k，不调整证书、DNS 或 renderer。

首次包装及日志保留。每次重试独立保存 attempts/<UTC>/ 下的 nginx 备份、域名 diff、preflight、安装日志、worker 交接及就绪响应；失败补取呈现的公开证书元数据。维护中重新执行原暂停 SQL、迁移和逐语种数据库核验，并要求与原基线一致；旧 sitemap 35 分片/118537 条来源明确标为维护前记录，不宣称重新 HTTP 读取成功。

远端修正版哈希：

- owner-edge.sh：`9384ed4a260c24b92b672f17cf3b0776c595ea639910bb6614ed6bfc4d42b531`
- checks.py：`154a81fe7095e0e820869e151db0fb4a2b295e9b84ac95abeec2c469acfc07e4`

重试命令：

```bash
ssh -t -o KexAlgorithms=curve25519-sha256 haiyue-vps 'bash /opt/cps-novel/shared/cutover-public-20261007/owner-edge.sh'
```

sudo 密码只输入自己的终端。成功应包含 NGINX_WORKER_TRANSITION=PASS、PUBLIC_READY=PASS 和 CUTOVER_EDGE=PASS；此时仍维护，Codex 再接续同镜像发布。失败按第 3 步恢复 nginx/env 并保持维护，回传真实错误。
