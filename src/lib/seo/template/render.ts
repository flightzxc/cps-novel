/**
 * 模板引擎核心（P2-02）。
 *
 * 模板语言逐字照搬 CPS `src/lib/template-engine.ts:166-221`：
 *
 * 1. 变量替换 `{field_name}`；
 * 2. 条件渲染 `{if field_name}…{endif}`，字段有值渲染块内容、否则整块移除；
 * 3. 条件块可嵌套；
 * 4. **先消解条件、再替换变量**——因此变量的取值里即便含 `{if …}` 也不会被当成语法，
 *    且替换是一次性的，取值里的 `{novel_title}` 不会被二次展开。
 *
 * 没有 else、没有循环、没有 `a.b.c` 嵌套路径、没有 filter、没有转义语法——CPS 没有，
 * 这里也不加。**不为了「设计得更优雅」重造模板语言。** 搬运登记见
 * `docs/governance/port-registry.md`。
 *
 * ## 与 CPS 的分歧一：默认严格
 *
 * CPS 只有 slug 一个槽位严格（`renderSlugTemplate`），其余走宽松模式：已登记字段
 * 缺值静默渲染成空串，未登记字段原样把 `{author}` 透出到线上。小说侧
 * `src/lib/seo/README.md` 写死「渲染期缺值 fail-closed（抛错），不 fail-open 成空
 * 字符串」，所以这里**全槽位严格**：
 *
 * - 未登记字段（无论出现在变量位还是条件位）→ `ERR_TEMPLATE_FIELD_NOT_REGISTERED`；
 * - 已登记字段渲染期无取值 → `ERR_TEMPLATE_VAR_EMPTY`；
 * - `{if}` / `{endif}` 不配对 → `ERR_TEMPLATE_SYNTAX`（CPS 会把它当文本泄漏出去）。
 *
 * 可空字段的正确写法是条件块：取值表恒含全部登记键，缺失的填 `""`，于是
 * `{cover_url}` 抛错而 `{if cover_url}…{endif}` 安静地移除整块。
 *
 * ## 与 CPS 的分歧二：嵌套条件改成深度配对扫描
 *
 * 🔴 CPS 的消解方式是「非贪婪正则 + 不动点重扫」（`src/lib/template-engine.ts:180-194`），
 * 它在**外层条件为假**时会算错。实测（模板 `A{if a}B{if b}C{endif}D{endif}E`）：
 *
 * | a | b | CPS 产物 |
 * | --- | --- | --- |
 * | 真 | 真 | `ABCDE` ✅ |
 * | 真 | 假 | `ABE` ✅ |
 * | **假** | 真 | `AD{endif}E` ❌ |
 * | **假** | 假 | `AD{endif}E` ❌ |
 *
 * 原因是正则从**外层** `{if a}` 起匹配，惰性量词吃到的是**内层**的 `{endif}`，于是
 * 外层块被误判成 `{if a}B{if b}C{endif}`，剩下 `D{endif}` 原地留下。CPS 侧这条路径
 * 没有任何测试覆盖（全仓测试里搜不到 `{if `），线上没炸只是因为没人写嵌套模板。
 *
 * 这里改用按 token 顺序的深度配对扫描。**模板语言本身没变**（还是 `{if x}…{endif}`
 * 加嵌套），变的只是消解算法——照搬一个会把 `{endif}` 泄漏进 `Article.body` 的实现，
 * 正是本项目 fail-closed 纪律要防的那类事故。
 */

import {
  ERR_TEMPLATE_FIELD_NOT_REGISTERED,
  ERR_TEMPLATE_SYNTAX,
  ERR_TEMPLATE_VALUE_INVALID,
  ERR_TEMPLATE_VAR_EMPTY,
  TemplateRenderError,
} from "./errors";
import { getTemplateField, isRegisteredTemplateField, type TemplateFieldKey } from "./fields";
import type { NovelTemplateValues } from "./values";

/**
 * 词法扫描用的联合正则。三个分支的顺序是承重的：`{endif}` 必须排在 `{(\w+)}` 前面，
 * 否则 `endif` 会被当成一个普通变量名（它确实匹配 `\w+`）。
 * 两个分支的写法与 CPS 的两条正则一致：`\{if\s+(\w+)\}` 与 `\{(\w+)\}`。
 */
const TOKEN_PATTERN = /\{if\s+(\w+)\}|\{endif\}|\{(\w+)\}/g;

/** 变量正则，逐字照搬 CPS `src/lib/template-engine.ts:199`。 */
const VARIABLE_PATTERN = /\{(\w+)\}/g;

