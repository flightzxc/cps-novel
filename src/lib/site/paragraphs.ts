/** Split a materialized chapter `body` into display paragraphs. The screen does not parse. */
export function splitChapterParagraphs(body: string): string[] {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (blocks.length > 0) return blocks;

  return normalized
    .split("\n")
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
