/**
 * FAQ extraction from HTML / editor JSON blocks, plus FAQPage JSON-LD.
 *
 * Ported from the three FAQ functions in CPS `src/lib/blog-seo.ts` (d77c3b9).
 * Blog path / hreflang / BlogPosting / PulseDrama branding are not ported.
 */

export interface FaqItem {
  question: string;
  answer: string;
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripHtml(value: string): string {
  return decodeBasicHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuestion(value: string): string {
  return stripHtml(value).replace(/^q[:：]\s*/i, "").trim();
}

function isQuestion(value: string): boolean {
  const question = normalizeQuestion(value);
  return Boolean(question) && (/[\?？]$/.test(question) || /^q[:：]/i.test(value.trim()));
}

export function extractFaqItemsFromJsonBlocks(content: string): FaqItem[] {
  try {
    const blocks = JSON.parse(content);
    if (!Array.isArray(blocks)) return [];

    const texts = blocks
      .map((block) => (typeof block?.content === "string" ? block.content : ""))
      .map(stripHtml)
      .filter(Boolean);
    const items: FaqItem[] = [];

    for (let index = 0; index < texts.length - 1; index++) {
      if (!isQuestion(texts[index])) continue;
      const answer = texts[index + 1];
      if (!answer || isQuestion(answer)) continue;
      items.push({
        question: normalizeQuestion(texts[index]),
        answer,
      });
    }

    return items.slice(0, 10);
  } catch {
    return [];
  }
}

export function extractFaqItemsFromContent(content: string): FaqItem[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    const jsonItems = extractFaqItemsFromJsonBlocks(trimmed);
    if (jsonItems.length > 0) return jsonItems;
  }

  const items: FaqItem[] = [];
  const pattern = /<h([23])[^>]*>([\s\S]*?)<\/h[23]>\s*([\s\S]*?)(?=<h[23][^>]*>|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(trimmed)) !== null) {
    const question = normalizeQuestion(match[2]);
    const answer = stripHtml(match[3]);
    if (!isQuestion(question) || !answer) continue;
    items.push({ question, answer });
    if (items.length >= 10) break;
  }

  return items;
}

export function buildFaqJsonLd(content: string) {
  const faqItems = extractFaqItemsFromContent(content);
  if (faqItems.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}
