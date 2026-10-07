/**
 * 封面图床预连接：从一组封面地址里挑出需要 `<link rel="preconnect">` 的 origin。
 *
 * 为什么要预连接：书封是上游图床直链（B-37，2026-10-07），图床域名与本站不同源，
 * 浏览器要先做 DNS + TCP + TLS 才能开始下载。详情页与首页首屏的封面在本页**一定**
 * 会加载，提前握手能把这段耗时从关键路径上挪开——这也是这里用 `preconnect`
 * 而不是 CPS 先例（`promo-dns-hints`，v8.7.2）只做 `dns-prefetch` 的原因：CPS 的
 * 推广域名只有用户点击才会访问，这里的图床域名一定会访问。
 *
 * 规则（最小范围，刻意保守）：
 *   - 只处理 `https://` 开头的**绝对**地址。相对路径（本站自己的 `/covers/...`）、
 *     协议相对 `//host/...`、`http://`、`data:` 一律跳过；
 *   - 按 origin 去重，保持首次出现的顺序；
 *   - 不带 crossorigin：`<img>` 是 no-cors 请求，加了 crossorigin 反而会让预热的
 *     连接与真正的图片请求不是同一个连接池，白做。
 */
export function collectCoverPreconnectOrigins(
  urls: ReadonlyArray<string | null | undefined>,
): string[] {
  const origins = new Set<string>();
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    // 协议判断只在这一处：`new URL("https:foo")` 也会解析成功，所以不能只靠
    // `url.protocol`，这里要求明确的 `https://`。
    if (!/^https:\/\//i.test(value)) continue;
    try {
      const url = new URL(value);
      if (url.hostname) {
        origins.add(url.origin);
      }
    } catch {
      // 不是合法 URL：跳过，预连接只是性能提示，不值得为它抛错。
    }
  }
  return [...origins];
}
