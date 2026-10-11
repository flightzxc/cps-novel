# 海阅后台 Turnstile 开闸尝试与回退记录（2026-10-11）

## 最终状态

**开启验收未通过，已立即回退，当前仍关闭。** Owner 明确授权仅追加生产 env 两行并重建 web；执行严格按“登录页源码必须含 Cloudflare 脚本，任何异常立即回退”的判据进行。preflight、启用日志、密钥挂载、health 和镜像身份通过；后台登录页原始 HTML 没有 `challenges.cloudflare.com`，因此于 2026-10-11 17:53:13 JST（08:53:13Z）停止验收并恢复 env，仅重建 web。未再次开闸。

- 前置核查开始：2026-10-11 17:52:54 JST（08:52:54Z）。
- 开启 web 重建开始：2026-10-11 17:53:03.918623 JST（08:53:03.918623Z）。
- 回退验证完成：2026-10-11 17:53:20 JST（08:53:20Z）；补充只读检查：17:54:39 JST（08:54:39Z）。
- 目标仅 `haiyue-vps`；版本始终 `0.5.15`，Final `db623505539c3ca55f55b1270aab829b8db102d7`，镜像 `cps-novel:0.5.15-db62350`。
- 没有发版、build/pull/retag 镜像、改代码/nginx/其它 env/白名单/业务开关、操作其它服务或手工写数据库。开闸与回退各重建一次 web；原密钥文件保留。
- Owner 浏览器“人机验证 → 密码 → 两步验证”未执行：在请求实际登录前已触发回退，不记为验收通过。

## 前置结果

| 核对项 | 结果 |
| --- | --- |
| health 与 current | healthy / 0.5.15 / 批准 Final；metadataConsistency 与 database 均 passed；current 指向批准发布目录 |
| 生产 env | SHA256 等于指定旧值，3862 字节 / 64 行，末尾有换行；零条 `ADMIN_LOGIN_TURNSTILE_` 行 |
| Secret 文件元数据 | 普通文件，1000:1000，640；基本 ACL user::rw- / group::--- / mask::r-- / other::---，额外仅 user:1001:r-- |
| Secret 受限计数 | wc -l=1，wc -c=36；`grep -c $'\r'` 输出0（退出1）；行尾空白匹配数0；未读取、打印或保存内容 |
| web 现状 | ADMIN_CANONICAL_ORIGIN=https://zbcwf.pulsenovels.com；ADMIN_LOGIN_TURNSTILE_ENABLED=false |
| 既有 manifest | `/opt/cps-novel/shared/artifacts/staging/v0515/db623505539c3ca55f55b1270aab829b8db102d7.json`；SHA256 `42df974741433fbf3e508fe1063edc33529855dbe90c95aacf05f73a4904faac` |
| 镜像 | IMAGE=PASS anchor=descriptor；RUNTIME_IMAGE=PASS services=web |
| 服务基线 | 六服务均 running / healthy，取得完整 CID、StartedAt 与镜像身份 |
| Basic Auth 配置 | 主机现成 `/opt/cps-novel/shared/secrets/preprod-curl.conf`，普通文件、600；未打印凭据 |

## env 变更、备份与 preflight

生产文件 `/opt/cps-novel/shared/env/preprod.env`。保留权限备份：`/opt/cps-novel/shared/env/preprod.env.bak-admin-turnstile-20261011T085254Z`；备份模式600，修改前真实 cmp 与旧 SHA 核对 PASS。

```diff
--- preprod.env.backup
+++ preprod.env
@@ -64,0 +65,2 @@
+ADMIN_LOGIN_TURNSTILE_ENABLED=true
+ADMIN_LOGIN_TURNSTILE_SITE_KEY=0x4AAAAAAFTqFgFn4w6AYhbb
```

