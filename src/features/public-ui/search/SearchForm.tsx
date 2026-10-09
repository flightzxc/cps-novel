/**
 * 搜索表单（PN-15，照 CPS `search-form.tsx`）。
 *
 * 纯服务端组件，零 JS：没有 "use client"、没有 state、没有 onSubmit，提交行为完全交给浏览器原生表单语义；
 * 不做边打字边联想（与 CPS 一致）。
 *
 * `role="search"` + `method="get"`，**刻意不写 `action`**：省略 `action` 的 GET 表单提交到"当前 URL"并整体替换
 * query string，所以当前路径的语种前缀（`/ja/search`）天然保留，不用手拼带语种的 action 路径；翻到第 N 页后
 * 再提交新词，`page` 随旧 query 一起被替换掉（新词从第 1 页开始）。连字符串 `action` 都不给，也避开 React 19
 * 把 `<form action>` 当 server function 处理的那条路径。
 *
 * 样式只用现有 `novel-*` 设计变量：输入框与按钮都是 44px 高（触控下限），字号 16px（iOS Safari 小于 16px 的
 * 输入框聚焦时会整页放大）；按钮品牌黄（与 `Button` 的 accent 档同色）。
 */
export interface SearchFormProps {
  /** 归一后的查询串，用于回填输入框（不是原始用户输入）。 */
  defaultValue: string;
  /** 只给读屏的 `<label>` 文案。 */
  label: string;
  placeholder: string;
  submitLabel: string;
  maxLength: number;
}

export function SearchForm({ defaultValue, label, placeholder, submitLabel, maxLength }: SearchFormProps) {
  return (
    <form role="search" method="get" className="mt-6 flex items-stretch gap-2 md:gap-3">
      <label htmlFor="site-search-input" className="sr-only">
        {label}
      </label>
      <input
        id="site-search-input"
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        enterKeyHint="search"
        className="h-11 min-w-0 flex-1 rounded-novel-md border border-novel-border-strong bg-novel-bg-elevated px-4 text-base text-novel-fg placeholder:text-novel-fg-subtle"
      />
      <button
        type="submit"
        className="inline-flex h-11 shrink-0 items-center justify-center rounded-novel-pill border border-transparent bg-novel-accent px-5 text-sm font-medium whitespace-nowrap text-novel-on-accent transition-colors select-none hover:bg-novel-accent-hover active:brightness-95 md:px-6"
      >
        {submitLabel}
      </button>
    </form>
  );
}
