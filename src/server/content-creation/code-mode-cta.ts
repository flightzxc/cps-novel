/**
 * 口令码模式剧场（PlotNovel）的文章号召文案（v0.6.0，开发单 F.4）。
 *
 * 文章正文里固化的号召链接仍然是 `/go/<站内码>`——与 link 模式完全相同，口令码本身绝不进正文。模板里这条链接的
 * 文字（默认模板是 "Start Reading"）是运营写在模板里的字面量；口令码模式的书读者点进去先到中间页拿口令码、再去 App 里读，
 * "Start Reading" 说得不准。所以**只在口令码模式下**，把指向 `/go/<站内码>` 的号召链接文字换成英文
 * "Read on {App} App"（与书页按钮同一句，来自 `code-mode-copy.ts`），其它一切（模板、其它链接、SEO 字段）原样。
 *
 * 为什么是渲染之后的替换，而不是改模板：模板是后台数据（`article_template` 行，每语种一份，运营可编辑），
 * 改它要升版本、要翻译；而模板引擎对号召链接有硬约束——`href` 只能是 `{promo_redirect_url}` 整值（`html.ts`），
 * 所以渲染产物里指向站内跳转入口的 `<a href="/go/<码>">…</a>` 形状是确定的，替换它的文字既精确又不碰别的链接。
 *
 * 文案是英语（Owner 拍板："用英文"）。口令码模式只对英语书生效（`codeModeLocales`），已知限制见 ADR-V060。
 */
import { codeModeCopy } from "@/lib/locale/code-mode-copy";
import { codeModeAppName, isCodeModeTheater, parseTheaterPromoConfig } from "@/server/publication/theater-promo-mode";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把指向 `redirectPath` 的号召链接文字换成 `label`。没有这样的链接时原样返回。 */
export function replaceRedirectAnchorLabel(body: string, redirectPath: string, label: string): string {
  const pattern = new RegExp(`(<a\\b[^>]*\\bhref="${escapeRegExp(redirectPath)}"[^>]*>)[\\s\\S]*?(</a>)`, "gi");
  return body.replace(pattern, (_match, open: string, close: string) => `${open}${escapeHtml(label)}${close}`);
}

/**
 * 渲染产物 → 按推广所属剧场调整号召文案。link 模式（含剧场信息缺失）原样返回同一个对象。
 */
export function applyCodeModeArticleCta<T extends { readonly body: string }>(
  draft: T,
  input: { readonly redirectPath: string | undefined; readonly theaterConfig: unknown },
): T {
  if (!input.redirectPath || !isCodeModeTheater(input.theaterConfig)) return draft;
  const appName = codeModeAppName(parseTheaterPromoConfig(input.theaterConfig));
  const body = replaceRedirectAnchorLabel(draft.body, input.redirectPath, codeModeCopy(appName).readOnApp);
  return body === draft.body ? draft : { ...draft, body };
}
