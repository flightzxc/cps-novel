import { describe, expect, it } from "vitest";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS } from "@/lib/locale/messages";

/**
 * 语言切换提示不得把书说成"剧/影片/剧集"（Owner 2026-09-30）。
 *
 * 背景：`localeSwitcher.fallbackToast`（书页专用）最初逐字照搬短剧站 CPS v8.5.1，
 * 而 CPS 在 zh-Hant / ru / vi 三个语种里说的是"剧/影片"（"此劇目"、"Этот сериал"、
 * "Tựa phim"），放在小说站上不对。Owner 拍板：把这个词换成"作品/书"
 * （现为"此作品"、"Эта книга"、"Cuốn sách này"）。本文件把"这两个键在 15 个语种里都不得
 * 出现表示剧/影片/剧集的词"固化成回归守卫，防止有人再从 CPS 原文整段搬回来。
 *
 * 文件末尾另有一组"语法守卫"（GPT 验收 2026-09-30）：`{locale}` 是目标语种的本语自称，
 * fr/ko/ru/cs/pl 若沿用 CPS 原句写法会出语法问题，守卫固化改后的写法。
 *
 * 覆盖的键：`fallbackToast`（书页）与 `fallbackToastPage`（其它页面），15 个语种全查。
 *
 * 词表按语种登记，每个词写明属于哪个语种；匹配方式按书写系统分两类，目的是**不误伤**
 * 其它语种/其它含义的普通词：
 *  - 子串匹配（`SUBSTRING_TERMS`）：中日泰文没有词边界、韩/俄/阿拉伯文的词尾/前缀会
 *    粘连助词（드라마는、сериала、المسلسل），越南语的"phim"是独立单音节词——这些语种
 *    里的剧词都很长或很特殊，子串命中就是真命中；
 *  - 整词匹配（`WHOLE_WORD_TERMS`）：拉丁字母语种一律按整词判（前后不得紧挨着任何
 *    字母），所以 pl 的"seria"（一批/一组，普通词）不会被 pl 的"serial"误伤，cs 的
 *    "titul"、pl 的"tytuł"（标题，中性词）本来就不在词表里。
 *
 * 刻意**没有**收进词表的普通词（会误伤"书"这个意思）：
 *  - th "หนัง"：泰语"หนังสือ"= 书，含"หนัง"子串，只登记"ละคร/ซีรีส์/ภาพยนตร์"；
 *  - es / pt-BR "novela"：西/葡语的"小说"，同时也指肥皂剧，属于"书"的合法说法；
 *  - ja/ko 的"作品/작품"、th 的"เรื่องนี้"、各语种的"title/标题"类词：中性，不判。
 */
const SUBSTRING_TERMS: Readonly<Partial<Record<SiteLocale, readonly string[]>>> = {
  // 劇（繁）= 劇目/電視劇/劇集，剧（简）同义；影片/電影/電視/影集 = 影片、电影、电视、剧集。
  "zh-Hant": ["劇", "剧", "影片", "電影", "電視", "影集"],
  // ドラマ = 电视剧；映画 = 电影；番組 = 节目。
  ja: ["ドラマ", "映画", "番組"],
  // 드라마 = 电视剧；영화 = 电影；시리즈 = 系列剧。
  ko: ["드라마", "영화", "시리즈"],
  // ละคร = 电视剧/戏剧；ซีรีส์ / ซีรีย์ = 系列剧（两种拼法）；ภาพยนตร์ = 电影。
  th: ["ละคร", "ซีรีส์", "ซีรีย์", "ภาพยนตร์"],
  // phim = 电影/影片；kịch = 戏剧/剧。
  vi: ["phim", "kịch"],
  // сериал = 连续剧；фильм = 电影；кино = 电影/影院；дорам / драм = 电视剧（дорама）/戏剧（драма）。
  ru: ["сериал", "фильм", "кино", "дорам", "драм"],
  // مسلسل = 连续剧/电视剧；فيلم / أفلام = 电影；دراما = 戏剧/电视剧。
  ar: ["مسلسل", "فيلم", "أفلام", "دراما"],
};

