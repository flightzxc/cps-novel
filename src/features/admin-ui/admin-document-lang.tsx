"use client";

import { useEffect } from "react";

const PUBLIC_HTML_LANG = "en";
const ADMIN_HTML_LANG = "zh-CN";

/**
 * Sync `<html lang>` while an admin tree is mounted.
 *
 * Root layout stays `lang="en"` for the public site. Admin wrappers also set
 * `lang="zh-CN"` on their subtree (SSR-correct for assistive tech). This
 * effect covers tools that read `document.documentElement.lang` (browser
 * translate, spellcheck).
 */
export function AdminDocumentLang() {
  useEffect(() => {
    const previous = document.documentElement.lang || PUBLIC_HTML_LANG;
    document.documentElement.lang = ADMIN_HTML_LANG;
    return () => {
      document.documentElement.lang = previous;
    };
  }, []);

  return null;
}
