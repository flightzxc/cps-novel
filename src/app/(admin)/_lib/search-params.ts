/**
 * 后台列表页读 `searchParams` 的共用规范化。
 *
 * 一个原生 `<form method="GET">` 里，"全部状态""全部语种"这类 `<option value="">`
 * 被选中时，浏览器提交的是"存在但为空"的 `status=`，而不是"不带这个参数"。在筛选
 * 栏的语义里"全部"就是"不过滤"，所以页面在把参数交给服务层之前，必须先把空白值
 * 还原成 `undefined`。
 *
 * 只在**页面边界**做这一步，服务层的严格校验原样保留：服务层仍然把"非空且未登记"
 * 的值当作非法输入拒绝（`?status=foo` 依旧报错），它不替调用方猜"空字符串是不是
 * 想说不过滤"。
 */

/**
 * 空串或只含空白（trim 后为空）→ `undefined`；其它值**原样返回**（不 trim）。
 *
 * 非空值不裁剪是有意的：这里只回答"这个参数有没有被设置"，不替服务层做格式放宽。
 * `" published"` 这类带空格的值仍然会被服务层当成未登记状态拒绝，而不是在这里被悄悄
 * 改成合法值。
 *
 * 非字符串（同一个参数在 URL 里重复出现时，运行时拿到的是数组，尽管类型标注是
 * `string`）原样放行，让服务层按非法输入拒绝，而不是在这里 `.trim` 抛出一个
 * 与参数无关的 TypeError。
 */
export function blankParamToUndefined(value: string | undefined): string | undefined {
  if (typeof value !== "string") return value;
  return value.trim() === "" ? undefined : value;
}
