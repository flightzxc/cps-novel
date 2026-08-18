import { describe, expect, it } from "vitest";

import { addHeadingIds, extractTocItems } from "@/lib/seo/heading-toc";

const html = `
<h2>First</h2>
<p>body</p>
<h3>Nested</h3>
<h2 id="keep-me">Kept</h2>
`;

describe("addHeadingIds", () => {
  it("injects sequential ids on h2/h3 that lack one", () => {
    const out = addHeadingIds(html);
    expect(out).toContain('<h2 id="heading-0">');
    expect(out).toContain('<h3 id="heading-1">');
    expect(out).toContain('<h2 id="keep-me">');
  });
});

describe("extractTocItems", () => {
  it("returns document-order items using the same ids addHeadingIds would assign", () => {
    expect(extractTocItems(html)).toEqual([
      { id: "heading-0", text: "First", level: 2 },
      { id: "heading-1", text: "Nested", level: 3 },
      { id: "keep-me", text: "Kept", level: 2 },
    ]);
  });
});