/**
 * `url` 类字段的取值形态。只认 http/https 绝对地址，且不含空白与引号/尖括号/反引号——
 * 后者是为了在属性上下文里也无法逃逸。`javascript:`、相对路径、协议相对 `//host`
 * 一律不认。CPS 没有这层校验，它把 `coverUrl` 直接拼进 `<img src="…">`。
 */
const ABSOLUTE_HTTP_URL = /^https?:\/\/[^\s"'<>`]+$/;

/**
 * 模板静态分析结论。供后台保存路径在**写入前**判定模板本身是否可用。
 *
 * 两档严重程度：
 *
 * - **硬拒绝**——`syntaxIssue !== null` 或 `unregisteredFields` 非空。这两类模板对
 *   任何数据都渲不出东西，保存即是留雷。
 * - **告警**——`unguardedOptionalFields` 非空。模板本身合法，但引用了可空字段又没用
 *   条件块包住，于是「缺该值的那些小说」会在渲染期抛 `ERR_TEMPLATE_VAR_EMPTY`。
 *   这一档是把渲染期 fail-closed 的代价提前暴露给模板作者，而不是等批量生成时逐条失败。
 */
export type TemplateAnalysis = {
  /** 模板引用到的已登记字段，按首次出现顺序去重。 */
  readonly referencedFields: readonly TemplateFieldKey[];
  /** 模板引用到的未登记名字，按首次出现顺序去重。非空即应拒绝保存。 */
  readonly unregisteredFields: readonly string[];
  /** 被裸引用（外层没有同名 `{if}` 包裹）的可空字段，按首次出现顺序去重。 */
  readonly unguardedOptionalFields: readonly TemplateFieldKey[];
  /** 语法问题；`null` 表示 `{if}` / `{endif}` 配对正确。 */
  readonly syntaxIssue: "unclosed_if" | "unexpected_endif" | null;
};

export type RenderSlotOptions = {
  /** 槽位名，只用于错误定位。 */
  readonly slot: string;
  /** 是否对**被插入的取值**做 HTML 实体转义。正文槽位为 `true`。 */
  readonly escapeValues: boolean;
  readonly templateKey?: string;
  readonly novelId?: string;
};

/**
 * HTML 文本转义。
 *
 * `&` 必须最先替换，否则会把后续替换产生的实体二次转义。同时转义单双引号，
 * 使取值放进属性位置（如 `href="{promo_redirect_url}"`）也无法逃逸。
 */
export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * 纯静态分析：只看模板文本，不看取值。
 *
 * 后台保存模板时先跑这个——`{author}` 在保存那一刻就应该被拒绝，而不是等到批量
 * 生成时才逐条失败。CPS 对应位置（`src/components/templates/template-form.tsx:99-115`）
 * 只弹一条黄色告警、仍然允许保存，本项目把它做成可硬拦截的纯函数。
 */
export function analyzeTemplate(template: string): TemplateAnalysis {
  const referenced: TemplateFieldKey[] = [];
  const unregistered: string[] = [];
  const unguarded: TemplateFieldKey[] = [];
  const seenReferenced = new Set<string>();
  const seenUnregistered = new Set<string>();
  const seenUnguarded = new Set<string>();

  /** 当前所在条件块的字段名，由内到外。用于判断可空字段是否被同名 `{if}` 包住。 */
  const openConditions: string[] = [];
  let syntaxIssue: TemplateAnalysis["syntaxIssue"] = null;

  const collect = (name: string) => {
    if (!isRegisteredTemplateField(name)) {
      if (!seenUnregistered.has(name)) {
        seenUnregistered.add(name);
        unregistered.push(name);
      }
      return;
    }
    if (!seenReferenced.has(name)) {
      seenReferenced.add(name);
      referenced.push(name);
    }
  };

  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(template)) !== null) {
    const conditionField = match[1];
    const variableField = match[2];

    if (conditionField !== undefined) {
      openConditions.push(conditionField);
      collect(conditionField);
      continue;
    }
    if (variableField !== undefined) {
      collect(variableField);
      const definition = getTemplateField(variableField);
      if (
        definition !== null &&
        !definition.required &&
        !openConditions.includes(definition.key) &&
        !seenUnguarded.has(definition.key)
      ) {
        seenUnguarded.add(definition.key);
        unguarded.push(definition.key as TemplateFieldKey);
      }
      continue;
    }

    // 剩下的唯一可能是 {endif}。
    if (openConditions.pop() === undefined && syntaxIssue === null) {
      syntaxIssue = "unexpected_endif";
    }
  }

  if (syntaxIssue === null && openConditions.length > 0) {
    syntaxIssue = "unclosed_if";
  }

  return Object.freeze({
    referencedFields: Object.freeze(referenced),
    unregisteredFields: Object.freeze(unregistered),
    unguardedOptionalFields: Object.freeze(unguarded),
    syntaxIssue,
  });
}

