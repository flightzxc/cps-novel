/**
 * 翻页后缀（TKD 对齐 CPS，Owner 2026-09-30）：分类页、浏览页、博客列表页从第 2 页
 * 起，标题末尾加本地化的翻页后缀（英文 ` - Page 2`），品牌后缀仍由根布局的标题模板
 * 加。后缀文案走文案目录的 `meta.pageSuffix`（15 语），不像 CPS 博客列表那样把
 * ` - Page` 写死成英文。
 *
 * 第 1 页不加后缀。与 CPS 一致：翻页后缀只进 `<title>`/og:title/twitter:title，
 * 不进结构化数据（JSON-LD 不动）。
 */
import type { Translator } from "@/lib/locale/messages";

export function pageSuffixFor(page: number | undefined, t: Translator): string {
  return page !== undefined && page >= 2 ? t("meta.pageSuffix", { page }) : "";
}

export function withPageSuffix(title: string, page: number | undefined, t: Translator): string {
  return `${title}${pageSuffixFor(page, t)}`;
}
