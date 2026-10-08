/**
 * 文章网址名「过短才补一个本地化词」（Owner 2026-10-08 拍板的规则变更）。
 *
 * 开发单：`开发单_Sonnet_文章网址过短追加本地化词_2026-10-08.md` 附录 A。
 * 规则编号对应开发单第一节：
 *   规则 1  已有文章（含软删）的网址名不会被改，重试也不会改；
 *   规则 2  只给过短的补词，正常的逐字节不变，补长后再检查，再去重；
 *   规则 4  15 个语种的后缀：1 个字的书名补长后也健康；
 *   规则 5  预览与正式生成算出同一个网址名。
 *
 * 只放 `tests/` 下——`src/` 下的测试不会被 vitest 收集。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createArticleGenerateHandler } from "../../../worker/handlers/article-generate";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { isHealthySlug, textToSlug } from "@/lib/slug/text-to-slug";
import { generateArticleFromNovel } from "@/server/content-creation/generate";
import {
  ARTICLE_SHORT_SLUG_SUFFIX_BY_LOCALE,
  SLUG_SUFFIX_MAX_ATTEMPTS,
  resolveArticleSlug,
  resolveUniqueSlug,
} from "@/server/content-creation/shared";

import { FakeContentCreationDb } from "./fake-db";

const ADMIN_ACTOR = { type: "admin", adminId: "admin-1" } as const;
const REPO_ROOT = resolve(__dirname, "../../..");

const never = async () => false;
const takenSet = (...taken: string[]) => {
  const set = new Set(taken);
  return async (candidate: string) => set.has(candidate);
};

/** 每个语种各取代表字（拉丁 / 西里尔 / 泰文 / 阿拉伯文 / 假名·汉字 / 谚文 / 繁体汉字 / 越南文）。 */
const ONE_CHAR_TITLES: Readonly<Record<SiteLocale, readonly string[]>> = {
  en: ["A"],
  es: ["Ñ"],
  "pt-BR": ["Ã"],
  id: ["A"],
  vi: ["Ư", "Ê"],
  th: ["ก"],
  ja: ["愛", "あ", "ア"],
  ko: ["한"],
  "zh-Hant": ["愛"],
  ar: ["ب"],
  fr: ["É"],
  de: ["Ü"],
  pl: ["Ł"],
  cs: ["Ř"],
  ru: ["Я"],
};

function seedReadyNovel(fake: FakeContentCreationDb, title: string, locale: SiteLocale = "en") {
  const novel = fake.seedNovel({ title, locale, slug: `seed-${locale}-${fake.novels.size}-${title.length}` });
  const promo = fake.seedPromoLink({ novelId: novel.id });
  fake.seedArticleTemplate({
    templateKey: `system-default-${locale}`,
    locale,
    status: "active",
    bodyTemplate: "<h1>{novel_title}</h1><p>{novel_description}</p>",
    seoTemplate: { title: "{novel_title}", metaDescription: "{novel_description}" },
  });
  return { novel, promo };
}

describe("规则 4 · 后缀表（15 语种）", () => {
  it("后缀表恰好覆盖全部已登记语种，没有多余键", () => {
    expect(Object.keys(ARTICLE_SHORT_SLUG_SUFFIX_BY_LOCALE).sort()).toEqual([...SITE_LOCALES].sort());
    expect(Object.keys(ONE_CHAR_TITLES).sort()).toEqual([...SITE_LOCALES].sort());
  });

  for (const locale of SITE_LOCALES) {
    describe(`locale=${locale}`, () => {
      const word = ARTICLE_SHORT_SLUG_SUFFIX_BY_LOCALE[locale];

      it("后缀经 textToSlug 后等于自身，长度 >=3，末尾不是数字", () => {
        expect(textToSlug(word, locale)).toBe(word);
        expect(word.length).toBeGreaterThanOrEqual(3);
        expect(word).toMatch(/\P{N}$/u);
        // 已是 NFC：拼进网址名后不会因组合记号被拆散。
        expect(word).toBe(word.normalize("NFC"));
      });

      it("该语种文字的 1 个字书名，补长后健康", async () => {
        for (const title of ONE_CHAR_TITLES[locale]) {
          const base = textToSlug(title, locale);
          expect(isHealthySlug(base)).toBe(false);
          const result = await resolveArticleSlug(title, locale, never);
          expect(result).toEqual({ outcome: "ok", slug: `${base}-${word}`, baseSlug: `${base}-${word}` });
          if (result.outcome !== "ok") throw new Error("unreachable");
          expect(isHealthySlug(result.slug)).toBe(true);
          expect(result.slug.length).toBeGreaterThanOrEqual(5);
        }
      });

      it("纯数字的 1 个字书名，补长后也健康", async () => {
        for (const title of ["7", "0"]) {
          const result = await resolveArticleSlug(title, locale, never);
          expect(result.outcome).toBe("ok");
          if (result.outcome !== "ok") throw new Error("unreachable");
          expect(result.slug).toBe(`${title}-${word}`);
          expect(isHealthySlug(result.slug)).toBe(true);
        }
      });
    });
  }
});

