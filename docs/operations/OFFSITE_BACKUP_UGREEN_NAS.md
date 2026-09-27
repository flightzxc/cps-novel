# 异地备份：绿联（UGREEN）NAS 安装说明

面向 Owner，不假设你熟悉命令行。所有命令都可以整行复制粘贴到终端里。

## 这一步在做什么，为什么要这样做

haiyue-vps（生产机）每天会在本机产生一份数据库的逻辑备份（一个 `.dump` 文件
加两个校验用的小文件）。这些文件一直只存在那台服务器自己的硬盘上——服务器
如果整机丢失（硬件故障、账号被封、被误删），这些备份会跟着一起没有。这一步
就是把备份定期同步一份到你家里的 NAS 上，作为"离线的第二份"。

早期方案是把服务器上 `deploy` 用户自己的 ssh 钥匙原样交给 NAS。但
`deploy` 在服务器的 docker 用户组里，能对任意容器执行 `docker exec -u 0`——
这等于拿到了整台服务器的 root 权限。NAS 放在家里，网络暴露面比数据中心大得
多，一旦 NAS 被攻破，攻击者就能拿这把钥匙直接掌控生产服务器。

现在的方案是给 NAS 单独配一把**新钥匙**，这把钥匙加到服务器上时会附带一个
限制：**它只能做两件事**——列出已经写完的备份、读取某一份已经写完的备份文
件——除此之外，任何命令（包括 `docker ps`、读取服务器上的其它文件、开一个
交互式终端、走这条连接做端口转发）统统会被服务器拒绝。也就是说，就算这把
NAS 专用钥匙被盗，攻击者能拿到的也只是"能下载已完成的备份文件"，而不是服务
器本身的控制权。

整个改动分成两半：
- **服务器那一半**（安装受限入口脚本、往 `authorized_keys` 里加那一行新钥
  匙）——这两步动服务器，必须由 Owner 亲自做或明确授权，见文末"服务器端需要
  Owner 授权的步骤"。
- **NAS 那一半**（开 SSH、生成钥匙、放脚本、设置定时任务）——这就是本文档
  下面的内容，NAS 是你自己的设备，你可以自己按步骤操作。

---

## 第 1 步：在 UGOS 里开启 SSH，并登录 NAS

UGOS / UGOS Pro 不同型号、不同固件版本的界面文字可能不完全一样，下面写的是
**大致方位**，具体请以你自己 NAS 屏幕上看到的为准，不要照抄一个菜单名字硬找：

1. 用浏览器打开 NAS 的管理界面，登录你的管理员账号。
2. 通常在**控制面板 → 终端机 / SSH**（或类似"远程访问""终端与 SNMP"这一类
   命名的分类）里，找到一个"启用 SSH 服务"的开关，打开它，记下它显示的端口
   号（默认通常是 22，如果界面上写的是别的号码，后面所有命令里的端口都要跟
   着换成那个号码）。
3. 记下 NAS 在你家里网络里的 IP 地址（UGOS 首页或"控制面板 → 网络"里能看
   到，形如 `192.168.x.x`）。

开启之后，在你的 Mac 上打开"终端"（Terminal），像下面这样登录一次，确认能
连上（把 `NAS用户名` 和 `NAS的IP` 换成你自己的）：

```bash
ssh NAS用户名@NAS的IP
```

第一次连接会提示"是否信任这台主机的指纹"，输入 `yes` 回车即可。能看到 NAS
的命令行提示符，就说明这一步成功了。之后的第 2～4 步，既可以在这个 SSH 会话
里做（在 NAS 上直接操作），也可以先在 Mac 上准备好钥匙再传过去——下面按
"直接在 NAS 上操作"来写，更省心。

---

## 第 2 步：在 NAS 上生成专用钥匙

**重要：这把钥匙只用于这一件事，不要跟你自己平时登录别的服务器用的钥匙混
用。**

在刚才的 NAS SSH 会话里执行：

