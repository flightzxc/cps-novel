# 后台登录 Cloudflare Turnstile：启用与回退说明（B-39，2026-10-07）

范围：海阅后台 `https://zbcwf.pulsenovels.com/login`（预生产阶段为 `https://zbcwf.bangbangji.cloud/login`）的登录页。
**默认关闭**：本功能随版本发出后，在你按本文第 2–4 节配好密钥并打开开关之前，登录行为与之前逐字节一致，不会把任何管理员锁在门外。

## 0. 一页纸摘要

| 项 | 内容 |
| --- | --- |
| 现有防护（不变） | nginx Basic Auth → nginx 登录页每 IP 每秒 2 次 → 应用层同用户名/IP 失败 5 次锁 15 分钟 → 强制两步验证 |
| 新增 | 密码校验**之前**多一道 Turnstile 人机验证（服务端向 Cloudflare `siteverify` 核验，并要求令牌签发给后台主机） |
| 需要你准备 | Cloudflare 里为后台主机建一个 Turnstile Widget，拿到 **Site Key（公开）** 与 **Secret Key（保密）** |
| 需要放的东西 | Site Key → `preprod.env` 的 `ADMIN_LOGIN_TURNSTILE_SITE_KEY`；Secret Key → 密钥**文件** `/opt/cps-novel/shared/secrets/admin_login_turnstile_secret_key`；开关 `ADMIN_LOGIN_TURNSTILE_ENABLED=true` |
| 生效方式 | 改 env → 重跑 preflight → 只重建 `web` 容器（不发新版、不迁移、不停数据库） |
| 回退 | 把开关改回 `false`（或删掉该行）→ 只重建 `web`；约 1 分钟，无需删除密钥文件 |
| 站点是否要走 Cloudflare 代理 | **不需要**。Turnstile 是独立的人机验证服务，只要求浏览器能访问 `challenges.cloudflare.com`，不要求域名解析到 Cloudflare、不需要改 DNS 或 nginx |

## 1. 它具体做什么（便于你判断影响面）

- 只影响后台登录页 `/login`。公开站、其它后台页面、`/api/health`、两步验证页面均不加载、不调用 Turnstile。
- 开关关闭：不渲染组件、**不加载 Cloudflare 脚本**、不调用 `siteverify`。
- 开关打开后，登录提交时服务端按顺序做：同源检查 → 锁定检查（已被锁的用户名/IP 直接拒绝，不再调用 Cloudflare）→ **Turnstile 校验** → 账号与密码校验 → 两步验证流程（完全不变）。
- 校验通过的条件是同时满足：Cloudflare 返回 `success: true`，并且返回的 `hostname` 等于 `ADMIN_CANONICAL_ORIGIN` 的主机名（预生产 `zbcwf.bangbangji.cloud`，正式 `zbcwf.pulsenovels.com`）。
- 任何一步出问题都拒绝登录（fail-closed）：密钥缺失、站点密钥格式错、令牌缺失、Cloudflare 拒绝、主机名不符、网络错误、5 秒超时、非 2xx、响应无法解析。
- **人机验证被拒不计入"失败 5 次锁定"**（与 CPS 一致）：它发生在密码校验之前、不携带凭据信息；若计入，没有令牌的机器人就能靠反复请求把真实管理员的用户名锁住。账号密码本身输错仍照旧计入。
- 令牌单次有效：每次登录失败后，页面自动换一个新的验证组件。
- 页面提示（中文）：`请先完成人机验证`（未完成就点登录，不发请求）／`人机验证未通过，请重新完成验证后再登录`／`人机验证服务暂时不可用，请稍后重试；若持续出现，请联系管理员检查配置`。

## 2. Owner 在 Cloudflare 申请 Turnstile

1. 登录 Cloudflare 控制台 → 左侧 **Turnstile** → **Add widget**（添加站点）。
2. 名称随意（例如 `pulsenovel-admin-login`）。
3. **Hostname / Domain** 只填**后台主机名**：
   - 预生产：`zbcwf.bangbangji.cloud`
   - 正式：`zbcwf.pulsenovels.com`
   - 可以同时填这两个（便于切换日不重配）；**不要**填公开站主机（`www.bangbangji.cloud` / `pulsenovels.com`）。
   - 服务端会再核对返回的 hostname 必须等于当前 `ADMIN_CANONICAL_ORIGIN` 的主机名，所以这里填的主机必须包含它。
4. Widget Mode 选 **Managed**（推荐）；Pre-clearance 选 No。
5. 创建后记下两个值：**Site Key**（公开，可以出现在页面里）和 **Secret Key**（保密，只在服务端使用）。
6. 不要把 Secret Key 发到聊天、工单、git、`preprod.env` 或任何截图里。

## 3. 放到目标机（预生产 VPS）

以下命令在目标机执行，沿用部署手册的固定身份假设（`deploy=1000:1000`，应用容器 UID `1001`）。

### 3.1 写入密钥文件（Secret Key）

