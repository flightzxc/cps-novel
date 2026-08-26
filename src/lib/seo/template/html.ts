/**
 * 正文 HTML 插值的**窄上下文合同**（P2-02 修订）。
 *
 * ## 为什么五字符实体转义不够
 *
 * 转义 `& < > " '` 能守住文本节点与**带引号**的属性值，但守不住未加引号的属性：
 *
 * ```html
 * <img alt={novel_title}>
 * ```
 *
 * 取值里一个空格就能把后面的内容变成**新的属性**（`alt=A onerror=…`），而空格不在
 * 五字符转义集里。同理，`onclick="{x}"`（JS 上下文）、`style="{x}"`（CSS 上下文）、
 * `<script>{x}</script>` 里的实体转义要么无效、要么语义完全不同。
 *
 * ## V1 的做法：不做 sanitizer，改成收窄合同
 *
 * 不实现完整的 context-aware escaping，也不引入 HTML sanitizer。变量只允许出现在两种
 * 上下文，其余一律在渲染前拒绝：
 *
 * **A. HTML 文本节点**——任何已登记字段都可以。
 *
 * **B. 明确批准的 `标签 + 带引号属性值` 组合**——由登记表的 `htmlBinding` 逐字段授权，
 * 当前只有两条：`promo_redirect_url → a[href]`、`cover_url → img[src]`。
 *
 * 🔴 **授权必须绑定标签。** 只认属性名是不够的：`src` 在 `<img>` 上是图片，在
 * `<script>` 上就是可执行代码——`<script src="{cover_url}">` 能把上游可控的封面地址
 * 变成 JS 加载源。同理 `<iframe src>`、`<embed src>`、`<link href>`、`<base href>`。
 * 结束标签（`</a href="…">`）永不授权：浏览器会丢弃它的属性，值只会被静默吞掉。
 *
 * 且变量必须**独占整个属性值**：`href="{promo_redirect_url}"` 放行，
 * `href="/x{promo_redirect_url}"`、`href="{if a}{promo_redirect_url}{endif}"` 一律拒绝——
 * 拼接是 scheme 注入（`href="javascript:{x}"`）的唯一入口。
 *
 * 明确拒绝：未加引号的属性值、属性名位置、标签名位置、`on*` 事件属性、`style` 属性、
 * `<script>` / `<style>` 块内、HTML 注释内。
 *
 * 🔴 **`alt` / `title` 一类文本属性不预建。** 要放行必须先有真实模板证据，再往登记表
 * 的 `htmlAttribute` 上逐个补，不为「将来可能用到」提前开口子。
 *
 * ## 这不是 HTML 解析器
 *
 * 它是一个只为「判定变量落在什么上下文」而写的扫描器，**判不准就拒绝**，不试图还原
 * 文档树、不处理错误标记的恢复。模板作者写不出来的东西，本来就不该进 `Article.body`。
 */

import { getTemplateField } from "./fields";

/** 违反窄上下文合同的具体原因。 */
export type HtmlInterpolationReason =
  /** 变量落在未加引号的属性值里——取值里一个空格就能造出新属性。 */
  | "unquoted_attribute"
  /** 变量落在属性名位置。 */
  | "attribute_name"
  /** 变量落在标签名位置。 */
  | "tag_name"
  /** 变量落在 `on*` 事件属性里（JS 上下文）。 */
  | "event_attribute"
  /** 变量落在 `style` 属性里（CSS 上下文）。 */
  | "style_attribute"
  /** 变量落在 `<script>` 块里。 */
  | "script_block"
  /** 变量落在 `<style>` 块里。 */
  | "style_block"
  /** 变量落在 HTML 注释里。 */
  | "comment"
  /** 属性带引号，但该字段没有被授权出现在这个属性上。 */
  | "attribute_not_permitted"
  /** 属性带引号且已授权，但变量没有独占整个属性值（存在拼接）。 */
  | "value_not_isolated";

export type HtmlInterpolationIssue = {
  readonly field: string;
  readonly reason: HtmlInterpolationReason;
  /** 涉及的属性名（小写），仅属性相关的原因携带。 */
  readonly attribute?: string;
  /** 涉及的标签名（小写），仅属性相关的原因携带。 */
  readonly tag?: string;
};

type Token = {
  readonly kind: "if" | "endif" | "field";
  readonly name: string;
  readonly length: number;
};

const IF_TOKEN = /^\{if\s+(\w+)\}/;
const ENDIF_TOKEN = /^\{endif\}/;
const FIELD_TOKEN = /^\{(\w+)\}/;

