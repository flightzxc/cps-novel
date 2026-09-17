import { describe, expect, it } from "vitest";

import { sanitizeArticleBody } from "@/server/articles/sanitize-body";

/** N-8: operator-edit HTML whitelist (施工规格 N-8). */
describe("sanitizeArticleBody", () => {
  it("strips <script> tags and their content entirely", () => {
    const out = sanitizeArticleBody('<p>hello</p><script>alert(1)</script><p>world</p>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toBe("<p>hello</p><p>world</p>");
  });

  it("strips <style> tags and their content entirely", () => {
    const out = sanitizeArticleBody('<style>body{color:red}</style><p>ok</p>');
    expect(out).not.toContain("<style");
    expect(out).not.toContain("color:red");
    expect(out).toBe("<p>ok</p>");
  });

  it("drops on* event-handler attributes while keeping the tag", () => {
    const out = sanitizeArticleBody('<p onclick="alert(1)">click me</p>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("click me");
    expect(out).toContain("<p>");
  });

  it("drops a javascript: href on <a>, keeping the tag and text", () => {
    const out = sanitizeArticleBody('<a href="javascript:alert(1)">link</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("link");
    expect(out).toBe("<a>link</a>");
  });

  it("keeps an https href on <a>", () => {
    const out = sanitizeArticleBody('<a href="https://example.test/x">link</a>');
    expect(out).toBe('<a href="https://example.test/x">link</a>');
  });

  it("drops a non-https (http/relative/data:) src on <img>, removing the whole tag", () => {
    expect(sanitizeArticleBody('<img src="http://example.test/x.jpg" alt="x">')).toBe("");
    expect(sanitizeArticleBody('<img src="/local.jpg" alt="x">')).toBe("");
    expect(sanitizeArticleBody('<img src="data:image/png;base64,AAAA" alt="x">')).toBe("");
  });

  it("keeps an https src + alt on <img>", () => {
    const out = sanitizeArticleBody('<img src="https://example.test/x.jpg" alt="cover">');
    expect(out).toBe('<img src="https://example.test/x.jpg" alt="cover" />');
  });

  it("keeps every whitelisted structural/inline tag", () => {
    const input = "<p>p</p><br><h2>h2</h2><h3>h3</h3><ul><li>li</li></ul><ol><li>li2</li></ol><strong>s</strong><em>e</em><blockquote>q</blockquote>";
    const out = sanitizeArticleBody(input);
    for (const tag of ["p", "br", "h2", "h3", "ul", "ol", "li", "strong", "em", "blockquote"]) {
      expect(out).toContain(`<${tag}`);
    }
  });

  it("unwraps a non-whitelisted tag but keeps its text content", () => {
    const out = sanitizeArticleBody("<div>kept text</div>");
    expect(out).not.toContain("<div");
    expect(out).toContain("kept text");
  });

  it("strips HTML comments", () => {
    const out = sanitizeArticleBody("<p>a</p><!-- injected --><p>b</p>");
    expect(out).not.toContain("<!--");
    expect(out).not.toContain("injected");
  });

  it("removes an <iframe> (not whitelisted) but keeps no attributes it might carry", () => {
    const out = sanitizeArticleBody('<iframe src="https://evil.example"></iframe>text');
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("text");
  });
});
