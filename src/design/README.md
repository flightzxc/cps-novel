# src/design/

**Owner: Claude（独占写入）**

## 用途

设计系统层。用户端视觉体系的唯一真源，不与后台浅色主题混用。

## 当前内容（P1-10）

- `contrast.ts` —— WCAG 2.1 对比度计算。让「正文 ≥ 4.5:1、非文本 ≥ 3:1」成为可执行断言，
  被 `tests/ui/design-tokens.test.ts` 用来解析真实色值后重算。

## token 写在哪

色值本身在 `src/styles/globals.css`，按作用域分成两组：

- `.site` —— 站点作用域，恒定深色，不跟随系统；
- `.reader` —— 阅读作用域，默认跟随系统，可手动覆盖为浅色 / 深色。

🔴 **组件里禁止硬编码色值**，一律走 token（Tailwind 的 `novel-*` / `reader-*` 工具类，
或直接 `var(--novel-*)`）。这条由 `tests/ui/no-hardcoded-colors.test.ts` 守住。

封面比例同理：只有 `--novel-cover-aspect` 一个定义处，全站不得出现第二处字面比例。

## 视觉口径

`docs/p1/P1_10_VISUAL_DIRECTION.md` 是冻结的方向文档——配色、密度、页面结构，
以及数据边界（哪些字段永远不许出现在页面上）都以它为准。