const WHOLE_WORD_TERMS: Readonly<Partial<Record<SiteLocale, readonly string[]>>> = {
  en: ["drama", "dramas", "series", "show", "shows", "film", "films", "movie", "movies", "episode", "episodes", "tv"],
  // Serie(n) = 剧/系列；Film(e) = 电影；Drama / Dramen = 戏剧/剧；Fernsehserie = 电视剧。
  de: ["serie", "serien", "film", "filme", "drama", "dramen", "fernsehserie"],
  // série(s) = 剧/系列；film(s) = 电影；drame = 戏剧/剧；feuilleton = 连续剧。
  fr: ["série", "séries", "film", "films", "drame", "feuilleton"],
  // serie(s) = 剧/系列；película(s) = 电影；drama = 剧；telenovela = 电视剧；dorama = 亚洲电视剧。
  es: ["serie", "series", "película", "películas", "drama", "telenovela", "dorama"],
  // série(s) = 剧/系列；filme(s) = 电影；drama = 剧；dorama = 亚洲电视剧。
  "pt-BR": ["série", "séries", "filme", "filmes", "drama", "dorama"],
  // serial = 连续剧；drama = 剧；film = 电影；sinetron = 电视剧。
  id: ["serial", "drama", "film", "sinetron"],
  // serial(e) = 连续剧；film(y) = 电影；dramat = 戏剧/剧。（"seria" 是普通词，不收。）
  pl: ["serial", "seriale", "film", "filmy", "dramat"],
  // seriál(y) / série = 连续剧/系列；film(y) = 电影；drama = 剧。
  cs: ["seriál", "seriály", "série", "film", "filmy", "drama"],
};

/**
 * 任务单指定的最低拒绝词表——每个词属于哪个语种在右边写明。词表 `SUBSTRING_TERMS` /
 * `WHOLE_WORD_TERMS` 被人删减时，这份清单会先红。
 */
const REQUIRED_TERMS: readonly { term: string; locale: SiteLocale; note: string }[] = [
  { term: "劇", locale: "zh-Hant", note: "繁体：劇目/電視劇/劇集" },
  { term: "剧", locale: "zh-Hant", note: "简体写法混入繁体目录也要拦" },
  { term: "сериал", locale: "ru", note: "俄语：连续剧" },
  { term: "фильм", locale: "ru", note: "俄语：电影" },
  { term: "phim", locale: "vi", note: "越南语：电影/影片" },
  { term: "drama", locale: "en", note: "英语：剧" },
  { term: "drama", locale: "de", note: "德语：剧" },
  { term: "drama", locale: "es", note: "西语：剧" },
  { term: "drama", locale: "pt-BR", note: "葡语：剧" },
  { term: "drama", locale: "id", note: "印尼语：剧" },
  { term: "drama", locale: "cs", note: "捷克语：剧" },
  { term: "série", locale: "fr", note: "法语：剧/系列" },
  { term: "série", locale: "pt-BR", note: "葡语：剧/系列" },
  { term: "série", locale: "cs", note: "捷克语：系列/连续剧" },
  { term: "serie", locale: "es", note: "西语：剧/系列" },
  { term: "serie", locale: "de", note: "德语：剧/系列" },
  { term: "serial", locale: "id", note: "印尼语：连续剧" },
  { term: "serial", locale: "pl", note: "波兰语：连续剧" },
  { term: "ละคร", locale: "th", note: "泰语：电视剧" },
  { term: "ドラマ", locale: "ja", note: "日语：电视剧" },
  { term: "드라마", locale: "ko", note: "韩语：电视剧" },
  { term: "مسلسل", locale: "ar", note: "阿拉伯语：连续剧" },
];

const TOAST_KEYS = ["fallbackToast", "fallbackToastPage"] as const;
type ToastKey = (typeof TOAST_KEYS)[number];

function toastOf(locale: SiteLocale, key: ToastKey): string {
  const value = (CATALOGS[locale] as unknown as { localeSwitcher: Record<string, unknown> }).localeSwitcher[key];
  if (typeof value !== "string") throw new Error(`${locale}.localeSwitcher.${key} 不是字符串`);
  return value;
}

function wholeWordRegex(term: string): RegExp {
  // 前后都不得紧挨着字母/组合记号——整词匹配，且对带重音的拉丁字母（série、película）成立。
  return new RegExp(`(?<![\\p{L}\\p{M}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{M}])`, "iu");
}

/** 返回该语种命中的剧词（空数组 = 干净）。 */
function dramaWordHits(locale: SiteLocale, text: string): string[] {
  const hits: string[] = [];
  const lowered = text.toLowerCase();
  for (const term of SUBSTRING_TERMS[locale] ?? []) {
    if (lowered.includes(term.toLowerCase())) hits.push(term);
  }
  for (const term of WHOLE_WORD_TERMS[locale] ?? []) {
    if (wholeWordRegex(term).test(text)) hits.push(term);
  }
  return hits;
}