describe("规则 2 · 只给过短的补词", () => {
  it("Dawn → dawn-novel；HIS(18+) → his-18-novel；24/7 #4 → 24-7-4-novel", async () => {
    expect(await resolveArticleSlug("Dawn", "en", never)).toEqual({
      outcome: "ok", slug: "dawn-novel", baseSlug: "dawn-novel",
    });
    expect(await resolveArticleSlug("HIS(18+)", "en", never)).toEqual({
      outcome: "ok", slug: "his-18-novel", baseSlug: "his-18-novel",
    });
    expect(await resolveArticleSlug("24/7 #4", "en", never)).toEqual({
      outcome: "ok", slug: "24-7-4-novel", baseSlug: "24-7-4-novel",
    });
  });

  it("补词用的是该语种的词，不是英语的词", async () => {
    expect((await resolveArticleSlug("Sol", "es", never))).toMatchObject({ slug: "sol-novela" });
    expect((await resolveArticleSlug("Мир", "ru", never))).toMatchObject({ slug: "мир-роман" });
    expect((await resolveArticleSlug("愛", "ja", never))).toMatchObject({ slug: "愛-ウェブ小説" });
    expect((await resolveArticleSlug("한", "ko", never))).toMatchObject({ slug: "한-웹소설" });
    expect((await resolveArticleSlug("愛", "zh-Hant", never))).toMatchObject({ slug: "愛-網路小說" });
  });

  // 「网址名正常的书名，输出与改动前逐字节相同」：以未改动的 resolveUniqueSlug 为对照基准，
  // 并且显式断言结果就是 textToSlug 的原样输出（没有任何后缀）。
  const HEALTHY_TITLES: readonly string[] = [
    "Hell's Kitchen Apocalypse Edition",
    "The Great Adventure",
    "Ready Novel",
    "Bound Story",
    "Winner Visible",
    "Existing Article Novel",
    "Chapter 12 Begins",
    // 末尾带数字但够长：去掉 -数字 后仍 >=5 个字符，不许被误补。
    "Chapter 12",
    "Moonlight 2077",
    "Hello World 2",
    // 刚好 5 个字符。
    "abcde",
    "abcde 2",
    "霸道总裁 Free Watch",
    "La Ascensión",
    "Мастер и Маргарита",
    "転生したら悪役令嬢でした",
    "회귀한 천재 마법사",
    "!!! --- ...", // 归一化为 "untitled"（回退值本身就是健康长度）
  ];

  for (const locale of SITE_LOCALES) {
    it(`网址名正常的书名逐字节不变（对照未改动的 resolveUniqueSlug）· ${locale}`, async () => {
      for (const title of HEALTHY_TITLES) {
        const legacy = await resolveUniqueSlug(title, locale, never);
        if (legacy.outcome !== "ok") continue; // 本语种下这个标题本来就过短，不属于「正常」集合
        const next = await resolveArticleSlug(title, locale, never);
        expect(next, `title=${JSON.stringify(title)}`).toEqual(legacy);
        expect(next).toMatchObject({ slug: textToSlug(title, locale) });
      }
    });
  }

  it("HEALTHY_TITLES 在 en 下全部是「正常」样本（防止上面的 continue 把整组悄悄跳过）", async () => {
    let compared = 0;
    for (const title of HEALTHY_TITLES) {
      const legacy = await resolveUniqueSlug(title, "en", never);
      if (legacy.outcome === "ok") compared += 1;
    }
    expect(compared).toBe(HEALTHY_TITLES.length);
  });

  it("边界：4 个字符过短要补，5 个字符不补，带 -数字 的按去掉编号后的长度判", async () => {
    expect(await resolveArticleSlug("abcd", "en", never)).toMatchObject({ slug: "abcd-novel" });
    expect(await resolveArticleSlug("abcde", "en", never)).toMatchObject({ slug: "abcde" });
    expect(await resolveArticleSlug("abcde 2", "en", never)).toMatchObject({ slug: "abcde-2" });
    expect(await resolveArticleSlug("abcd 2", "en", never)).toMatchObject({ slug: "abcd-2-novel" });
  });

  it("补长后撞名：沿用 -2、-3 去重，baseSlug 是补长后的形态", async () => {
    expect(await resolveArticleSlug("Dawn", "en", takenSet("dawn-novel"))).toEqual({
      outcome: "ok", slug: "dawn-novel-2", baseSlug: "dawn-novel",
    });
    expect(await resolveArticleSlug("Dawn", "en", takenSet("dawn-novel", "dawn-novel-2"))).toEqual({
      outcome: "ok", slug: "dawn-novel-3", baseSlug: "dawn-novel",
    });
  });

  it("补长后：名字被占用的是未补长的旧形态时不受影响（只看补长后的候选）", async () => {
    expect(await resolveArticleSlug("Dawn", "en", takenSet("dawn"))).toMatchObject({ slug: "dawn-novel" });
  });

  it("-2…-200 全被占用 → slug_conflict_exhausted，上限沿用 200", async () => {
    expect(SLUG_SUFFIX_MAX_ATTEMPTS).toBe(200);
    const all = ["dawn-novel", ...Array.from({ length: 199 }, (_, i) => `dawn-novel-${i + 2}`)];
    expect(await resolveArticleSlug("Dawn", "en", takenSet(...all))).toEqual({
      outcome: "slug_conflict_exhausted", baseSlug: "dawn-novel",
    });
    // 少占用最后一个（-200）还能拿到。
    expect(await resolveArticleSlug("Dawn", "en", takenSet(...all.slice(0, -1)))).toMatchObject({
      outcome: "ok", slug: "dawn-novel-200",
    });
  });

  it("小说建档用的 resolveUniqueSlug 规则不变：默认仍拒绝过短，validateHealth:false 仍原样放行", async () => {
    expect(await resolveUniqueSlug("HIS(18+)", "en", never)).toEqual({ outcome: "slug_unhealthy", baseSlug: "his-18" });
    expect(await resolveUniqueSlug("HIS(18+)", "en", never, { validateHealth: false })).toEqual({
      outcome: "ok", slug: "his-18", baseSlug: "his-18",
    });
  });
});