- 修改前 SHA256：`823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603`。
- 临时开启后 SHA256：`53d5c5c48b7c679677f3d30d49f6f9f0a53da84ab843b8806512f516b4d95a50`。
- 回退后 SHA256：`823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603`，与初始值相同。
- 开启后3953字节 / 66行；对原3862字节前缀执行真实 cmp PASS；全量字节比较恰为原文加指定两行，尾部精确匹配、行数仅增加2。不写 Secret Key 或 `_FILE` 行。

在 `/opt/cps-novel/releases/db623505539c3ca55f55b1270aab829b8db102d7` source 原 `scripts/preproduction/lib.sh`，经 `preprod_read_release_manifest` 导出既有 GIT_COMMIT、CPS_NOVEL_APP_IMAGE 和 PREPROD_RELEASE_MANIFEST，再用 `preprod_load_env` 加载新配置，执行原 `scripts/preproduction/preflight.sh`，退出码0。关键原始输出：

```text
PREPROD_SITE_MODE=public
IMAGE=PASS anchor=descriptor
SECRET_PREFLIGHT=PASS CONSUMER_ACCESS=VERIFIED
PREPROD_ADMIN_LOGIN_TURNSTILE_CONFIG=PASS enabled=true siteKey=set secret=file:admin_login_turnstile_secret_key
PREPROD_PREFLIGHT=PASS
```

worker lanes、既有写闸登记、领推广及上游限速配置同样通过；完整输出见证据目录 `preflight.log`。未为通过 preflight 修改任何其它配置。

## web 重建、验证与失败原因

使用原 `preprod_compose_app_up web` 的固定 `--no-deps` 路径，未 build/pull；随后显式 `preprod_wait_for_service_health web` 与 `preprod_assert_container_image web` 全 PASS。默认 healthy 等待超时180秒。重建期间检查 Turnstile misconfigured，未发现该警告。

- 初始 web：`4a2547abb17ae53f735ccae1aa9bdd58c081d22c37a7663964c5286306dbcc4f`，StartedAt `2026-10-10T17:06:52.472212851Z`。
- 临时启用 web：`38a25d8ba8fa0a90a3a9f1798f1bc3ea8961b377de1a6918073b92689087f0b1`，StartedAt `2026-10-11T08:53:05.223356293Z`。
- 回退 web：`7c9eb03f514ac5b98886563e2d4a31e6a82410a29fe942a96e9427320f53d093`，StartedAt `2026-10-11T08:53:14.153586954Z`。
- 三者镜像引用均 `cps-novel:0.5.15-db62350`，镜像实体均 `sha256:b753a3b7c0a650d75db8167d925ffce3d835efc4e1c3d8b7cc7934345006e935`；manifest descriptor/config/platform/revision 核验保持 PASS。

启用 web 的原始启动标记：

```text
[auth] ADMIN_LOGIN_TURNSTILE_ENABLED=true — admin login requires Turnstile (hostname=zbcwf.pulsenovels.com, site key and secret present)
```

容器内 `wc -c < /run/secrets/admin_login_turnstile_secret_key` 为36；内部 health healthy，版本/Final/database/metadata 均正确。两次外部验证及一次回退验证均在主机执行，curl -q，禁用重试与跳转；后台使用既有 curl 配置。只保存 HTTP、长度、页面哈希、Cloudflare 匹配结果及 X-Frame-Options，无凭据、完整响应头或页面正文。

| 请求 | HTTP | Cloudflare 域名/脚本在原始HTML | X-Frame-Options | 结论 |
| --- | --- | --- | --- | --- |
| 公开首页，启用后 | 200 | 无 | DENY | PASS |
| 后台 /login，启用后，Basic Auth | 200 | 无 | DENY | 源码脚本条件FAIL，立即回退 |
| 后台 /login，回退后，Basic Auth | 200 | 无 | DENY | 回退验证PASS |

外部自动取样共 **3/4 次**；无自动重试、跟随跳转或再次开闸。Owner 浏览器请求独立计数，本次实际为0。