describe("语言切换提示不得说“剧/影片/剧集”（Owner 2026-09-30）", () => {
  it("每个已登记语种都有词表（15 个语种全覆盖，没有语种被漏掉）", () => {
    for (const locale of SITE_LOCALES) {
      const total = (SUBSTRING_TERMS[locale]?.length ?? 0) + (WHOLE_WORD_TERMS[locale]?.length ?? 0);
      // ja/ko/th 等靠子串词表，en/de/fr… 靠整词词表；两张表合起来每个语种至少一个词。
      expect(total, `${locale} 没有登记任何剧词`).toBeGreaterThan(0);
    }
  });

  it.each(REQUIRED_TERMS)("最低词表：$locale 含“$term”（$note）", ({ term, locale }) => {
    const all = [...(SUBSTRING_TERMS[locale] ?? []), ...(WHOLE_WORD_TERMS[locale] ?? [])];
    expect(all).toContain(term);
  });

  describe.each(TOAST_KEYS)("localeSwitcher.%s", (key) => {
    it.each(SITE_LOCALES)("%s：译文不含剧/影片/剧集类词，且保留两处 {locale} 占位符", (locale) => {
      const value = toastOf(locale, key);
      expect(dramaWordHits(locale, value), `${locale}.${key} = ${value}`).toEqual([]);
      expect(value.split("{locale}").length - 1, `${locale}.${key} 的 {locale} 占位符应恰好两处`).toBe(2);
    });
  });

  it("金丝雀：每个语种的每个词表词塞回译文，判定都必须命中（证明守卫对该语种会响）", () => {
    for (const locale of SITE_LOCALES) {
      const terms = [...(SUBSTRING_TERMS[locale] ?? []), ...(WHOLE_WORD_TERMS[locale] ?? [])];
      for (const key of TOAST_KEYS) {
        const value = toastOf(locale, key);
        for (const term of terms) {
          expect(dramaWordHits(locale, `${value} ${term}`), `${locale}.${key} 塞回“${term}”没有命中`).toContain(term);
        }
      }
    }
  });

  it("回归：CPS v8.5.1 原文里三个“剧/影片”句子必须被判为命中（不得再整句搬回）", () => {
    expect(dramaWordHits("zh-Hant", "此劇目尚未提供{locale}版本，已切換至{locale}首頁。")).toContain("劇");
    expect(dramaWordHits("ru", "Этот сериал пока недоступен на {locale}. Открыта главная страница {locale}.")).toContain("сериал");
    expect(dramaWordHits("vi", "Tựa phim này chưa có bằng {locale}. Đã chuyển đến trang chủ {locale}.")).toContain("phim");
  });

  it("不误伤：整词匹配不会因为子串相似而误判普通词", () => {
    // pl "seria"（一批/一组）≠ "serial"；cs "titul"、pl "tytuł"（标题）是中性词；
    // th "หนังสือ"（书）含“หนัง”但不在词表里；es "novela"（小说）合法。
    expect(dramaWordHits("pl", "Ta seria książek. Ten tytuł.")).toEqual([]);
    expect(dramaWordHits("cs", "Tento titul zatím není dostupný.")).toEqual([]);
    expect(dramaWordHits("th", "หนังสือเล่มนี้ยังไม่มีในภาษานี้")).toEqual([]);
    expect(dramaWordHits("es", "Esta novela aún no está disponible.")).toEqual([]);
    expect(dramaWordHits("en", "Dramatic titles and showcase pages.")).toEqual([]);
    expect(dramaWordHits("de", "Diese Seriennummer ist unbekannt.")).toEqual([]);
  });
});

/**
 * 语法守卫（依据：第三方验收 GPT 2026-09-30 + Owner 同日拍板）。
 *
 * `{locale}` 运行时被替换成目标语种的本语自称（Français、한국어、Русский、繁體中文……）。
 * 自称本身不会随句子变格/变音，所以 CPS 原句"名词直接跟在介词/助词后"的写法在部分语种里
 * 语法不通：
 *  - fr：语种名前缺介词，须写 "page d'accueil en {locale}"；
 *  - ko：助词"로/으로"取决于前一个词是否以辅音收尾，自称无法判断，须写 "{locale} 버전으로"，
 *    不得再出现 "{locale}로"；
 *  - ru / cs / pl：自称无法变格，须用本语种的引号把 {locale} 整体包住
 *    （ru «…»，cs „…“，pl „…”）。
 * 两个键（书页 fallbackToast、其它页面 fallbackToastPage）都要满足。
 */