```bash
mkdir -p ~/.ssh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/cps_novel_offsite_nas -C "ugreen-nas-offsite-$(date +%Y%m%d)"
```

生成后有两个文件：`~/.ssh/cps_novel_offsite_nas`（私钥，**永远不要**发给任
何人，包括主控/Codex）和 `~/.ssh/cps_novel_offsite_nas.pub`（公钥，只有这
个要发出去）。看一下公钥内容：

```bash
cat ~/.ssh/cps_novel_offsite_nas.pub
```

把这一整行内容（以 `ssh-ed25519` 开头）复制下来，发给主控（Claude）或
Codex，说明"这是 NAS 异地备份专用钥匙的公钥，请 Owner 审批后加到服务器
authorized_keys"。**只发公钥这一行文本**——不要把私钥文件传出 NAS。

这一步做完之后，服务器那一侧要怎么加、Owner 要确认什么，见文末"服务器端需
要 Owner 授权的步骤"；那一段需要 Owner 亲自执行或明确点头，不在这份"NAS 操
作说明"的范围内，先接着往下把 NAS 这一侧配好。

---

## 第 3 步：放置脚本

选一个 NAS 上你自己的、会持久保留的目录，例如你在存储管理里建过的共享文件
夹（"下载""家目录"之类都可以），下面假设是 `~/cps-novel-offsite/scripts`
（也就是你登录用户家目录下的一个子目录）——你可以换成自己喜欢的路径，只要
后面几步的命令跟着换掉即可。

```bash
mkdir -p ~/cps-novel-offsite/scripts
mkdir -p ~/cps-novel-offsite/backups
mkdir -p ~/cps-novel-offsite/logs
```

需要放进 `~/cps-novel-offsite/scripts/` 的只有两个文件，都来自 cps-novel
这个仓库：

- `scripts/preproduction/offsite-pull.sh`
- `scripts/preproduction/export-backup-manifest.sh`

最简单的办法是**从你自己 Mac 上已经拉好的仓库checkout，用 `scp` 直接拷贝过
去**（在 Mac 的终端里执行，不是在 NAS 的 SSH 会话里）：

```bash
scp /path/to/你的cps-novel仓库/scripts/preproduction/offsite-pull.sh \
    /path/to/你的cps-novel仓库/scripts/preproduction/export-backup-manifest.sh \
    NAS用户名@NAS的IP:~/cps-novel-offsite/scripts/
```

拷贝完回到 NAS 的 SSH 会话里，给这两个脚本加上可执行权限：

```bash
chmod +x ~/cps-novel-offsite/scripts/offsite-pull.sh
chmod +x ~/cps-novel-offsite/scripts/export-backup-manifest.sh
```

**以后 cps-novel 仓库如果更新了这两个脚本**（比如修了 bug、加了新参数），
需要重新 `scp` 一遍覆盖过去——NAS 上这两份是独立的拷贝，不会自动跟仓库同
步，主控/Codex 会在有相关改动时提醒你要不要更新这两个文件。

---

## 第 4 步：第一次手动运行，确认 `OFFSITE_PULL=PASS`

前提：第 2 步生成的公钥，Owner 已经确认加到服务器的 `authorized_keys`
里（见文末），并且服务器那一侧的受限入口脚本已经装好——这两件事都完成之
前，下面这条命令会失败，属于正常现象，不用惊慌，等服务器那侧就绪了再试。

在 NAS 的 SSH 会话里执行（一整条命令，`OFFSITE_PULL_SSH_OPTS` 那部分指定用
哪把钥匙）：

```bash
OFFSITE_PULL_SSH_OPTS="-i ~/.ssh/cps_novel_offsite_nas -o StrictHostKeyChecking=accept-new" \
~/cps-novel-offsite/scripts/offsite-pull.sh \
  --gate \
  --remote-host deploy@haiyue-vps的服务器地址 \
  --local-dir ~/cps-novel-offsite/backups \
  --keep 14
```

把 `haiyue-vps的服务器地址` 换成服务器的真实主机名或 IP（找主控/Codex 要，
不要自己猜）。