/**
 * 消解条件块，保留变量占位符原样（变量替换是下一步的事）。
 *
 * 按 token 顺序单遍扫描，用一个帧栈做深度配对：每遇 `{if f}` 压一帧并记下该帧是否
 * 保留，遇 `{endif}` 弹帧、按保留标记决定是否把该帧内容并回父帧。调用前必须已经
 * 通过 `analyzeTemplate` 的配对校验，因此栈不会失衡。
 */
function collapseConditionals(
  template: string,
  isFieldTruthy: (field: string) => boolean,
): string {
  const stack: Array<{ buffer: string; keep: boolean }> = [{ buffer: "", keep: true }];
  let cursor = 0;

  const current = () => stack[stack.length - 1];

  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(template)) !== null) {
    const frame = current();
    frame.buffer += template.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    const conditionField = match[1];
    if (conditionField !== undefined) {
      stack.push({ buffer: "", keep: isFieldTruthy(conditionField) });
      continue;
    }
    if (match[2] !== undefined) {
      // 变量占位符原样留到 Step 2，条件消解期不做任何替换。
      frame.buffer += match[0];
      continue;
    }

    // {endif}：弹帧，按保留标记并回父帧。
    const closed = stack.pop();
    if (closed !== undefined && closed.keep) {
      current().buffer += closed.buffer;
    }
  }

  const root = current();
  root.buffer += template.slice(cursor);
  return root.buffer;
}

/**
 * 渲染一个槽位。
 *
 * 纯函数：不读数据库、不发请求、不读环境变量、不碰 React/DOM、不取当前时间，
 * 相同输入恒等输出。
 *
 * 失败顺序是确定的：先模板层（语法 → 未登记字段），再数据层（缺值 → 取值非法）。
 * 因此一个写了 `{author}` 的模板无论配什么数据都会被同一个码拒绝。
 */
export function renderTemplateSlot(
  template: string,
  values: NovelTemplateValues,
  options: RenderSlotOptions,
): string {
  const locate = (field?: string) => ({
    slot: options.slot,
    ...(field === undefined ? {} : { field }),
    ...(options.templateKey === undefined ? {} : { templateKey: options.templateKey }),
    ...(options.novelId === undefined ? {} : { novelId: options.novelId }),
  });

  const analysis = analyzeTemplate(template);
  if (analysis.syntaxIssue !== null) {
    throw new TemplateRenderError(ERR_TEMPLATE_SYNTAX, {
      ...locate(),
      constraint: analysis.syntaxIssue,
    });
  }
  if (analysis.unregisteredFields.length > 0) {
    throw new TemplateRenderError(
      ERR_TEMPLATE_FIELD_NOT_REGISTERED,
      locate(analysis.unregisteredFields[0]),
    );
  }

  // Step 1：消解条件块。
  // CPS 口径：非 undefined、非空串、非 "0" 才渲染块内容。额外先 trim——纯空白与空串
  // 在 fail-closed 语义下是同一件事，也与 PostgreSQL 的 btrim(body) <> '' 保持一致。
  const collapsed = collapseConditionals(template, (field) => {
    const value = values.get(field as TemplateFieldKey);
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized !== "" && normalized !== "0";
  });

  // Step 2：一次性替换变量。替换结果不会被再次扫描，取值里的 `{x}` 不会二次展开。
  return collapsed.replace(VARIABLE_PATTERN, (_full, field: string) => {
    // 先查登记表再查取值表：这个顺序是承重的，`{constructor}` 之类的名字必须在这里
    // 被挡下，绝不能拿去索引任何对象。
    const definition = getTemplateField(field);
    if (definition === null) {
      throw new TemplateRenderError(ERR_TEMPLATE_FIELD_NOT_REGISTERED, locate(field));
    }

    const value = values.get(definition.key as TemplateFieldKey);
    if (typeof value !== "string" || value.trim() === "") {
      throw new TemplateRenderError(ERR_TEMPLATE_VAR_EMPTY, locate(field));
    }

    if (definition.kind === "url" && !ABSOLUTE_HTTP_URL.test(value)) {
      throw new TemplateRenderError(ERR_TEMPLATE_VALUE_INVALID, locate(field));
    }

    return options.escapeValues ? escapeHtmlText(value) : value;
  });
}
