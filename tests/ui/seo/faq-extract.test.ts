import { describe, expect, it } from "vitest";

import {
  buildFaqJsonLd,
  extractFaqItemsFromContent,
  extractFaqItemsFromJsonBlocks,
} from "@/lib/seo/faq-extract";

describe("extractFaqItemsFromContent", () => {
  it("returns empty for blank content", () => {
    expect(extractFaqItemsFromContent("   ")).toEqual([]);
  });

  it("extracts heading Q/A pairs from HTML", () => {
    const html = `
      <h2>What is this?</h2>
      <p>A novel.</p>
      <h3>How long?</h3>
      <p>Twelve chapters.</p>
    `;
    expect(extractFaqItemsFromContent(html)).toEqual([
      { question: "What is this?", answer: "A novel." },
      { question: "How long?", answer: "Twelve chapters." },
    ]);
  });

  it("extracts from editor JSON blocks", () => {
    const content = JSON.stringify([
      { content: "Q: Is it free?" },
      { content: "The preview chapters are free." },
    ]);
    expect(extractFaqItemsFromJsonBlocks(content)).toEqual([
      { question: "Is it free?", answer: "The preview chapters are free." },
    ]);
    expect(extractFaqItemsFromContent(content)).toEqual([
      { question: "Is it free?", answer: "The preview chapters are free." },
    ]);
  });
});

describe("buildFaqJsonLd", () => {
  it("returns null when there are no FAQ items", () => {
    expect(buildFaqJsonLd("<p>not a question</p>")).toBeNull();
  });

  it("builds FAQPage JSON-LD", () => {
    const html = "<h2>Ready?</h2><p>Yes.</p>";
    expect(buildFaqJsonLd(html)).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Ready?",
          acceptedAnswer: { "@type": "Answer", text: "Yes." },
        },
      ],
    });
  });
});