**成功的样子**：命令的最后一行是这样的（`file=`、`sha256=` 后面跟的是当次
真实值，不会跟示例一模一样）：

```
OFFSITE_PULL=PASS file=cps-novel-xxxxxxxx.dump size=xxxxxxxx sha256=xxxx... status=pulled manifest=/home/你/cps-novel-offsite/backups/SHA256SUMS
```

看到 `OFFSITE_PULL=PASS` 就说明：连上了服务器、确认了哪一份是最新且已经写
完的备份、把它和两个校验文件完整下载下来、在 NAS 本地重新算了一遍 sha256 确
认没传坏、生成了 `SHA256SUMS` 清单文件。`~/cps-novel-offsite/backups/` 目录
下这时应该能看到三类文件：`*.dump`、`*.dump.sha256`、`*.dump.metadata`，加
一个 `SHA256SUMS`。

如果失败，看"怎么看日志、怎么判断失败"那一节。

---

## 第 5 步：设置每天自动运行

**服务器每天做备份的具体时间点会跟着部署动作漂移**（不是固定钟点），所以不
要只设"每天固定某一分钟跑一次"——万一那天服务器备份还没做完或者时间点变
了，当天就会白跑一次（不会报错，只是那天没拉到新的）。脚本本身是幂等的：
重复跑、跑到没有新备份时都不会出错，只会很快退出并汇报"已经是最新的"，所以
**更保险的做法是一天多跑几次**（比如每 6 小时一次，或者每天两次），错过一
次也很快会被下一次补上。

UGOS 通常在**控制面板 → 计划任务（Task Scheduler）**这一类地方能建"用户定
义的脚本"任务；具体菜单名字以你界面上看到的为准。如果找不到图形化入口，用
下面的 crontab 方式同样可靠。

### 方式 A：UGOS 自带的计划任务（如果界面上有）

新建一个"用户定义的脚本"任务，运行频率选"每 6 小时"或"每天，运行两次"，脚
本内容填：

```bash
OFFSITE_PULL_SSH_OPTS="-i /home/你的用户名/.ssh/cps_novel_offsite_nas -o StrictHostKeyChecking=accept-new" \
/home/你的用户名/cps-novel-offsite/scripts/offsite-pull.sh \
  --gate \
  --remote-host deploy@haiyue-vps的服务器地址 \
  --local-dir /home/你的用户名/cps-novel-offsite/backups \
  --keep 14 \
  >> /home/你的用户名/cps-novel-offsite/logs/offsite-pull.log 2>&1
```

UGOS 图形界面里的计划任务，脚本路径通常要写**绝对路径**，不能用 `~`，所以
上面全部换成了 `/home/你的用户名/...` 这种写法——请把 `你的用户名` 换成你
在 NAS 上的登录用户名（用 `echo $HOME` 能看到你的家目录实际路径，照着填）。

### 方式 B：NAS 自己的 crontab（SSH 里操作，通用做法）

```bash
crontab -e
```

在打开的编辑器里加一行（`0 */6 * * *` 表示每 6 小时的整点跑一次；也可以写
`0 7,19 * * *` 表示每天 7 点和 19 点各跑一次，两种任选一种）：

```
0 */6 * * * OFFSITE_PULL_SSH_OPTS="-i /home/你的用户名/.ssh/cps_novel_offsite_nas -o StrictHostKeyChecking=accept-new" /home/你的用户名/cps-novel-offsite/scripts/offsite-pull.sh --gate --remote-host deploy@haiyue-vps的服务器地址 --local-dir /home/你的用户名/cps-novel-offsite/backups --keep 14 >> /home/你的用户名/cps-novel-offsite/logs/offsite-pull.log 2>&1
```

保存退出（如果编辑器是 vi/vim：按 `Esc`，输入 `:wq`，回车）。

---

## 第 6 步：怎么看日志、怎么判断失败

如果按上面配置了日志文件，直接看最近几次的结果：

