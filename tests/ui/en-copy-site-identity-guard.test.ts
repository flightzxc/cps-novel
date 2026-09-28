import { describe, expect, it } from "vitest";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS } from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";

/**
 * C（Owner 2026-09-29 拍板"按运营原文做"）守卫：`en` 目录（公开文案的英文
 * 原文，其它 14 语种由后续翻译单处理）里不得出现"本网站/this site"、
 * "原网站/原平台/original platform/source platform"、"预览/preview"及同义
 * 表述——按本站就是官方站点处理，不做"本站只是导流入口"的声明。
 *
 * 新增用例（交接文档"测试与门禁"一节要求）。变异①：给任意一个键的值加回
 * "this site" 必须让这条用例变红，证明它真的在守——见交接回报里的变异记录。
 *
 * 允许的例外逐条登记，且必须附理由——不是随手加白名单：目前没有例外。
 * 任何新增的含"preview"字样的键都应该先看是不是真的要面向用户展示"预览"
 * 这个概念，还是可以换一种不提它的说法（参照本轮 A3/C 的处理方式）。
 */
const ALLOWED_EXCEPTIONS: ReadonlySet<string> = new Set([]);

const BANNED_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "this site", pattern: /this site/i },
  { name: "original platform", pattern: /original platform/i },
  { name: "source platform", pattern: /source platform/i },
  { name: "preview", pattern: /preview/i },
];

/**
 * 运营前端与 SEO 优化第一轮翻译收尾（2026-09-29）：把同一条守卫扩展到
 * `SITE_LOCALES` 里全部 14 个非英文语种。禁用词表直接来自 A/B/C 三组翻译时
 * 各自产出的禁用词表（`.tmp/i18n/group-{a,b,c}-banned.txt`，翻译期间的临时
 * 产物，不入库——本文件把内容原样固化下来，作为可长期回归的门禁数据，不是
 * 重新拟定的词表）：
 *  - A 组（ko/ja/zh-Hant/th/vi）：`group-a-banned.txt`
 *  - B 组（es/fr/de/pt-BR/id）：`group-b-banned.txt`
 *  - C 组（ru/pl/cs/ar）：`group-c-banned.txt`
 *
 * 检查范围与上面的英文守卫一致：该语种目录里全部公开文案的字符串值，
 * 大小写不敏感（CJK/泰文/阿拉伯文没有大小写概念，`.toLowerCase()` 对它们是
 * 无操作，不影响判定）。用词表里的原始词做子串匹配，不做分词/词形归并——
 * 与英文守卫的整词正则一样，只是这里的"词"由母语者给定，不是这份测试自己
 * 猜的。
 */
const NON_EN_BANNED_TERMS: Readonly<Record<Exclude<SiteLocale, "en">, readonly string[]>> = {
  ko: ["이 사이트", "본 사이트", "당사이트", "원작 플랫폼", "원본 플랫폼", "원문 플랫폼", "미리보기", "프리뷰", "시험판"],
  ja: ["本サイト", "当サイト", "このサイト", "原作プラットフォーム", "元のプラットフォーム", "試し読み", "試読", "プレビュー"],
  "zh-Hant": ["本站", "本網站", "本平台", "原始平台", "原平台", "原網站", "試讀", "預覽"],
  th: ["เว็บไซต์นี้", "เว็บนี้", "แพลตฟอร์มต้นฉบับ", "แพลตฟอร์มต้นทาง", "ตัวอย่าง", "พรีวิว"],
  vi: ["trang này", "trang web này", "nền tảng gốc", "nền tảng ban đầu", "xem trước", "bản xem trước", "bản dùng thử", "bản demo"],
  es: ["este sitio", "plataforma original", "vista previa", "avance"],
  fr: ["ce site", "plateforme d'origine", "aperçu"],
  de: ["diese Website", "Originalplattform", "Vorschau", "Leseprobe"],
  "pt-BR": ["este site", "plataforma original", "prévia"],
  id: ["situs ini", "platform asli", "pratinjau"],
  ru: ["этот сайт", "оригинальная платформа", "предпросмотр", "ознакомительный фрагмент"],
  pl: ["ta strona", "oryginalna platforma", "podgląd", "zapowiedź"],
  cs: ["tento web", "původní platforma", "náhled", "ukázka"],
  ar: ["هذا الموقع", "المنصة الأصلية", "معاينة"],
};

