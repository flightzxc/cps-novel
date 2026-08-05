import {
  DEFAULT_READER_SETTINGS,
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
  READER_SETTINGS_STORAGE_KEY,
  READER_THEMES,
} from "./reader-settings";

/**
 * 补水前的阅读偏好回放脚本。
 *
 * 服务端不知道读者本机存过什么，阅读区只能先按默认值渲染。改过设置的读者会在补水
 * 前看到一帧默认外观：配色闪一下已经难看，**排版闪一下是整页回流**，更明显，而且
 * 会让阅读位置按错误的字号被测量。这段脚本在补水之前就把偏好写到 `<html>` 上，
 * `globals.css` 里的 `--reader-pref-*` 兜底层与主题回放规则据此提前生效。
 *
 * 🔴 **本脚本的收敛语义必须与 `normalizeReaderSettings` 逐条相同。**
 * 两边一旦漂移，读者会在补水瞬间看到主题或排版跳变——而这正是它要消除的东西。
 * 曾经的实现用 `F[index]` 是否存在来代替规范化，产生三处分歧：
 *
 * | 存储值 | 旧脚本 | normalize | 后果 |
 * | --- | --- | --- | --- |
 * | `"2"` | 20px（隐式转换） | 18px（默认档） | 补水瞬间 20px → 18px |
 * | `99` | 18px（下标不存在，回默认） | 22px（夹到最大档） | 18px → 22px |
 * | `-99` | 18px（同上） | 16px（夹到最小档） | 18px → 16px |
 *
 * 因此这里不再用下标探测，而是把 clampIndex 的三条规则原样搬进脚本：
 * `Number.isInteger` 一次覆盖「是 number / 有限 / 整数」，合法整数越界才夹边界，
 * 其余一律回默认档。档位表与默认值都从 `reader-settings.ts` 注入，脚本里不出现
 * 任何手抄的字面量——手抄一份就等于又开了一条漂移的口子。
 *
 * 这个模块是纯字符串构造，不引入任何 Node-only 运行时；产物由章节布局（server
 * component）内联进 HTML，不进客户端 bundle。
 */
export function buildReaderBootstrapScript(): string {
  // 注入的都是常量字面量，JSON.stringify 足以安全转义。
  const fontSizes = JSON.stringify(READER_FONT_SIZES);
  const lineHeights = JSON.stringify(READER_LINE_HEIGHTS);
  const measures = JSON.stringify(READER_MEASURES);
  const themes = JSON.stringify(READER_THEMES);
  const defaults = JSON.stringify(DEFAULT_READER_SETTINGS);
  const storageKey = JSON.stringify(READER_SETTINGS_STORAGE_KEY);

  return [
    "(function(){",
    "try{",
    `var F=${fontSizes},L=${lineHeights},M=${measures},T=${themes},D=${defaults};`,

    // 解析存储。malformed JSON、非对象、数组一律当作「什么都没存过」→ 全默认值。
    "var p={};",
    "try{",
    `var raw=window.localStorage.getItem(${storageKey});`,
    "if(raw){",
    "var parsed=JSON.parse(raw);",
    'if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)){p=parsed}',
    "}",
    "}catch(e){p={}}",

    // clampIndex 的等价实现：非整数（含字符串数字、小数、NaN、Infinity、null、
    // undefined、数组、对象）回默认档；合法整数越界夹到最近边界。
    "function ci(v,len,def){",
    "if(!Number.isInteger(v)){return def}",
    "return Math.min(Math.max(v,0),len-1);",
    "}",
    "var fi=ci(p.fontSizeIndex,F.length,D.fontSizeIndex);",
    "var li=ci(p.lineHeightIndex,L.length,D.lineHeightIndex);",
    "var mi=ci(p.measureIndex,M.length,D.measureIndex);",
    "var th=T.indexOf(p.theme)>=0?p.theme:D.theme;",

    "var r=document.documentElement;",
    // system 时移除属性而不是写 "system"：没有属性就没有额外规则参与，
    // 媒体查询自己说了算，这正是「跟随系统」该有的行为。
    'if(th==="system"){r.removeAttribute("data-reader-pref-theme")}',
    'else{r.setAttribute("data-reader-pref-theme",th)}',
    // 三项排版总是显式写入（包括回落到默认档的情形），补水前的状态因此是确定的，
    // 不依赖「没写就走 CSS fallback」这种隐式约定。
    'r.style.setProperty("--reader-pref-font-size",F[fi]);',
    'r.style.setProperty("--reader-pref-line-height",L[li]);',
    'r.style.setProperty("--reader-pref-measure",M[mi]);',

    "}catch(e){}",
    "})();",
  ].join("");
}