```bash
tail -n 50 ~/cps-novel-offsite/logs/offsite-pull.log
```

- 一行以 `OFFSITE_PULL=PASS` 开头 → 那一次成功了（`status=already_present`
  表示这次没有新备份，之前拉的那份还在且校验通过，也算正常，不是失败）。
- 一行以 `OFFSITE_PULL=FAIL reason=...` 开头 → 失败了，`reason=` 后面是原
  因，常见的几种：
  - `no_complete_backup_found`：服务器那边最近这份备份可能还没写完，等下一
    次自动重试通常就好；如果连续好几次都这样，找主控/Codex 看服务器那边的
    备份任务是不是出了问题。
  - `checksum_mismatch`：传输过程中数据损坏了，脚本已经自动拒绝了这份坏文
    件（不会污染 `~/cps-novel-offsite/backups/`），等下一次自动重试。
  - 其它以 `Permission denied`/`refused`/`failed` 开头的：多半是钥匙没配对
    （公钥没加到服务器、或者服务器那边的受限入口脚本没装好），找主控/
    Codex 核实"服务器端需要 Owner 授权的步骤"是不是都已经做完。
- 如果日志里完全找不到任何一次 `OFFSITE_PULL=` 开头的行：说明定时任务本身
  没跑起来（配置写错了路径，或者 UGOS 那个计划任务开关没打开），回去检查第
  5 步。

另外可以直接看 `~/cps-novel-offsite/backups/` 目录，确认里面 `.dump` 文件
的修改时间是不是最近的：

```bash
ls -la ~/cps-novel-offsite/backups/
```

---

## 第 7 步：恢复演练（在 Owner 的 Mac 上做，需要 Docker）

光"备份拉下来了"不够，要定期证明"这份备份真的能恢复成一个可用的数据库"。
这一步在你的 Mac 上做（Mac 需要装了 Docker Desktop 并且在运行）：

1. 在 Mac 上挂载 NAS 的共享目录（Finder → 前往 → 连接服务器，或者用 UGOS
   自带的挂载方式都可以），确认能在 Mac 上直接看到
   `.../cps-novel-offsite/backups/` 里的文件。
2. 在 Mac 的终端里，进入你本地的 cps-novel 仓库目录，执行（把
   `/Volumes/你挂载的NAS共享/cps-novel-offsite/backups` 换成实际挂载后的
   路径，`<某份.dump文件名>` 换成该目录下实际的文件名）：

```bash
OFFHOST_COPY_CONFIRMED=YES scripts/preproduction/restore-offhost-rehearsal.sh \
  --offhost-dir /Volumes/你挂载的NAS共享/cps-novel-offsite/backups \
  --dump /Volumes/你挂载的NAS共享/cps-novel-offsite/backups/<某份.dump文件名> \
  --manifest /Volumes/你挂载的NAS共享/cps-novel-offsite/backups/SHA256SUMS
```

看到最后一行是：

```
OFFHOST_RESTORE=PASS source=EXPORTED_COPY isolation=DISPOSABLE
```

就说明：这份从 NAS 上取到的备份，被完整还原成了一个一次性、隔离的数据库容
器，数据是完整、可用的。这个一次性容器脚本跑完会自动清理，不会在你 Mac 上
留下任何东西。建议每次大版本发布之后、或者至少每季度，做一次这个演练。

---

## 服务器端需要 Owner 授权的步骤

下面两步动的是 haiyue-vps（生产机）本身，**必须由 Owner 亲自执行，或者明确
口头/书面授权主控代为执行**——不属于"NAS 自己这一侧随便操作"的范围。

### A. 安装受限入口脚本

```bash
ssh haiyue-vps 'sudo -u deploy mkdir -p /opt/cps-novel/shared/bin'
scp scripts/preproduction/offsite-readonly-gate.sh \
    haiyue-vps:/opt/cps-novel/shared/bin/offsite-readonly-gate.sh
ssh haiyue-vps 'sudo chown deploy:deploy /opt/cps-novel/shared/bin/offsite-readonly-gate.sh && \
                 sudo chmod 700 /opt/cps-novel/shared/bin/offsite-readonly-gate.sh'
```

