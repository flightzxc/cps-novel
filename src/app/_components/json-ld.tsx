/** Neutralize `</script>` in third-party titles so JSON-LD cannot break out of the script tag. */
export function escapeJsonLd(json: string): string {
  return json.replace(/</g, "\\u003c");
}

export function JsonLd({ json }: { json: string }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: escapeJsonLd(json) }} />
  );
}