const GRAMMAR_KEYS = ["fallbackToast", "fallbackToastPage"] as const;

/** 本语种的引号对（码位写死，避免编辑器/复制把弯引号替换成直引号）。 */
const LOCALE_QUOTES: Readonly<Record<"ru" | "cs" | "pl", { open: string; close: string }>> = {
  ru: { open: "«", close: "»" }, // « »
  cs: { open: "„", close: "“" }, // „ “
  pl: { open: "„", close: "”" }, // „ ”
};

/** 返回 `{locale}` 出现次数，以及其中被本语种引号紧紧包住的次数。 */
function quotedLocaleCounts(locale: keyof typeof LOCALE_QUOTES, text: string): { total: number; quoted: number } {
  const { open, close } = LOCALE_QUOTES[locale];
  return {
    total: text.split("{locale}").length - 1,
    quoted: text.split(`${open}{locale}${close}`).length - 1,
  };
}

describe("语言切换提示的语法写法（GPT 验收 2026-09-30）", () => {
  describe.each(GRAMMAR_KEYS)("localeSwitcher.%s", (key) => {
    it("fr：含 “page d'accueil en {locale}”（语种名前要有介词 en）", () => {
      expect(toastOf("fr", key)).toContain("page d'accueil en {locale}");
    });

    it("ko：含 “{locale} 버전으로”，且不得出现 “{locale}로”（助词不能直接接语种自称）", () => {
      const value = toastOf("ko", key);
      expect(value).toContain("{locale} 버전으로");
      expect(value).not.toContain("{locale}로");
    });

    it.each(Object.keys(LOCALE_QUOTES) as (keyof typeof LOCALE_QUOTES)[])(
      "%s：两处 {locale} 都被本语种引号包住（自称无法变格）",
      (locale) => {
        const value = toastOf(locale, key);
        const { total, quoted } = quotedLocaleCounts(locale, value);
        expect(total, `${locale}.${key} = ${value}`).toBe(2);
        expect(quoted, `${locale}.${key} 的 {locale} 必须都被 ${LOCALE_QUOTES[locale].open}…${LOCALE_QUOTES[locale].close} 包住：${value}`).toBe(2);
      },
    );
  });

  it("金丝雀：CPS 原句写法与错位引号必须被判为不合格（证明上面的守卫会响）", () => {
    // ru：CPS 原句 "на {locale}" 没有引号；cs/pl：直接放在 "v jazyce / w języku" 后。
    expect(quotedLocaleCounts("ru", "Эта книга пока недоступна на {locale}. Открыта главная страница {locale}.")).toEqual({ total: 2, quoted: 0 });
    expect(quotedLocaleCounts("cs", "Tento titul zatím není dostupný v jazyce {locale}. Přepnuto na domovskou stránku {locale}.")).toEqual({ total: 2, quoted: 0 });
    expect(quotedLocaleCounts("pl", "Ten tytuł nie jest jeszcze dostępny w języku {locale}. Przełączono na stronę główną {locale}.")).toEqual({ total: 2, quoted: 0 });
    // 只包一处、或用了别的语种的引号，都不算。
    expect(quotedLocaleCounts("ru", "на языке «{locale}». на языке {locale}.")).toEqual({ total: 2, quoted: 1 });
    expect(quotedLocaleCounts("cs", "v jazyce „{locale}”")).toEqual({ total: 1, quoted: 0 }); // 用了 pl 的收引号 ”
    expect(quotedLocaleCounts("pl", "w języku „{locale}“")).toEqual({ total: 1, quoted: 0 }); // 用了 cs 的收引号 “
    // fr / ko：CPS 原句写法不含守卫要求的片段。
    expect("Passage à la page d'accueil {locale}.").not.toContain("page d'accueil en {locale}");
    expect("이 작품은 아직 {locale}로 제공되지 않습니다.").not.toContain("{locale} 버전으로");
    expect("이 작품은 아직 {locale}로 제공되지 않습니다.").toContain("{locale}로");
  });
});
