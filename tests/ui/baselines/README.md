# 视觉基准图

**Owner: Claude（`tests/ui/` 独占写入）**

## 这些是什么，不是什么

**是**：P1-10 交付时各屏幕的实际渲染快照，逐字节可重现，用于人工比对——
改动前后各生成一次，肉眼或用任意图片 diff 工具对照，能看出版面有没有意外变化。

🔴 **不是自动化视觉回归测试。** 仓库里**没有**截图对比机制：没有 diff 阈值、
没有 CI 拦截、`npm run test:ui` 不会读这些图。要做成真正的回归门禁，需要引入
截图对比依赖（本轮明确不新增 npm 依赖），属于后续任务。

所以引用这些图时，准确的说法是「基准图已入库」，不是「视觉回归通过」。

## 覆盖范围

| 文件 | 屏幕 | 视口 |
| --- | --- | --- |
| `home-desktop.png` / `home-mobile.png` | 首页 · 通栏 Hero 轮播 | 1440×900 / 390×844 |
| `home-fallback-desktop.png` | 首页 · 无横版物料回落 | 1440×900 |
| `novel-desktop.png` / `novel-mobile.png` | 小说详情（含可试读章节区块） | 1440×900 / 390×844 |
| `novel-sparse-desktop.png` | 详情 · 极端稀疏（无封面/标签/试读章） | 1440×900 |
| `chapter-desktop.png` / `chapter-mobile.png` | 章节阅读（阅读作用域） | 1440×900 / 390×844 |
| `chapter-last-desktop.png` | 章节 · 末章（正式阅读升为主动作） | 1440×900 |
| `collection-desktop.png` | 语言 / 题材聚合 | 1440×900 |
| `collection-empty-desktop.png` | 聚合 · 空状态 | 1440×900 |
| `unavailable-desktop.png` | 下架状态 | 1440×900 |
| `takedown-desktop.png` | 撤回状态 | 1440×900 |

只截首屏视口，不截整页：评审关心的是首屏版面。

## 怎么重新生成

先起本地服务：

```bash
npm run build && PORT=3111 npm run start
```

再跑（`--virtual-time-budget=2500` 必须小于轮播 7 秒的自动播放间隔，
否则截到哪一张不确定，基准图就不可重现）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1440,900 --virtual-time-budget=2500 \
  --screenshot=tests/ui/baselines/home-desktop.png \
  http://localhost:3111/dev-preview/home
```

其余屏幕换 URL、文件名与视口即可。

## 已知约束

1. **内容是 MOCK_ONLY 假数据**，不是真实上游内容；封面与横版主视觉都是内联 SVG 占位。
2. **依赖本机 Chrome**，不同 Chrome 大版本渲染可能有细微差异；跨机器比对前先确认版本一致。
3. **承载路由是临时的开发预览路由**，正式 URL 结构冻结后需要重新生成。