```bash
# 交互输入，不回显、不进 shell 历史、不出现在进程参数里
sudo bash -c 'umask 077; read -rsp "Turnstile Secret Key: " k; echo; printf "%s\n" "$k" > /opt/cps-novel/shared/secrets/admin_login_turnstile_secret_key; unset k'
sudo chown 1000:1000 /opt/cps-novel/shared/secrets/admin_login_turnstile_secret_key
sudo chmod 0600 /opt/cps-novel/shared/secrets/admin_login_turnstile_secret_key
sudo setfacl -b /opt/cps-novel/shared/secrets/admin_login_turnstile_secret_key
sudo setfacl -m u:1001:r-- /opt/cps-novel/shared/secrets/admin_login_turnstile_secret_key
```

要求（`secrets-preflight.sh` 会在开关为 `true` 时逐条检查，缺一项 preflight 失败）：普通文件（不是符号链接）、非空、属主 `1000:1000`、模式 0600（加 ACL 后显示 0640）、ACL 只有 `user:1001:r--` 一条、应用 UID 能读、PostgreSQL UID（999）不能读。
文件内容必须是**单行**：容器启动时 `scripts/start-web.sh` 才检查这一点，多行/空文件不会让容器崩溃，而是在日志里打 WARN、后台登录一律被拒。
这个文件**不在**稳定身份清单里（Cloudflare 后台可随时轮换密钥），轮换时见第 6 节。

### 3.2 编辑 `/opt/cps-novel/shared/env/preprod.env`

```dotenv
ADMIN_LOGIN_TURNSTILE_ENABLED=true
ADMIN_LOGIN_TURNSTILE_SITE_KEY=<Cloudflare 里的 Site Key>
```

规则（preflight 强制）：
- 开关只接受 `true` / `false` / 不设置。`TRUE`、`1`、`yes` 会被 preflight 拒绝（运行时会把它们静默当成"关"，等于悄悄没开）。
- Site Key 必须匹配 `^[A-Za-z0-9_-]{8,128}$`。
- **不要**在这个文件里写 `ADMIN_LOGIN_TURNSTILE_SECRET_KEY` 或 `ADMIN_LOGIN_TURNSTILE_SECRET_KEY_FILE`：前者任何非空值都会被 preflight 拒绝，后者由 Compose 固定指向容器内 `/run/secrets/admin_login_turnstile_secret_key`。

## 4. 打开开关并生效

与其它开关（如领推广生命周期，见部署手册同名小节）相同：改 env，**只重建 web**，不是发新版；`CPS_NOVEL_APP_IMAGE`、`GIT_COMMIT` 不变，沿用你做 env-only 开关变更时用的同一个 shell 环境。

```bash
cd /opt/cps-novel/releases/<当前发布 commit>      # 当前生产的 checkout
source scripts/preproduction/lib.sh
scripts/preproduction/preflight.sh                # 须看到 PREPROD_ADMIN_LOGIN_TURNSTILE_CONFIG=PASS enabled=true 与 SECRET_PREFLIGHT=PASS
preprod_compose_app_up web                        # 只重建 web；postgres/worker/scheduler 不动
```

preflight 在开关为 `true` 时会：校验开关取值与 Site Key 格式、拒绝 env 文件里的明文密钥、检查上面的密钥文件。任何一项不满足都会直接失败，不会进到重建这一步。

## 5. 验证

1. **启动日志**（web 容器）：
   ```bash
   preprod_compose logs --tail 50 web | grep -i turnstile
   ```
   期望一行：`[auth] ADMIN_LOGIN_TURNSTILE_ENABLED=true — admin login requires Turnstile (hostname=zbcwf.…, site key and secret present)`。
   若是 `…but misconfigured (secret_missing|site_key_missing|site_key_invalid|admin_origin_invalid) — every admin login will be refused`，说明对应项没配好，登录会一律被拒，按提示补齐。
   （开关关闭时这一行**不会**出现，启动日志与以前相同。）
2. **密钥已挂入容器**（只看字节数，不输出内容）：
   ```bash
   preprod_compose exec -T web sh -c 'wc -c < /run/secrets/admin_login_turnstile_secret_key'
   ```
   期望是大于 0 的数字（0 表示挂到了 `/dev/null`，即开关没读到 `true`）。
3. **浏览器**：打开 `https://zbcwf.…/login`（先过 Basic Auth）。应看到"人机验证"组件；开发者工具 Network 里能看到 `challenges.cloudflare.com` 的请求。
   - 不点验证直接点"登录"：提示"请先完成人机验证"，且没有登录请求发出。
   - 完成验证后用管理员账号登录：照常进入两步验证页，流程不变。
   - 登录页响应头应仍有 `X-Frame-Options: DENY`（别人不能嵌入后台）；后台没有 CSP，所以不会拦截 Cloudflare 的 iframe。