只读核对实际部署文件与本地同一组件的 SHA256 `dd801704ca18f15c8ddcf273bbec45d51f32766da90696a0dc855f1f52646009` 一致：`src/app/(admin-auth)/login/_components/turnstile-widget.tsx` 第68–75行通过 `document.createElement("script")`、设置 src 后 `document.head.appendChild(script)` 加载；第96–103行在 `useEffect` 中调用 loader。所以此脚本在浏览器挂载后加入 DOM，原始 HTML 的 curl 检查不执行这一逻辑。失败是本次原始源码验收条件与现有客户端加载方式不一致；本次未检验实际浏览器加载或 Cloudflare siteverify，不能据此断言密钥或 Cloudflare 验证失败。

已遵守硬性回退条件，不放宽判据或擅自重新启用。后续若继续，须 Owner 明确调整验收口径至浏览器 DOM/Network 与实际两步登录，再重验全部前置。

## 回退结果与方法

本次恢复完整备份，真实 cmp PASS，env 返回初始 SHA、64行、零 Turnstile 行。用全新 shell 加载 manifest/env，避免旧 shell 残留 enabled=true；仅再次 `preprod_compose_app_up web`，不运行 preflight、不删除密钥。healthy 等待与镜像核验 PASS；登录页200且无 Cloudflare 域名，DENY 保持。

回退 web 开关 false、来源正确、密钥容器挂载返回0字节（关闭时使用 /dev/null）；主机密钥保留。补充只读检查显示六服务 healthy，web 自回退 StartedAt 以来 **error=0 / permission denied=0 / verification refused=0 / misconfigured=0**。启用容器在源码条件失败后立即移除，未保存其最终完整日志计数；不冒充启用后的全部日志验收已完成。

以下五服务在开闸、回退与补充检查三个节点，ID 和启动时间均与前置相同：

| 服务 | 完整容器ID | StartedAt（UTC） | 前后结果 |
| --- | --- | --- | --- |
| backup-timer | `43bb77638c4a230eb856dc64aece6eeded02eb8ce92305fa4120c3e80da325da` | `2026-10-10T17:07:49.905880279Z` | 不变 |
| postgres | `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e` | `2026-09-27T15:28:01.610098036Z` | 不变 |
| scheduler | `c5779d521b4eec5b646a8642df524f1e6d84f5b7a39ed71ba24bc9d2f82d1cfd` | `2026-10-10T17:07:11.780118207Z` | 不变 |
| worker | `160a9ec0a8cff439074e5293d0abb1de2b02a4cfdffb14b16036a7d5a65141c0` | `2026-10-10T17:07:04.899569634Z` | 不变 |
| worker-light | `7709fc2894f2702f3a2b9d06d94905b1c11526dc21e0140209edbde2fff24716` | `2026-10-10T17:07:05.054978878Z` | 不变 |

未来回退可在确认 env 未漂移时恢复本次备份；存在并发漂移时，仅把本次 `ADMIN_LOGIN_TURNSTILE_ENABLED` 改为 false，保留其它行。重新加载 env 并只重建 web，不需要 preflight或删除密钥；显式等待 healthy、核对镜像和其它服务基线，登录页不再加载脚本。本次执行的是完整备份恢复。

## 证据与治理

原始脱敏执行输出、受限 diff、preflight、前后容器身份、取样账本及最终只读结果见 [证据目录](evidence/admin-turnstile-enable-2026-10-11/)。记录失败及回退，无 Secret Key、env全文、Basic Auth凭据或用户令牌。