describe("规则 1 · 已有文章的网址名不会被改", () => {
  it("已有文章再生成：返回已存在，网址名不变，不写库", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "HIS(18+)");
    const existing = fake.seedArticle({ novelId: novel.id, locale: "en", slug: "his-18-legacy", title: "Hand edited", body: "manual body" });

    for (const mode of ["apply", "dry_run"] as const) {
      const result = await generateArticleFromNovel(fake.asPrismaClient(), {
        novelId: novel.id, mode, actor: ADMIN_ACTOR, requestId: `exists-${mode}`,
      });
      expect(result.outcome).toBe("already_exists");
      if (result.outcome !== "already_exists") throw new Error("unreachable");
      expect(result.articleId).toBe(existing.id);
      expect(result.articleSlug).toBe("his-18-legacy");
    }
    expect(fake.lastArticleCreateArgs).toBeNull();
    expect(fake.calls).not.toContain("article.create");
    expect(fake.audits).toHaveLength(0);
    expect(fake.articles.size).toBe(1);
    expect([...fake.articles.values()][0]).toMatchObject({ slug: "his-18-legacy", body: "manual body" });
  });

  it("软删文章同样不改：返回 article_soft_deleted，不新建不改名", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "HIS(18+)");
    const existing = fake.seedArticle({
      novelId: novel.id, locale: "en", slug: "his-18-legacy", deletedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    for (const mode of ["apply", "dry_run"] as const) {
      const result = await generateArticleFromNovel(fake.asPrismaClient(), {
        novelId: novel.id, mode, actor: ADMIN_ACTOR, requestId: `soft-${mode}`,
      });
      expect(result).toEqual({ outcome: "article_soft_deleted", articleId: existing.id });
    }
    expect(fake.calls).not.toContain("article.create");
    expect(fake.audits).toHaveLength(0);
    expect(fake.articles.size).toBe(1);
    expect(fake.articles.get(existing.id)?.slug).toBe("his-18-legacy");
  });

  function handlerFor(fake: FakeContentCreationDb) {
    const handler = createArticleGenerateHandler(fake.asPrismaClient());
    return async (novelId: string, requestId: string) => {
      const outcome = await handler({
        lease: {
          payload: {
            novelId,
            actorId: "admin-1",
            requestId,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        },
      } as never);
      if (outcome.status !== "success" || !outcome.protectedWrite) throw new Error(`unexpected handler outcome ${outcome.status}`);
      return outcome.protectedWrite(fake.asPrismaClient() as never);
    };
  }

  it("重试失败任务项：该书已有文章（旧规则下建的旧网址）→ skipped，网址名不变", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "HIS(18+)");
    fake.seedArticle({ novelId: novel.id, locale: "en", slug: "his-18-legacy" });
    const run = handlerFor(fake);

    const retried = await run(novel.id, "retry-1");
    expect(retried).toMatchObject({ status: "skipped", result: { outcome: "already_exists", articleSlug: "his-18-legacy" } });
    expect(fake.calls).not.toContain("article.create");
    expect(fake.articles.size).toBe(1);
    expect([...fake.articles.values()][0]?.slug).toBe("his-18-legacy");
  });

  it("重试失败任务项：第一次已按新规则建出 his-18-novel，再重试 → skipped，网址名仍是 his-18-novel", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "HIS(18+)");
    const run = handlerFor(fake);

    const first = await run(novel.id, "retry-2-a");
    expect(first).toMatchObject({ status: "success", result: { outcome: "created", articleSlug: "his-18-novel" } });
    const second = await run(novel.id, "retry-2-b");
    expect(second).toMatchObject({ status: "skipped", result: { outcome: "already_exists", articleSlug: "his-18-novel" } });
    expect(fake.articles.size).toBe(1);
    expect([...fake.articles.values()][0]?.slug).toBe("his-18-novel");
  });
});

