/**
 * Yandex 站长验证码与 Metrica 计数器（运营 V2 需求，Owner 2026-09-30；无 CPS 对应，
 * NOVEL_ONLY）。
 *
 * 两个值都来自后台"站点设置"，保存时在 `src/server/site-settings/service.ts` 校验，
 * **渲染时再校验一次**——库里的值理论上只可能是合法值，但它们会被拼进内联脚本 /
 * 属性，这里不信任"保存时校验过"这一句话（直接改库、旧数据、未来别的写入口都会绕过
 * 保存校验），不合法就不输出，宁可少一段统计代码也不把未校验的字符串拼进页面。
 */

/** 验证码：字母、数字、下划线、短横线，1～255 位。 */
export const YANDEX_VERIFICATION_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** Metrica 计数器 ID：只允许 1～12 位数字。 */
export const YANDEX_METRICA_ID_RE = /^[0-9]{1,12}$/;

/** 返回去掉首尾空白后的合法验证码；空或含非法字符返回 null。 */
export function normalizeYandexVerification(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return YANDEX_VERIFICATION_RE.test(trimmed) ? trimmed : null;
}

/**
 * 渲染时使用：返回合法的纯数字计数器 ID；空、含非数字字符、超长一律返回 null
 * （调用方据此什么都不输出）。
 */
export function normalizeYandexMetricaId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return YANDEX_METRICA_ID_RE.test(trimmed) ? trimmed : null;
}

/**
 * 运营提供的 Yandex 官方统计代码，`<ID>` 之外一个字符都不改（含缩进与换行）。
 * ID 不是纯数字时返回 null。
 */
export function buildYandexMetricaScript(id: string): string | null {
  const safeId = normalizeYandexMetricaId(id);
  if (!safeId) return null;
  return [
    "(function(m,e,t,r,i,k,a){",
    "    m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};",
    "    m[i].l=1*new Date();",
    "    for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}",
    "    k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)",
    `})(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=${safeId}', 'ym');`,
    `ym(${safeId}, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});`,
  ].join("\n");
}

/**
 * `<noscript>` 里的像素图，与运营给的原文逐字一致。ID 不是纯数字时返回 null。
 * 放在 `<body>` 开头：`<div>` 在 `<head>` 里不是合法 HTML，浏览器会把它挪走。
 */
export function buildYandexMetricaNoscriptHtml(id: string): string | null {
  const safeId = normalizeYandexMetricaId(id);
  if (!safeId) return null;
  return `<div><img src="https://mc.yandex.ru/watch/${safeId}" style="position:absolute; left:-9999px;" alt="" /></div>`;
}