本运维记录、版本台账 v0.5.15 补记与生成器 CHANGELOG 组成一个文档提交，带 `Agent: codex` / `Model: GPT-6`。生成器使用 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.abbrev GIT_CONFIG_VALUE_0=7`；治理提交不部署、不改变 Final 或 annotated tag，不追加发版级 development-log。推送、分支/tag回读及 Notion 独立失败/回退手账的同步回读在该文档提交后完成，收据保留 `.tmp/admin-turnstile-enable-20261011/`；不为自引用收据增加第二个文档提交。


## 第二次尝试（2026-10-11 18:25 JST）

### 当前结果与验收口径

**Owner实际登录成功，日志复核PASS，保持开启。** Owner再次明确授权相同的env-only开闸，并纠正第一次原始HTML脚本判据：现有客户端useEffect动态插入脚本，原始HTML没有Cloudflare域名属正常；这次检查条件渲染的“人机验证”标签、页面数据中公开Site Key与X-Frame-Options DENY。以上第一次尝试的记录和原始证据逐字保留，本节记录第二次独立操作。

### 前置结果与env变更

- 开始核查：2026-10-11 18:24:45 JST（09:24:45Z），current与health均为0.5.15 / Final db623505539c3ca55f55b1270aab829b8db102d7；metadata与database passed。
- env匹配第一次回退值，3862字节/64行、末尾换行，零条ADMIN_LOGIN_TURNSTILE_行；web后台来源正确、开关false；六服务healthy。
- 密钥仅做受限元数据/计数复核：普通文件、1000:1000、640，额外ACL仅user:1001:r--；1行/36字节、CR=0、行尾空白=0；未读取或打印内容。既有Basic Auth curl配置仅核文件元数据并用于一次后台取样，不打印凭据。
- 修改前旧SHA：`823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603`。
- 本次备份：`/opt/cps-novel/shared/env/preprod.env.bak-admin-turnstile-20261011T092446Z`；cp保留权限，600，备份真实cmp及SHA PASS。
- 本次仅追加以下两行，不写Secret Key或_FILE：

```diff
--- preprod.env.backup
+++ preprod.env
@@ -64,0 +65,2 @@
+ADMIN_LOGIN_TURNSTILE_ENABLED=true
+ADMIN_LOGIN_TURNSTILE_SITE_KEY=0x4AAAAAAFTqFgFn4w6AYhbb
```

- 修改后新SHA：`53d5c5c48b7c679677f3d30d49f6f9f0a53da84ab843b8806512f516b4d95a50`；3953字节/66行，原3862字节前缀真实cmp PASS，全量字节恰等于备份加上述两行，尾部匹配、行数仅增加2。其它env字节不变。

### preflight与仅web重建

在批准Final的发布目录source原lib.sh，读取原manifest `/opt/cps-novel/shared/artifacts/staging/v0515/db623505539c3ca55f55b1270aab829b8db102d7.json`，SHA仍为42df974741433fbf3e508fe1063edc33529855dbe90c95aacf05f73a4904faac；从manifest导出GIT_COMMIT/CPS_NOVEL_APP_IMAGE/PREPROD_RELEASE_MANIFEST，经preprod_load_env加载新配置，执行原preflight，退出0。

```text
IMAGE=PASS anchor=descriptor
SECRET_PREFLIGHT=PASS CONSUMER_ACCESS=VERIFIED
PREPROD_ADMIN_LOGIN_TURNSTILE_CONFIG=PASS enabled=true siteKey=set secret=file:admin_login_turnstile_secret_key
PREPROD_PREFLIGHT=PASS
```

写闸登记、worker lanes和原有配置全部PASS，没有为通过preflight修改其它值。完整输出保留于第二次证据目录。preflight通过后仅`preprod_compose_app_up web`的--no-deps路径；18:24:54.217747 JST（09:24:54.217747Z）开始，显式`preprod_wait_for_service_health web`与`preprod_assert_container_image web`全部PASS。没有build/pull、发版、迁移或重建其它服务。

- 原web：`7c9eb03f514ac5b98886563e2d4a31e6a82410a29fe942a96e9427320f53d093`，StartedAt `2026-10-11T08:53:14.153586954Z`。
- 新web：`a5cd03eb3f8669064b4f54a304eddb1c6a05794013d881112330d7d638aee571`，StartedAt `2026-10-11T09:24:55.435116931Z`。
- 镜像引用均cps-novel:0.5.15-db62350，实体均`sha256:b753a3b7c0a650d75db8167d925ffce3d835efc4e1c3d8b7cc7934345006e935`，descriptor/config/platform/revision核对不变。
- 密钥容器内wc -c=36，web开关true、Site Key匹配、后台来源https://zbcwf.pulsenovels.com，health healthy/0.5.15/Final，database与metadata passed。

原始启动标记：

```text
[auth] ADMIN_LOGIN_TURNSTILE_ENABLED=true — admin login requires Turnstile (hostname=zbcwf.pulsenovels.com, site key and secret present)
```

其它五服务的ID和StartedAt逐项不变：

| 服务 | 完整容器ID | StartedAt（UTC） | 核对 |
| --- | --- | --- | --- |
| worker | `160a9ec0a8cff439074e5293d0abb1de2b02a4cfdffb14b16036a7d5a65141c0` | `2026-10-10T17:07:04.899569634Z` | 不变 |
| worker-light | `7709fc2894f2702f3a2b9d06d94905b1c11526dc21e0140209edbde2fff24716` | `2026-10-10T17:07:05.054978878Z` | 不变 |
| scheduler | `c5779d521b4eec5b646a8642df524f1e6d84f5b7a39ed71ba24bc9d2f82d1cfd` | `2026-10-10T17:07:11.780118207Z` | 不变 |
| postgres | `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e` | `2026-09-27T15:28:01.610098036Z` | 不变 |
| backup-timer | `43bb77638c4a230eb856dc64aece6eeded02eb8ce92305fa4120c3e80da325da` | `2026-10-10T17:07:49.905880279Z` | 不变 |

### 技术验证与Owner最终验收

技术验证于2026-10-11 18:25:03 JST（09:25:03Z）完成，第1～6项全PASS。新web自启动error=0 / permission denied=0 / verification refused=0 / misconfigured=0；无misconfigured。

| 外部取样（各一次） | HTTP | 原始HTML结果 | 响应头 | 判定 |
| --- | --- | --- | --- | --- |
| 公开首页 | 200 | 无challenges.cloudflare.com、无验证标签和本Site Key | DENY | PASS |
| 后台/login，既有Basic Auth curl配置 | 200 | 有span标签文字“人机验证”，页面数据有0x4AAAAAAFTqFgFn4w6AYhbb；无Cloudflare域名属预期 | X-Frame-Options: DENY | PASS |

自动外部取样2/4次，无重试或跟随跳转；Owner浏览器为人工验收，不计入、不统计其请求。只保存受限匹配结果、长度、页面哈希及DENY，不保存凭据、原始HTML或完整响应头。

Owner于2026-10-11 18:31:10 JST报告实际登录成功：已完成：验证框 → 验证 → 密码 → 两步验证 → 进入后台，人机验证正常。随后只读复核2026-10-11 18:31:13 JST，verification refused=0、error=0、permission denied=0、misconfigured=0，health与镜像身份正常；保持开关打开。没有模拟登录或提交登录表单。

### 回退方法与治理

本次技术验证未触发回退。Owner报告失败时，先只读查看verification refused的reason并回报，再恢复本次备份（先核env无漂移）或只把本次开关设false；全新shell加载原manifest/env，仅重建web，不跑preflight、不删密钥。显式等待healthy、镜像核对、五服务身份检查，并用预算内一次后台取样确认验证标签/Site Key不再出现；浏览器不再动态加载Cloudflare脚本。等待Owner期间不因超时自行回退。

第二次尝试的原始脱敏日志、SHA/diff/cmp、preflight、容器身份、外部取样和Owner结果见[第二次证据目录](evidence/admin-turnstile-enable-2026-10-11/attempt2/)。没有改代码/nginx/其它env/其它开关/白名单/数据库或操作其它服务。

治理在Owner结果和日志复核后完成一个文档提交：追加本节、v0.5.15台账补一行、指定`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.abbrev GIT_CONFIG_VALUE_0=7`运行原CHANGELOG生成器，带Agent: codex / Model: GPT-6 trailer。仅推送release分支，回读分支SHA与固定annotated v0.5.15 Final；治理提交不部署，不追加发版日志。Notion另追加第二次尝试独立手账并回读保留原历史，收据留于`.tmp/admin-turnstile-enable-20261011-attempt2/`。
