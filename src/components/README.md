# src/components/

**Owner: Claude（独占写入）**

## 用途

跨页面复用的 UI 基元。供 `src/app/`、`src/features/admin-ui/`、`src/features/public-ui/` 消费。

## 当前内容（P1-10）

| 文件 | 说明 |
| --- | --- |
| `Container.tsx` | 内容宽度容器，最大宽度走 `--novel-content-max` |
| `Button.tsx` | 行动按钮三档：`accent`（纸色填充）/ `outline`（描边）/ `quiet`。**没有全圆角** |
| `CoverImage.tsx` | 封面，比例只走 `--novel-cover-aspect`；缺图渲染占位块 |
| `Tag.tsx` | 站点标签与标签列表。**空数组返回 `null`**，让「标签为空即整块消失」难以违反 |
| `MetaList.tsx` | 元信息行：流式，只渲染真实存在的项；一项也没有时整行不渲染 |
| `SectionHeader.tsx` | 区块小标题。**不用 emoji 装饰** |
| `BrandMark.tsx` | 品牌占位：几何标记 + `BRAND_PLACEHOLDER` 字标，槽位尺寸固定 16/24/32/40 |

## 双主题义务

基元只消费语义 token，由各自的作用域提供具体值——**不在基元里写主题分支**。
后台浅色与前台深色共用同一批基元时，这条是前提。

## 品牌占位

正式 Logo 到位后**只替换 `BrandMark.tsx` 里的标记资产与字标，不重构页头**。
禁止自行生成正式 Logo，禁止用 emoji 当 Logo。

## 待填充

后台侧基元（列表、表单、弹窗）随 **P1-09** 填充。