/**
 * 非英文语种的例外清单，作用域是 `locale:key`（与
 * `tests/ui/messages-completeness.test.ts` 的 `ALLOW_SAME_AS_EN_SCOPED` 同一
 * 记法）。每条都必须是"字面重合、上下文里意思无关"——真的在表达"本站/原
 * 平台/预览"含义的命中不登记在这里，交主控裁决是否要改译文（见下面
 * `PENDING_OWNER_REVIEW_SCOPED`）。
 *
 * 首次全量扫描（2026-09-29，翻译收尾）命中 3 处字面重合，均为该语种的
 * "this page"（英文原文 `errorPage.body`/`notFoundPage.title`/
 * `notFoundPage.body` 本身就是 "This page could not be loaded"/"This page
 * could not be found"/"this page is no longer here"）与禁用词表里的
 * "这个网站/这个页面"类词形撞了字面：
 *
 *  - `vi:errorPage.body` / `vi:notFoundPage.title` / `vi:notFoundPage.body`：
 *    越南语"trang này"= "this page"（通用"本页"，不是"trang web này"=
 *    "this website"），三处都是对英文原文里"this page"的直译，不是站点/
 *    平台身份声明。
 *  - `pl:notFoundPage.body`：波兰语"ta strona"在这里同样是"this page"
 *    （"strona"本义就是"页面"），对应英文原文"this page is no longer
 *    here"，同样不是站点/平台身份声明。
 */
const ALLOWED_EXCEPTIONS_SCOPED: ReadonlySet<string> = new Set([
  "vi:errorPage.body",
  "vi:notFoundPage.title",
  "vi:notFoundPage.body",
  "pl:notFoundPage.body",
]);

/**
 * 真的命中"本站/原平台/预览"含义、但落在这次翻译单 27 个键（17 个既有键 +
 * 10 个新键）之外的条目——按交接指令"不要自己改译文，在回报里列出来，由
 * 主控决定"，这里只做登记，不改动任何语种文件。用独立于
 * `ALLOWED_EXCEPTIONS_SCOPED` 的集合存放，是为了不把"待裁决"和"字面重合、
 * 已确认无关"这两类性质完全不同的条目混在一起——前者仍然可能需要改译文，
 * 只是不该在这条收尾单里顺手改掉。
 *
 * 曾登记 `ja:nav.about`："このサイトについて"= "About this site"，字面含
 * "このサイト"（this site），且不在本轮 27 个键清单里。主控裁决
 * （2026-09-29）：按 Owner 规则改掉，已改为"私たちについて"（与
 * zh-Hant「關於我們」/ de「Über uns」同一处理方式），不再含禁用词，条目已
 * 从这里移除，回到正常断言覆盖。当前无待裁决条目。
 */
const PENDING_OWNER_REVIEW_SCOPED: ReadonlySet<string> = new Set([]);

function flattenLeaves(node: unknown, prefix: string[] = []): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      for (const [path, leaf] of flattenLeaves(value, [...prefix, key])) {
        out.set(path, leaf);
      }
    }
    return out;
  }
  out.set(prefix.join("."), node);
  return out;
}

const NON_EN_LOCALES = SITE_LOCALES.filter((locale): locale is Exclude<SiteLocale, "en"> => locale !== "en");

describe("en 公开文案守卫 · 不提本站/原平台/预览（C，Owner 2026-09-29）", () => {
  it("每一条英文文案都不含 this site / original platform / source platform / preview（大小写不敏感）", () => {
    const leaves = flattenLeaves(en);
    const offenders: string[] = [];
    for (const [key, value] of leaves) {
      if (typeof value !== "string") continue;
      if (ALLOWED_EXCEPTIONS.has(key)) continue;
      for (const { name, pattern } of BANNED_PATTERNS) {
        if (pattern.test(value)) {
          offenders.push(`${key}: contains "${name}" — "${value}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("允许例外清单本身没有游离条目——每个例外键必须真的存在于 en 目录里", () => {
    const leaves = flattenLeaves(en);
    for (const key of ALLOWED_EXCEPTIONS) {
      expect(leaves.has(key), `${key} 不是 en 目录里的真实键`).toBe(true);
    }
  });
});

describe("非英文语种公开文案守卫 · 不提本站/原平台/预览（翻译收尾，2026-09-29）", () => {
  for (const locale of NON_EN_LOCALES) {
    const terms = NON_EN_BANNED_TERMS[locale];

    it(`${locale}: 每一条译文都不含该语种登记的禁用词（大小写不敏感）`, () => {
      const leaves = flattenLeaves(CATALOGS[locale]);
      const offenders: string[] = [];
      for (const [key, value] of leaves) {
        if (typeof value !== "string") continue;
        const scoped = `${locale}:${key}`;
        if (ALLOWED_EXCEPTIONS_SCOPED.has(scoped)) continue;
        if (PENDING_OWNER_REVIEW_SCOPED.has(scoped)) continue;
        const lowered = value.toLowerCase();
        for (const term of terms) {
          if (lowered.includes(term.toLowerCase())) {
            offenders.push(`${key}: contains "${term}" — "${value}"`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("非英文语种例外清单（含待主控裁决清单）本身没有游离条目——每个键必须真的存在于对应语种目录里", () => {
    for (const scoped of [...ALLOWED_EXCEPTIONS_SCOPED, ...PENDING_OWNER_REVIEW_SCOPED]) {
      const [locale, ...keyParts] = scoped.split(":");
      const key = keyParts.join(":");
      const leaves = flattenLeaves(CATALOGS[locale as SiteLocale]);
      expect(leaves.has(key), `${scoped} 不是 ${locale} 目录里的真实键`).toBe(true);
    }
  });
});