describe("规则 2 · 文章生成端到端（写入的网址名）", () => {
  it("Dawn 写入 dawn-novel；HIS(18+) 写入 his-18-novel；标题字段不受影响", async () => {
    for (const [title, slug] of [["Dawn", "dawn-novel"], ["HIS(18+)", "his-18-novel"]] as const) {
      const fake = new FakeContentCreationDb();
      const { novel } = seedReadyNovel(fake, title);
      const result = await generateArticleFromNovel(fake.asPrismaClient(), {
        novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: `gen-${slug}`,
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") throw new Error("unreachable");
      expect(result.articleSlug).toBe(slug);
      expect(fake.lastArticleCreateArgs?.slug).toBe(slug);
      expect(fake.lastArticleCreateArgs?.title).toBe(title);
    }
  });

  it("日语 / 韩语短书名按各自语种的词补长", async () => {
    const fake = new FakeContentCreationDb();
    const ja = seedReadyNovel(fake, "春夏秋冬", "ja");
    const ko = seedReadyNovel(fake, "한국", "ko");
    const jaResult = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: ja.novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-ja",
    });
    const koResult = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: ko.novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-ko",
    });
    expect(jaResult).toMatchObject({ outcome: "created", articleSlug: "春夏秋冬-ウェブ小説" });
    expect(koResult).toMatchObject({ outcome: "created", articleSlug: "한국-웹소설" });
  });

  it("网址名正常的书名：写入值与改动前相同（没有后缀）", async () => {
    const fake = new FakeContentCreationDb();
    const { novel } = seedReadyNovel(fake, "Chapter 12 Begins");
    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-healthy",
    });
    expect(result).toMatchObject({ outcome: "created", articleSlug: "chapter-12-begins" });
  });

  it("补长后撞名 → -2（同语种另一篇已占用 dawn-novel）", async () => {
    const fake = new FakeContentCreationDb();
    const other = fake.seedNovel({ title: "Other", locale: "en", slug: "other-novel-seed" });
    fake.seedArticle({ novelId: other.id, locale: "en", slug: "dawn-novel" });
    const { novel } = seedReadyNovel(fake, "Dawn");
    const result = await generateArticleFromNovel(fake.asPrismaClient(), {
      novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "gen-conflict",
    });
    expect(result).toMatchObject({ outcome: "created", articleSlug: "dawn-novel-2" });
  });
});