（以上是从 Owner 自己已经有权限的机器上执行，具体是否需要 `sudo`、`deploy`
用户是否已经能直接写这个目录，以服务器当时的实际权限配置为准，必要时请主控/
Codex 先只读核实一遍再给出精确命令。）

### B. 把 NAS 的公钥加到 `authorized_keys`，并加上 `restrict` 限制

在服务器上，以 `deploy` 用户身份，往
`~deploy/.ssh/authorized_keys`**追加**一行（不要覆盖已有内容），格式如
下——把 `AAAA...` 换成第 2 步里 NAS 生成、Owner 已经确认过的那一整行公钥：

```
restrict,command="/opt/cps-novel/shared/bin/offsite-readonly-gate.sh" ssh-ed25519 AAAA...你的公钥内容... ugreen-nas-offsite
```

**为什么要用 `restrict`**：这一个词是 OpenSSH 的"全关"开关，一次性关掉端口
转发、agent 转发、X11 转发、分配交互式终端（pty）这几项这把钥匙原本能做的
事，只留下 `command=` 里指定的这一个程序会被执行，且这个程序会不认
`SSH_ORIGINAL_COMMAND` 之外的输入之外的任何东西。没有 `restrict`，即使有
`command=`，某些旧版本客户端仍可能通过请求端口转发等方式打开额外的能力；加
了 `restrict` 之后，这些附加请求会在服务器一侧直接被拒绝，`offsite-pull.sh
--gate` 一节列出的"用这把钥匙尝试越权操作全部被拒绝"，验证的就是这一层。

追加完这一行之后，让主控/Codex（或你自己）验证一遍：从 NAS 上跑一次第 4 步
的命令，应该能看到 `OFFSITE_PULL=PASS`；再用同一把钥匙手动尝试
`ssh -i ~/.ssh/cps_novel_offsite_nas deploy@haiyue-vps的服务器地址
'docker ps'`，应该被拒绝、看不到任何容器列表。

### 回退方法

如果需要撤销这把钥匙（怀疑泄露、NAS 更换、不再需要异地同步了），在服务器上
把 `authorized_keys` 里那一整行（以 `restrict,command=` 开头、注释里带
`ugreen-nas-offsite` 的那一行）删掉即可，不影响其它任何钥匙或功能：

```bash
ssh haiyue-vps
grep -n ugreen-nas-offsite ~deploy/.ssh/authorized_keys   # 先确认要删的是哪一行
# 确认无误后，用编辑器打开该文件删掉那一整行并保存
```

删掉之后，NAS 上再跑 `offsite-pull.sh --gate` 会立即失败（`Permission
denied`），这是预期行为，不需要做其它任何清理——`offsite-readonly-gate.sh`
这个脚本本身留在服务器上不用管，没有对应的有效钥匙时它根本不会被触发。

---

## 附：涉及的脚本与它们的关系

| 文件 | 跑在哪 | 作用 |
| --- | --- | --- |
| `scripts/preproduction/offsite-readonly-gate.sh` | haiyue-vps（服务器），作为 ssh 强制命令 | 只认 `list` / `get <文件名>` 两个动作，其余一律拒绝；见该文件自己的头部注释 |
| `scripts/preproduction/offsite-pull.sh --gate` | NAS（或 Owner 的 Mac） | 通过上面的入口把最新已完成备份拉下来、本地校验、生成清单、按 `--keep` 清理旧份 |
| `scripts/preproduction/export-backup-manifest.sh` | 被 `offsite-pull.sh` 自动调用 | 生成/刷新 `SHA256SUMS` 清单，不需要单独手动运行 |
| `scripts/preproduction/restore-offhost-rehearsal.sh` | Owner 的 Mac（需要 Docker） | 拿 NAS 上拉到的一份备份，在一次性隔离容器里做真实恢复演练 |
