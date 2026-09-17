/**
 * N-8 parity gap: CPS never sanitizes `Article.body` on admin edit either
 * (P2-04 移植审计 confirmed the same "trusted operator" acceptance for the
 * upstream product), but this project's own discipline elsewhere
 * (`src/lib/seo/template/html.ts`'s fail-closed template engine) is stricter
 * than that baseline, and the admin edit path (`updateArticleContent`) is a
 * genuinely different trust boundary from the *generated* path
 * (`regenerateCore` → `renderArticleDraft`, whose HTML output the engine's
 * own fail-closed binding whitelist already constrains — this module must
 * never run there, only on operator-typed HTML).
 *
 * Zero-dependency by design (施工规格 N-8: "零依赖手写白名单解析优先"):
 * the admin body editor is a `<textarea>`, not a rich-text surface, so the
 * realistic input shape is hand-typed or pasted HTML from a known-small set
 * of block/inline tags — not adversarial browser-grade markup requiring a
 * full HTML5 tree-construction algorithm. A tag-token whitelist scan is
 * sufficient for that shape and keeps this file dependency-free.
 *
 * Not a general-purpose sanitizer: it does not attempt to defend against
 * every DOM-clobbering or mutation-XSS technique a full parser (DOMPurify,
 * sanitize-html) would. It removes the concrete risk this project's threat
 * model cares about (script execution via `<script>`, inline event
 * handlers, `javascript:`/`data:` URIs) for content only ever rendered on
 * this site's own public pages.
 */

const SAFE_URL_SCHEME = /^https:\/\//i;

const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  p: [],
  br: [],
  h2: [],
  h3: [],
  ul: [],
  ol: [],
  li: [],
  strong: [],
  em: [],
  blockquote: [],
  a: ["href"],
  img: ["src", "alt"],
});

const ALLOWED_TAGS = new Set(Object.keys(TAG_ATTRIBUTES));
/** Tags whose *content* must also be dropped, not just unwrapped. */
const STRIP_WITH_CONTENT = new Set(["script", "style"]);

const ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    // Last one wins on duplicates, matching how browsers resolve them — not
    // load-bearing here, just deterministic.
    attributes.set(name, value);
  }
  return attributes;
}

function sanitizeTag(rawTag: string): string {
  // `rawTag` is one full `<...>` token, including the angle brackets.
  const closing = rawTag.startsWith("</");
  const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(rawTag);
  if (!nameMatch) return "";
  const name = nameMatch[1]!.toLowerCase();

  if (!ALLOWED_TAGS.has(name)) return "";
  if (closing) return `</${name}>`;

  const attrSource = rawTag.slice(nameMatch[0].length, rawTag.endsWith("/>") ? -2 : -1);
  const parsed = parseAttributes(attrSource);
  const allowedAttrNames = TAG_ATTRIBUTES[name]!;
  const kept: string[] = [];
  for (const attrName of allowedAttrNames) {
    const value = parsed.get(attrName);
    if (value === undefined) continue;
    if ((attrName === "href" || attrName === "src") && !SAFE_URL_SCHEME.test(value.trim())) {
      continue; // drop non-https (javascript:, data:, relative, http:) targets outright
    }
    kept.push(`${attrName}="${value.replace(/"/g, "&quot;")}"`);
  }
  if (name === "img" && !kept.some((attr) => attr.startsWith("src="))) {
    return ""; // an <img> with no safe src is not worth keeping
  }
  const selfClosing = name === "br" || name === "img";
  return kept.length > 0
    ? `<${name} ${kept.join(" ")}${selfClosing ? " /" : ""}>`
    : `<${name}${selfClosing ? " /" : ""}>`;
}

const TOKEN_PATTERN = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\/?>/g;

/**
 * Whitelist-sanitizes operator-authored article body HTML before it is
 * persisted (`updateArticleContent` only — never the template-engine
 * regenerate path, see module header).
 *
 * Contract (施工规格 N-8): keeps `p, br, h2, h3, ul, ol, li, strong, em, a,
 * img, blockquote`; `a` keeps only an https `href`; `img` keeps only an
 * https `src` and `alt`; every other tag is unwrapped (its text content is
 * kept, the tag itself is dropped); `script`/`style` are removed along with
 * their content; comments are stripped; any `on*` attribute or
 * `javascript:`/non-https URL is dropped regardless of tag.
 */
export function sanitizeArticleBody(html: string): string {
  const withoutDangerousBlocks = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  return withoutDangerousBlocks.replace(TOKEN_PATTERN, (token) => {
    if (token.startsWith("<!--")) return "";
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(token);
    const name = nameMatch?.[1]?.toLowerCase();
    if (name && STRIP_WITH_CONTENT.has(name)) return ""; // orphaned open/close tag, e.g. unmatched </script>
    return sanitizeTag(token);
  });
}