describe("规则 5 · 预览与正式生成算出同一个网址名", () => {
  const CASES: ReadonlyArray<{ title: string; locale: SiteLocale; slug: string; taken?: string }> = [
    { title: "HIS(18+)", locale: "en", slug: "his-18-novel" },
    { title: "Dawn", locale: "en", slug: "dawn-novel" },
    { title: "Dawn", locale: "en", slug: "dawn-novel-2", taken: "dawn-novel" },
    { title: "春夏秋冬", locale: "ja", slug: "春夏秋冬-ウェブ小説" },
    { title: "한국", locale: "ko", slug: "한국-웹소설" },
    { title: "愛", locale: "zh-Hant", slug: "愛-網路小說" },
    { title: "Мир", locale: "ru", slug: "мир-роман" },
    { title: "Chapter 12 Begins", locale: "en", slug: "chapter-12-begins" },
  ];

  for (const { title, locale, slug, taken } of CASES) {
    it(`${locale} · ${JSON.stringify(title)}${taken ? "（撞名）" : ""} → ${slug}`, async () => {
      const fake = new FakeContentCreationDb();
      if (taken) {
        const other = fake.seedNovel({ title: "Other", locale, slug: "other-seed" });
        fake.seedArticle({ novelId: other.id, locale, slug: taken });
      }
      const { novel } = seedReadyNovel(fake, title, locale);

      const preview = await generateArticleFromNovel(fake.asPrismaClient(), {
        novelId: novel.id, mode: "dry_run", actor: ADMIN_ACTOR, requestId: "preview",
      });
      expect(preview.outcome).toBe("dry_run");
      if (preview.outcome !== "dry_run") throw new Error("unreachable");
      expect(preview.plan.articleSlug).toBe(slug);
      // 预览不写库。
      expect(fake.calls).not.toContain("article.create");
      expect(fake.audits).toHaveLength(0);

      const applied = await generateArticleFromNovel(fake.asPrismaClient(), {
        novelId: novel.id, mode: "apply", actor: ADMIN_ACTOR, requestId: "apply",
      });
      expect(applied.outcome).toBe("created");
      if (applied.outcome !== "created") throw new Error("unreachable");
      expect(applied.articleSlug).toBe(preview.plan.articleSlug);
      expect(fake.lastArticleCreateArgs?.slug).toBe(preview.plan.articleSlug);
    });
  }

  // 源码级防线：预览（dryRun）与正式生成只能共用 `runGenerate` 里**同一处**网址名计算，
  // 不允许另写一份；小说建档继续走原来的 resolveUniqueSlug（validateHealth:false）。
  it("generate.ts 只有一处网址名计算且用的是 resolveArticleSlug；小说建档的调用没被动过", () => {
    const generateSource = readFileSync(resolve(REPO_ROOT, "src/server/content-creation/generate.ts"), "utf8");
    expect(generateSource.match(/resolveArticleSlug\(/g)).toHaveLength(1);
    expect(generateSource).not.toMatch(/resolveUniqueSlug\(/);

    const serviceSource = readFileSync(resolve(REPO_ROOT, "src/server/content-creation/service.ts"), "utf8");
    const call = serviceSource.slice(serviceSource.indexOf("resolveUniqueSlug("));
    expect(call.length).toBeGreaterThan(0);
    expect(call.slice(0, 400)).toContain("validateHealth: false");
    expect(serviceSource).not.toContain("resolveArticleSlug");
  });
});