4. **公开站不受影响**：`https://www.…/` 与 `/api/health` 的响应、页面源码里没有 `challenges.cloudflare.com`。
5. **失败路径**（可选，建议做一次）：用一个错误密码提交 → 提示的是"登录已失效，请重新登录"这类统一文案，且验证组件已自动刷新；连续输错 5 次才会触发 15 分钟锁定（人机验证本身失败不计数）。
6. 排障日志（web 容器）：被拒时只记一行 `[admin-login-turnstile] verification refused reason=<原因> codes=<Cloudflare 错误码>`，**不含**密钥、令牌或响应内容。

| reason | 含义 | 处理 |
| --- | --- | --- |
| `missing_token` | 请求里没有令牌（组件没加载、被广告拦截、或非浏览器客户端） | 正常拦截；管理员自己遇到时检查网络能否访问 `challenges.cloudflare.com` |
| `rejected` | Cloudflare 判定令牌无效/已用过/过期 | 重新完成验证再登录 |
| `hostname_mismatch` | 令牌不是签发给后台主机的 | Widget 的 Hostname 列表须包含 `ADMIN_CANONICAL_ORIGIN` 的主机；确认从后台域名访问 |
| `service_error` 且 `codes=invalid-input-secret` | 密钥文件内容不对 | 重写密钥文件（第 3.1 节），再重建 web |
| `service_error`（其它/无 codes） | Cloudflare 不可达、超时（5 秒）、非 2xx | 稍后重试；持续出现就按第 6 节回退 |

## 6. 出问题怎么关回去

**回退（约 1 分钟，登录立即恢复到 B-39 之前的样子）：**

```bash
# 编辑 /opt/cps-novel/shared/env/preprod.env：
#   ADMIN_LOGIN_TURNSTILE_ENABLED=false      （或整行删除）
cd /opt/cps-novel/releases/<当前发布 commit>
source scripts/preproduction/lib.sh
preprod_load_env && preprod_compose_app_up web
```

- 回退不需要先跑 preflight（关闭值恒通过），也**不需要**删除密钥文件或 Site Key；留着无副作用。
- 回退后：登录页不再有组件、不再加载 Cloudflare 脚本，Compose 把密钥挂载切回 `/dev/null`，`secrets-preflight.sh` 不再检查该文件。
- Basic Auth、nginx 限速、5 次锁定、两步验证全程不受这个开关影响；管理员被"挡在门外"时，关开关即可恢复。
- 如果是 web 容器起不来：这个功能不会让 web 崩溃（密钥读取失败只会让后台登录一律被拒并在日志里打 WARN）；起不来请另查，而不是先怀疑 Turnstile。

**轮换 Secret Key**：Cloudflare 后台重置密钥 → 按 3.1 覆盖写入同一文件（保持属主/模式/ACL）→ `preprod_compose_app_up web`。密钥只在容器启动时读取一次，所以覆盖文件后必须重启/重建 web 才生效。

**正式切换到 `pulsenovels.com`**：`ADMIN_CANONICAL_ORIGIN` 变为 `https://zbcwf.pulsenovels.com` 后，Widget 的 Hostname 列表必须包含 `zbcwf.pulsenovels.com`（第 2 节建议两个主机都填）；其它步骤不变，切换后按第 5 节再验证一遍。

## 7. 本地测试（只用 Cloudflare 官方公布的测试密钥）

| 用途 | Site Key | Secret Key |
| --- | --- | --- |
| 总是通过 | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| 总是失败 | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |

本地（`.env` 或 X8）设置 `ADMIN_LOGIN_TURNSTILE_ENABLED=true`、对应的 Site Key 与 `ADMIN_LOGIN_TURNSTILE_SECRET_KEY`（本地可直接放值；真实密钥**绝不**写进任何文件）。
注意：服务端会严格核对 Cloudflare 返回的 `hostname` 与 `ADMIN_CANONICAL_ORIGIN` 的主机名；测试密钥返回的 hostname 取决于 Cloudflare 沙箱，本地若因主机名不符被拒（日志 `reason=hostname_mismatch`），属于预期的严格行为，可按日志里的提示核对 `ADMIN_CANONICAL_ORIGIN`。仓库里的自动化测试全部用 `fetch` 桩，不访问 Cloudflare。

## 8. 与 CPS 实现的主要差异（供复核）

沿用：Turnstile 脚本显式渲染与生命周期、令牌单次使用后重置组件、校验先于密码、校验失败不计入锁定、错误提示的中文口径。
因海阅架构不同而改：开关默认关闭（CPS 以"有无密钥"决定，且无密钥时非生产放行）、运行时与 preflight 全程 fail-closed（CPS 在 `TURNSTILE_DISABLED=1` 或非生产时会放行）、校验落在 `authenticateAdminLogin` 的注入式 `verifyHuman` 而非 NextAuth `authorize`、站点密钥运行时读取（镜像构建时没有密钥）、服务端密钥走 `*_FILE` Docker secret（CPS 为环境变量）、新增 hostname 严格核对与 5 秒超时（CPS 两者都没有）。
