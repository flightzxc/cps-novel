/**
 * Heading TOC utilities — server-side HTML processing.
 * No DOM dependency: pure regex, safe in Node.js.
 *
 * Ported from CPS `src/lib/blog-content-utils.ts` (d77c3b9).
 */

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

/**
 * Add `id="heading-{i}"` to each <h2> / <h3> that doesn't already have an id.
 * Index `i` is 0-based, sequential across the whole document.
 */
export function addHeadingIds(html: string): string {
  let index = 0;
  return html.replace(/<h([23])([^>]*)>/gi, (_match, level, attrs) => {
    if (/\bid\s*=/i.test(attrs)) {
      index++;
      return `<h${level}${attrs}>`;
    }
    const id = `heading-${index}`;
    index++;
    return `<h${level}${attrs} id="${id}">`;
  });
}

/**
 * Extract TOC items from HTML string.
 * Returns items in document order with the ids that `addHeadingIds` will assign.
 */
export function extractTocItems(html: string): TocItem[] {
  const items: TocItem[] = [];
  let index = 0;

  const pattern = /<h([23])([^>]*)>([\s\S]*?)<\/h[23]>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const level = parseInt(match[1], 10) as 2 | 3;
    const attrs = match[2];
    const inner = match[3];

    const existingId = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const id = existingId ? existingId[1] : `heading-${index}`;

    const text = inner.replace(/<[^>]+>/g, "").trim();

    if (text) {
      items.push({ id, text, level });
    }

    index++;
  }

  return items;
}
