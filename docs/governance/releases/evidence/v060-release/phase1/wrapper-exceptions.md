# 第一阶段执行异常记录

- 全量回归的镜像存储兼容性测试在 docker pull busybox:latest 时，docker-credential-desktop 长时间等待。只终止本次测试的挂起助手进程，未改测试、Docker 配置或系统网络配置；原测试继续并最终通过。classic 与 containerd 两种真实 Docker 29.8.1 daemon 均留证，全量回归退出码0、11397 passed、0 failed、无Unhandled。
- p1-05b 原脚本的 postgres:16 拉取出现同类凭据助手等待，随后原进程返回并继续；运行器最终PASS，未修改或绕过门禁。
- 检查进程列表的自写只读诊断首次遇到 ps 输出非UTF-8，以及稍后目标进程已经退出导致 ps 非零；诊断已改为宽容解码/处理进程退出。未影响仓库门禁。
- 所有后续执行、重试和异常以对应原始日志及metadata为准；本记录不代表阶段完成。

- 品牌镜像开发依赖层 npm ci 完成（523包/约6分钟），Next编译与TypeScript通过；生产依赖层 npm ci --omit=dev 长时间无输出。临时网络诊断与 docker version 随后均返回 `Docker Desktop is unable to start`，Server=null。网络探针未能启动容器，也没有实际执行网络请求；未改Docker或系统网络配置。由于Docker守护进程不可用，中断本次挂起的docker build，品牌镜像门禁未完成。未出现ECONNRESET，未使用其重试例外；归档、镜像端到端和GitHub推送未开始。按提示词门禁停手点等待Owner确认。

- Owner回复“已处理弹窗，可以继续”后恢复第一阶段。Docker Server恢复响应（Engine29.1.3），Final/tree及工作树干净状态核对一致，构建前再次保存docker system df。原失败日志原样保留，恢复后独立记录为brand-image-resume-1；验证器明确读取该恢复尝试。修改自写push包装器时的分号换行语法错误已在执行前修正，两个包装器语法检查通过；仓库脚本未改。

- 恢复后进行轻量临时容器网络诊断，registry根路径200、Prisma二进制服务根路径404（服务有响应）。该诊断包装器包含两次没有显式设置代理的请求，偏离“外部HTTP一律走代理”要求；已停止该诊断路径并创建仅代理版本。两次直连和两次代理请求均只针对依赖服务，不是生产站点请求，不含凭据或上游口令码；没有修改Docker/系统配置、repo脚本或门禁。原始诊断源码和日志保留以如实记录。

- 后续只读核对确认Docker Desktop既有代理模式为manual，HTTP/HTTPS均匹配Owner指定的127.0.0.1:7899；系统HTTP/HTTPS代理也为回环地址端口7899。未修改这些配置。此前网络探针日志中的direct仅表示Node客户端没有显式CONNECT，不能据此断言它绕过了Docker Desktop的既有代理；“未显式设置”事实保留，后续诊断仍仅使用显式代理版本。构建沿用原命令，不添加或修改网络配置。

- 恢复后的原品牌镜像构建在生产依赖npm ci --omit=dev处返回ECONNRESET（833.2秒，exit1）。按提示词明确例外，仅重试一次；重试单独记录brand-image-econnreset-retry-1，原日志/metadata不覆盖。此前Docker不可用的中断不是ECONNRESET重试。未修改Docker、系统或仓库网络配置。

- 提示词允许的唯一ECONNRESET重试仍在npm ci --omit=dev处失败（154.6秒、exit1、ECONNRESET）。Docker Server持续可用；按“重试1次；仍失败就停下报告”停手，没有追加重试。自有重型锁已释放，Final/tree/工作树干净及两个CPS参考仓不变再次核对。归档、镜像端到端和GitHub推送尚未执行。

- Owner再次明确授权从品牌镜像继续，Final493eb23b不变，已通过测试与37运行器不重跑；新的npm ECONNRESET重试额度为1次。新尝试独立记录brand-owner-resume-2，若触发新额度则独立记录brand-owner-resume-2-econnreset-retry。Docker29.1.3可用、Final/tree及干净工作树再核对，构建前docker system df留证，未改网络配置。

- 本轮Owner明确恢复后，brand-owner-resume-2一次通过（190.5秒），没有使用本轮新增的ECONNRESET重试额度。随后原归档构建器9.6秒通过，独立SHA256一致；镜像端到端13.6秒通过，原消费端--load校验6.0秒通过。全部证据验证后才推送Final，并GitHub回读一致。既有全量测试与37运行器未重跑。所有临时E2E容器/网络由本次包装器退出清理，未清理既有镜像/卷/缓存；自有锁已释放。