/** 三种 token 的顺序与 `render.ts` 的联合正则一致：`{endif}` 必须先于 `{\w+}` 判定。 */
function matchToken(source: string, at: number): Token | null {
  const rest = source.slice(at);

  const ifMatch = IF_TOKEN.exec(rest);
  if (ifMatch !== null) {
    return { kind: "if", name: ifMatch[1], length: ifMatch[0].length };
  }
  const endifMatch = ENDIF_TOKEN.exec(rest);
  if (endifMatch !== null) {
    return { kind: "endif", name: "", length: endifMatch[0].length };
  }
  const fieldMatch = FIELD_TOKEN.exec(rest);
  if (fieldMatch !== null) {
    return { kind: "field", name: fieldMatch[1], length: fieldMatch[0].length };
  }
  return null;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function isTagNameStart(char: string): boolean {
  return /[A-Za-z]/.test(char);
}

function isTagNameChar(char: string): boolean {
  return /[A-Za-z0-9:_-]/.test(char);
}

/**
 * 找到 raw text 元素（`script` / `style`）真正的结束边界。
 *
 * 🔴 **不能用「以 `</script` 开头」当边界。** 浏览器要求结束标签名之后紧跟
 * 空白、`/` 或 `>`，因此 `</scriptx>` **不是**结束标签——它仍然是脚本内容。
 * 若按前缀匹配提前退出 raw text，后面那段仍在可执行上下文里的文本会被当成普通
 * HTML 文本节点放行，等于绕过整个合同。
 *
 * 判不准时一律把 raw text 延伸到模板末尾（保守方向：多拒不漏）。名字末尾恰好到达
 * 模板结尾（`…</script` 后无字符）同样按未闭合处理。
 */
function findRawTextEnd(template: string, from: number, tagName: string): number {
  const lower = template.toLowerCase();
  const needle = `</${tagName}`;
  let cursor = from;

  while (cursor <= lower.length) {
    const found = lower.indexOf(needle, cursor);
    if (found === -1) return template.length;

    const after = lower[found + needle.length];
    if (after === ">" || after === "/" || (after !== undefined && isWhitespace(after))) {
      return found;
    }
    cursor = found + needle.length;
  }
  return template.length;
}

/**
 * 扫描正文模板，返回全部违反窄上下文合同的变量引用。
 *
 * 纯函数。空数组表示模板的每一处变量都落在文本节点或已授权的带引号属性值里。
 */
export function analyzeHtmlInterpolation(template: string): readonly HtmlInterpolationIssue[] {
  const issues: HtmlInterpolationIssue[] = [];
  const length = template.length;

  const report = (
    field: string,
    reason: HtmlInterpolationReason,
    attribute?: string,
    tag?: string,
  ) => {
    issues.push(
      Object.freeze({
        field,
        reason,
        ...(attribute === undefined ? {} : { attribute }),
        ...(tag === undefined ? {} : { tag }),
      }),
    );
  };

  /** 把 [from, to) 区间内的所有变量按同一原因记为违规（注释、script/style 块）。 */
  const reportRange = (from: number, to: number, reason: HtmlInterpolationReason) => {
    let cursor = from;
    while (cursor < to) {
      const token = matchToken(template, cursor);
      if (token !== null) {
        if (token.kind === "field") report(token.name, reason);
        cursor += token.length;
        continue;
      }
      cursor += 1;
    }
  };

  /** 带引号属性值的判定。`fields` 是该值内出现的全部变量。 */
  const classifyQuotedValue = (
    tagName: string,
    isClosingTag: boolean,
    attribute: string,
    fields: readonly string[],
    hasOtherContent: boolean,
  ) => {
    if (fields.length === 0) return;
    const tag = tagName.toLowerCase();
    const lower = attribute.toLowerCase();

    if (lower.startsWith("on")) {
      for (const field of fields) report(field, "event_attribute", lower, tag);
      return;
    }
    if (lower === "style") {
      for (const field of fields) report(field, "style_attribute", lower, tag);
      return;
    }
    // 变量必须独占整个属性值：拼接是 scheme 注入的唯一入口。
    if (fields.length > 1 || hasOtherContent) {
      for (const field of fields) report(field, "value_not_isolated", lower, tag);
      return;
    }
    const field = fields[0];
    const binding = getTemplateField(field)?.htmlBinding;
    // 🔴 标签与属性必须同时匹配；结束标签永不授权（浏览器丢弃其属性）。
    if (isClosingTag || binding === undefined || binding.tag !== tag || binding.attribute !== lower) {
      report(field, "attribute_not_permitted", lower, tag);
    }
  };

  let index = 0;
  while (index < length) {
    if (template.startsWith("<!--", index)) {
      const closeAt = template.indexOf("-->", index + 4);
      const stop = closeAt === -1 ? length : closeAt + 3;
      reportRange(index + 4, stop, "comment");
      index = stop;
      continue;
    }

    if (template[index] === "<") {
      let cursor = index + 1;
      const isClosing = template[cursor] === "/";
      if (isClosing) cursor += 1;

      const nameStartToken = matchToken(template, cursor);
      const startsWithField = nameStartToken !== null && nameStartToken.kind === "field";
      if (!startsWithField && (cursor >= length || !isTagNameStart(template[cursor]))) {
        // 不是标签起始，按普通文本处理这个 `<`。
        index += 1;
        continue;
      }

      // 标签名区域：任何变量都落在标签名位置。
      let tagName = "";
      while (cursor < length) {
        const token = matchToken(template, cursor);
        if (token !== null) {
          if (token.kind === "field") report(token.name, "tag_name");
          cursor += token.length;
          continue;
        }
        if (!isTagNameChar(template[cursor])) break;
        tagName += template[cursor];
        cursor += 1;
      }

      // 属性区域。
      while (cursor < length) {
        while (cursor < length && isWhitespace(template[cursor])) cursor += 1;
        if (cursor >= length) break;
        if (template.startsWith("/>", cursor)) {
          cursor += 2;
          break;
        }
        if (template[cursor] === ">") {
          cursor += 1;
          break;
        }

        // 属性名。
        let attribute = "";
        while (cursor < length) {
          const char = template[cursor];
          if (isWhitespace(char) || char === "=" || char === ">") break;
          if (template.startsWith("/>", cursor)) break;
          const token = matchToken(template, cursor);
          if (token !== null) {
            if (token.kind === "field") report(token.name, "attribute_name");
            cursor += token.length;
            continue;
          }
          attribute += char;
          cursor += 1;
        }

        while (cursor < length && isWhitespace(template[cursor])) cursor += 1;
        if (cursor >= length || template[cursor] !== "=") continue; // 布尔属性，无值。
        cursor += 1;
        while (cursor < length && isWhitespace(template[cursor])) cursor += 1;
        if (cursor >= length) break;

        const quote = template[cursor];
        if (quote === '"' || quote === "'") {
          cursor += 1;
          const fields: string[] = [];
          let hasOtherContent = false;
          while (cursor < length && template[cursor] !== quote) {
            const token = matchToken(template, cursor);
            if (token !== null) {
              // `{if}` / `{endif}` 出现在属性值里同样算拼接。
              if (token.kind === "field") fields.push(token.name);
              else hasOtherContent = true;
              cursor += token.length;
              continue;
            }
            hasOtherContent = true;
            cursor += 1;
          }
          if (cursor < length) cursor += 1; // 吃掉闭合引号。
          classifyQuotedValue(tagName, isClosing, attribute, fields, hasOtherContent);
          continue;
        }

        // 未加引号的属性值。
        while (cursor < length && !isWhitespace(template[cursor]) && template[cursor] !== ">") {
          const token = matchToken(template, cursor);
          if (token !== null) {
            if (token.kind === "field") {
              report(token.name, "unquoted_attribute", attribute.toLowerCase(), tagName.toLowerCase());
            }
            cursor += token.length;
            continue;
          }
          cursor += 1;
        }
      }

      index = cursor;

      // script / style 是 raw text 元素：里面的一切都不是 HTML 文本节点。
      // 🔴 不看标签是否写成 `/>` 的形式：HTML（非 XHTML）里 `<script/>` 并不自闭合，
      // 浏览器照样进入 raw text，跟着写的内容仍是脚本——所以属性解析阶段即使见到
      // `/>` 也只用来结束属性区域（见上方 `template.startsWith("/>", cursor)`），
      // 不会、也不该被这里拿来当"这个标签自闭合，不必进入 raw text"的信号。
      const lowerTag = tagName.toLowerCase();
      if (!isClosing && (lowerTag === "script" || lowerTag === "style")) {
        const stop = findRawTextEnd(template, index, lowerTag);
        reportRange(index, stop, lowerTag === "script" ? "script_block" : "style_block");
        index = stop;
      }
      continue;
    }

    // 文本节点：变量放行，条件 token 透明。
    const token = matchToken(template, index);
    index += token === null ? 1 : token.length;
  }

  return Object.freeze(issues);
}
