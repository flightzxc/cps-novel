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
 * **B. 明确批准的、带引号的属性值**——由登记表的 `htmlAttribute` 逐字段授权，
 * 当前只有两条：`promo_redirect_url → href`、`cover_url → src`。
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
 * 扫描正文模板，返回全部违反窄上下文合同的变量引用。
 *
 * 纯函数。空数组表示模板的每一处变量都落在文本节点或已授权的带引号属性值里。
 */
export function analyzeHtmlInterpolation(template: string): readonly HtmlInterpolationIssue[] {
  const issues: HtmlInterpolationIssue[] = [];
  const length = template.length;

  const report = (field: string, reason: HtmlInterpolationReason, attribute?: string) => {
    issues.push(
      Object.freeze(
        attribute === undefined ? { field, reason } : { field, reason, attribute },
      ),
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
    attribute: string,
    fields: readonly string[],
    hasOtherContent: boolean,
  ) => {
    if (fields.length === 0) return;
    const lower = attribute.toLowerCase();

    if (lower.startsWith("on")) {
      for (const field of fields) report(field, "event_attribute", lower);
      return;
    }
    if (lower === "style") {
      for (const field of fields) report(field, "style_attribute", lower);
      return;
    }
    // 变量必须独占整个属性值：拼接是 scheme 注入的唯一入口。
    if (fields.length > 1 || hasOtherContent) {
      for (const field of fields) report(field, "value_not_isolated", lower);
      return;
    }
    const field = fields[0];
    const definition = getTemplateField(field);
    if (definition === null || definition.htmlAttribute !== lower) {
      report(field, "attribute_not_permitted", lower);
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
      let selfClosing = false;
      while (cursor < length) {
        while (cursor < length && isWhitespace(template[cursor])) cursor += 1;
        if (cursor >= length) break;
        if (template.startsWith("/>", cursor)) {
          cursor += 2;
          selfClosing = true;
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
          classifyQuotedValue(attribute, fields, hasOtherContent);
          continue;
        }

        // 未加引号的属性值。
        while (cursor < length && !isWhitespace(template[cursor]) && template[cursor] !== ">") {
          const token = matchToken(template, cursor);
          if (token !== null) {
            if (token.kind === "field") report(token.name, "unquoted_attribute", attribute.toLowerCase());
            cursor += token.length;
            continue;
          }
          cursor += 1;
        }
      }

      index = cursor;

      // script / style 是 raw text 元素：里面的一切都不是 HTML 文本节点。
      const lowerTag = tagName.toLowerCase();
      if (!isClosing && !selfClosing && (lowerTag === "script" || lowerTag === "style")) {
        const closeAt = template.toLowerCase().indexOf(`</${lowerTag}`, index);
        const stop = closeAt === -1 ? length : closeAt;
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
