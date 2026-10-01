#!/usr/bin/env node
// Next.js "Middleware / Proxy bypass" probe for src/proxy.ts (admin-host isolation).
//
// Why this exists (2026-09-30, Next 16.1.6 -> 16.3.3 security upgrade):
//   - The Next.js advisories fixed between 16.1.6 and 16.3.3 include a family
//     of "Middleware / Proxy bypass" issues (GHSA-267c-6grr-h53f,
//     GHSA-26hh-7cqf-hhc6, GHSA-492v-c6pp-mqqv, GHSA-6gpp-xcg3-4w24,
//     GHSA-36qx-fr4f-26g5) plus GHSA-3g8h-86w9-wvmq (proxy redirects
//     poisoned through the internal `x-nextjs-data` header).
//   - src/proxy.ts is this site's admin-host isolation gate: on the public
//     host every admin path must be a bare 404; on the admin host only admin
//     paths are served. This probe drives a *real* `next start` server with
//     raw HTTP requests (no client-side URL normalisation) and asserts the
//     security invariants of that gate under every transport variant we know
//     the advisories describe, plus generic path/host/header smuggling.
//
// It is a black-box probe: it talks to one already-running server and never
// touches a database itself. scripts/run-next-proxy-probe-verification.sh
// builds the app, starts a disposable Postgres + `next start`, and calls this.
//
// Usage:
//   node scripts/security/next-proxy-probe.mjs --port 3100 \
//     [--host 127.0.0.1] [--public-host novel.test] [--admin-host zbcwf.novel.test] \
//     [--build-id <id>] [--next-version 16.3.3] [--json-out probe.json] [--verbose]
//
// Exit code: 0 = every invariant held, 1 = at least one violated, 2 = harness error
// (e.g. the control probes failed, meaning the server is not the app we think it is).

import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const PUBLIC_HOST_DEFAULT = "novel.test";
export const ADMIN_HOST_DEFAULT = "zbcwf.novel.test";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** Real admin *pages* (the ones that exist as page.tsx) — see src/app/(admin)/**. */
export const PROBE_ADMIN_PAGES = Object.freeze([
  "/novels",
  "/tasks",
  "/settings",
  "/tags",
  "/promo-links",
  "/articles",
  "/catalog-sync",
  "/channel-accounts",
  "/categories",
  "/home-carousel",
  "/templates",
  `/novels/${ZERO_UUID}`,
  `/tasks/${ZERO_UUID}`,
]);
/** Admin-host-only auth pages: reachable on the admin host without a session, 404 on the public host. */
export const PROBE_AUTH_PAGES = Object.freeze(["/login", "/two-factor/setup", "/two-factor/challenge"]);
/** `/api/admin/*` Route Handlers (GET) — session-guarded per handler. */
export const PROBE_ADMIN_API = Object.freeze(["/api/admin/tasks", "/api/admin/novels", "/api/admin/site-settings"]);

const RSC_HEADERS = [["RSC", "1"]];
const RSC_PREFETCH_HEADERS = [
  ["RSC", "1"],
  ["Next-Router-Prefetch", "1"],
];
const SEGMENT_PREFETCH_HEADERS = (segment) => [
  ["RSC", "1"],
  ["Next-Router-Prefetch", "1"],
  ["Next-Router-Segment-Prefetch", segment],
];

/**
 * Transport / smuggling variants of one admin path `p`.
 * Each returns { target, headers } — `target` is sent byte-for-byte as the request-target.
 */
export function pathVariants(p, buildId) {
  const first = p.charAt(1);
  const encodedFirst = `/%${first.charCodeAt(0).toString(16).toUpperCase()}${p.slice(2)}`;
  const upperFirst = `/${first.toUpperCase()}${p.slice(2)}`;
  const variants = [
    ["plain", { target: p, headers: [] }],
    // --- App Router transport variants (GHSA-267c-6grr-h53f / GHSA-26hh-7cqf-hhc6) ---
    ["rsc-suffix", { target: `${p}.rsc`, headers: [] }],
    ["rsc-suffix+rsc-header", { target: `${p}.rsc`, headers: RSC_HEADERS }],
    ["rsc-suffix+query", { target: `${p}.rsc?_rsc=abc12`, headers: RSC_PREFETCH_HEADERS }],
    ["rsc-header-only", { target: p, headers: RSC_HEADERS }],
    ["rsc-header+prefetch+query", { target: `${p}?_rsc=abc12`, headers: RSC_PREFETCH_HEADERS }],
    ["segment-tree", { target: `${p}.segments/_tree.segment.rsc`, headers: SEGMENT_PREFETCH_HEADERS("/_tree") }],
    ["segment-page", { target: `${p}.segments/__PAGE__.segment.rsc`, headers: SEGMENT_PREFETCH_HEADERS("/__PAGE__") }],
    ["segment-head", { target: `${p}.segments/_head.segment.rsc`, headers: SEGMENT_PREFETCH_HEADERS("/_head") }],
    ["segment-index", { target: `${p}.segments/_index.segment.rsc`, headers: SEGMENT_PREFETCH_HEADERS("/_index") }],
    ["segment-nested", { target: `${p}.segments/__PAGE__/x.segment.rsc`, headers: SEGMENT_PREFETCH_HEADERS("/__PAGE__") }],
    ["segment-header-only", { target: p, headers: SEGMENT_PREFETCH_HEADERS("/_tree") }],
    ["segment-no-headers", { target: `${p}.segments/_tree.segment.rsc`, headers: [] }],
    // --- Pages-Router-style data routes (GHSA-36qx-fr4f-26g5 is Pages Router only; App Router must 404 them) ---
    ["next-data", { target: `/_next/data/${buildId}${p}.json`, headers: [["x-nextjs-data", "1"]] }],
    ["next-data-en", { target: `/_next/data/${buildId}/en${p}.json`, headers: [["x-nextjs-data", "1"]] }],
    ["next-data-header-only", { target: p, headers: [["x-nextjs-data", "1"]] }],
    ["json-suffix", { target: `${p}.json`, headers: [] }],
    ["index-suffix", { target: `${p}/index`, headers: [] }],
    // --- Dynamic-route parameter injection (GHSA-492v-c6pp-mqqv) ---
    ["query-nxtP", { target: `${p}?nxtPid=x&nxtPlocale=%25%25drp%3Alocale%3Aabc%25%25`, headers: [] }],
    ["query-nextDataReq", { target: `${p}?__nextDataReq=1&__nextLocale=en&__nextDefaultLocale=en`, headers: [] }],
    ["query-inferred-locale", { target: `${p}?__nextInferredLocaleFromDefault=1&__nextNotFoundSrcPage=${encodeURIComponent(p)}`, headers: [] }],
    // --- Generic path normalisation tricks ---
    ["trailing-slash", { target: `${p}/`, headers: [] }],
    ["double-slash", { target: `/${p}`, headers: [] }],
    ["dot-segment", { target: `/.${p}`, headers: [] }],
    ["dotdot-segment", { target: `/x/..${p}`, headers: [] }],
    ["percent-encoded-first-char", { target: encodedFirst, headers: [] }],
    ["percent-encoded-slash", { target: `${p}%2f`, headers: [] }],
    ["uppercase-first-char", { target: upperFirst, headers: [] }],
    ["semicolon", { target: `${p};x=1`, headers: [] }],
    ["nul-byte", { target: `${p}%00`, headers: [] }],
    ["backslash", { target: `${p}%5c`, headers: [] }],
    // B-24: every shape src/server/auth/registry.ts normalizePath() cannot normalise (upper-case encodings,
    // malformed percent sequence) must be treated as "admin" by the proxy, never as a public path.
    ["percent-encoded-slash-upper", { target: `${p}%2F`, headers: [] }],
    ["backslash-upper", { target: `${p}%5C`, headers: [] }],
    ["malformed-percent", { target: `${p}%E0%A4%A`, headers: [] }],
    // --- Matcher-exclusion abuse: the proxy matcher skips /_next/static, /_next/image, favicon, icon., apple-icon ---
    ["under-next-static", { target: `/_next/static/..${p}`, headers: [] }],
    ["under-favicon", { target: `/favicon.ico/..${p}`, headers: [] }],
    ["under-icon-dot", { target: `/icon./..${p}`, headers: [] }],
    ["under-apple-icon", { target: `/apple-icon/..${p}`, headers: [] }],
    // --- Internal / hop-by-hop headers a client should never be able to steer routing with ---
    ["hdr-x-matched-path", { target: p, headers: [["x-matched-path", p]] }],
    ["hdr-x-invoke", { target: p, headers: [["x-invoke-path", p], ["x-invoke-query", "{}"], ["x-invoke-status", "200"]] }],
    ["hdr-x-middleware-prefetch", { target: p, headers: [["x-middleware-prefetch", "1"], ["x-middleware-rewrite", p]] }],
    ["hdr-x-middleware-subrequest", { target: p, headers: [["x-middleware-subrequest", "middleware:middleware:middleware:middleware:middleware"]] }],
    ["hdr-x-middleware-subrequest-proxy", { target: p, headers: [["x-middleware-subrequest", "proxy:proxy:proxy:proxy:proxy"]] }],
    ["hdr-x-middleware-subrequest-src", { target: p, headers: [["x-middleware-subrequest", "src/proxy:src/proxy:src/proxy:src/proxy:src/proxy"]] }],
    ["hdr-x-nextjs-rewritten", { target: p, headers: [["x-nextjs-rewritten-path", p], ["x-nextjs-rewritten-query", ""]] }],
  ];
  return variants.map(([name, v]) => ({ name, ...v }));
}

/**
 * Variants whose request-target registry.ts normalizePath() cannot normalise (encoded slash/backslash in any case,
 * malformed percent sequence). src/proxy.ts must answer all of them with its own bare 404 on the public host (they
 * are never "public"), and — because the admin host serves only provable admin paths — on the admin host as well.
 */
export const UNNORMALIZABLE_VARIANTS = Object.freeze([
  "percent-encoded-slash",
  "percent-encoded-slash-upper",
  "backslash",
  "backslash-upper",
  "malformed-percent",
]);

/** Host-header smuggling variants — request the admin path while *claiming* to be the admin host by other means. */
export function hostSmugglingVariants(p, publicHost, adminHost) {
  return [
    ["xfh-admin", { target: p, hostHeader: publicHost, headers: [["X-Forwarded-Host", adminHost]] }],
    ["x-original-host", { target: p, hostHeader: publicHost, headers: [["X-Original-Host", adminHost], ["X-Host", adminHost]] }],
    ["forwarded-host", { target: p, hostHeader: publicHost, headers: [["Forwarded", `host=${adminHost};proto=https`]] }],
    ["x-original-url", { target: p, hostHeader: publicHost, headers: [["X-Original-URL", p], ["X-Rewrite-URL", p]] }],
    ["absolute-form-admin", { target: `http://${adminHost}${p}`, hostHeader: publicHost, headers: [] }],
    ["absolute-form-public-host-admin-path", { target: `http://${publicHost}${p}`, hostHeader: publicHost, headers: [] }],
    ["host-with-port", { target: p, hostHeader: `${publicHost}:443`, headers: [] }],
    ["host-uppercase", { target: p, hostHeader: publicHost.toUpperCase(), headers: [] }],
    ["host-trailing-dot", { target: p, hostHeader: `${publicHost}.`, headers: [] }],
    ["host-userinfo", { target: p, hostHeader: `${adminHost}@${publicHost}`, headers: [] }],
    ["host-suffix", { target: p, hostHeader: `${publicHost}.evil.test`, headers: [] }],
    ["host-prefix", { target: p, hostHeader: `evil.${adminHost}`, headers: [] }],
  ].map(([name, v]) => ({ name, ...v }));
}

// ---------------------------------------------------------------------------
// Raw HTTP/1.1 client — sends the request-target byte-for-byte, no normalisation.
// ---------------------------------------------------------------------------

function dechunk(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset, "latin1");
    if (lineEnd < 0) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

export function parseRawResponse(raw) {
  const separator = raw.indexOf("\r\n\r\n", 0, "latin1");
  if (separator < 0) return { status: 0, headers: {}, rawHeaders: [], body: "", parseError: "no header terminator" };
  const head = raw.subarray(0, separator).toString("latin1").split("\r\n");
  const statusMatch = /^HTTP\/\d\.\d (\d{3})/.exec(head[0] ?? "");
  const headers = {};
  const rawHeaders = [];
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    rawHeaders.push([name, value]);
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  let bodyBuffer = raw.subarray(separator + 4);
  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) bodyBuffer = dechunk(bodyBuffer);
  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    headers,
    rawHeaders,
    body: bodyBuffer.toString("utf8"),
  };
}

export function rawRequest({ host, port, method = "GET", target, hostHeader, headers = [], body = "", timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    const lines = [`${method} ${target} HTTP/1.1`];
    if (hostHeader !== null) lines.push(`Host: ${hostHeader}`);
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    lines.push("Connection: close");
    if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    const payload = Buffer.from(`${lines.join("\r\n")}\r\n\r\n${body}`, "latin1");
    const chunks = [];
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const raw = Buffer.concat(chunks);
      resolve({ ...parseRawResponse(raw), ...extra });
    };
    socket.setTimeout(timeoutMs, () => finish({ timeout: true }));
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => finish({}));
    socket.on("close", () => finish({}));
    socket.on("error", (error) => finish({ socketError: String(error?.code ?? error?.message ?? error) }));
  });
}

// ---------------------------------------------------------------------------
// Outcome classification and per-probe invariants
// ---------------------------------------------------------------------------

/** Compact label of what came back — used in the report, never in the pass/fail logic. */
export function classify(response) {
  if (response.socketError) return `socket-error:${response.socketError}`;
  if (response.timeout) return "timeout";
  const { status, headers, body } = response;
  if (status === 404) return body.length === 0 ? "404-empty(proxy-deny-signature)" : "404-next-page";
  if (status >= 300 && status < 400) {
    if (headers.location) return `${status}->${headers.location.slice(0, 60)}`;
    if (headers["x-nextjs-redirect"]) return `${status}-LOCATION-LOST(x-nextjs-redirect=${headers["x-nextjs-redirect"].slice(0, 40)})`;
    return `${status}-no-location`;
  }
  return String(status);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function locationPath(response) {
  const location = response.headers.location;
  if (!location) return null;
  try {
    return new URL(location, "http://placeholder.invalid").pathname;
  } catch {
    return location;
  }
}

/** Public host + admin path: the only acceptable answer is a 404 (bare proxy denial, or Next finding no route). */
export function expectPublicAdminPath404(response) {
  if (response.status === 404) return null;
  return `public host reached an admin path: status=${response.status} (${classify(response)})`;
}

/** Same, but additionally requires the *proxy's* own signature (bare 404 with an empty body) — used for the plain, unmangled path. */
export function expectProxyDenialSignature(response) {
  if (response.status === 404 && response.body.length === 0) return null;
  return `expected the proxy's bare 404 denial, got ${classify(response)}`;
}

/**
 * Public host + an ordinary public URL: the proxy's own bare 404 denial is never acceptable (the fail-closed path rule
 * of B-24 must not swallow legitimate URLs: percent-encoded non-ASCII slugs, query strings, sitemap/icon/robots/health).
 * Whatever Next answers (200, a rendered 404 page, a 503 "sitemap unavailable" in the disposable empty database) has a
 * body; only the proxy's `new NextResponse(null, { status: 404 })` is empty. `requireNo5xx` additionally rejects 5xx
 * for pages that must render even in an empty database.
 */
export function expectPublicPathNotDenied(response, { requireNo5xx = false } = {}) {
  if (response.status === 404 && response.body.length === 0) return `public URL was denied by the proxy's bare 404: ${classify(response)}`;
  if (response.status === 0) return `no response: ${classify(response)}`;
  if (requireNo5xx && response.status >= 500) return `public URL failed: ${classify(response)}`;
  return null;
}

/** For request shapes no browser produces (absolute-form targets): a 404 or a redirect is fine, served content or a 5xx is not. */
export function expectNoContentServed(response) {
  if (response.status === 404 || REDIRECT_STATUSES.has(response.status)) return null;
  return `unexpected answer to a malformed request: ${classify(response)}`;
}

/**
 * The page guard's answer for "no session": a real 307/308 to /login, or — for routes
 * with a `loading.tsx` shell, where Next has already sent `200` and started streaming when
 * `redirect()` fires — the in-stream `<meta id="__next-page-redirect" http-equiv="refresh"
 * content="1;url=/login?...">` that Next emits instead (same guard, different transport).
 */
export function isGuardRedirect(response) {
  if (REDIRECT_STATUSES.has(response.status)) {
    const path = locationPath(response);
    return path === "/login" || path === "/two-factor/setup" || path === "/two-factor/challenge";
  }
  return response.status === 200
    && /<meta[^>]+id="__next-page-redirect"[^>]+http-equiv="refresh"[^>]+content="\d+;url=\/(?:login|two-factor)/.test(response.body);
}

/** Next answers an `x-middleware-prefetch` request that the proxy let through with an empty JSON object and no page. */
function isEmptyPrefetchAnswer(response) {
  return response.status === 200 && response.body.trim() === "{}";
}

function isPrefetchRequest(context) {
  return (context?.requestHeaders ?? []).some(([name]) => /^next-router-(?:segment-)?prefetch$/i.test(name));
}

/**
 * Admin host + protected page, no session: never served content, never a 5xx; a redirect must go to the login flow.
 *
 * `context.requestHeaders` lets the check tell RSC *flight* answers apart:
 *   - a flight payload carrying NEXT_REDIRECT is the guard's answer over the RSC transport;
 *   - a route-tree/shell *prefetch* (Next-Router-Prefetch / -Segment-Prefetch) never executes a dynamic
 *     page, so it contains the layout shell but none of the page's output or data;
 *   - a payload that does not mention the `(admin)` route group resolved to a public route.
 * Anything else that is a 200 flight payload of an `(admin)` page means the page rendered without the guard.
 */
export function expectAdminPageUnauthenticated(response, context) {
  const { status } = response;
  if (status >= 500 || status === 0) return `server error / no response: ${classify(response)}`;
  if (isGuardRedirect(response)) return null;
  if (REDIRECT_STATUSES.has(status)) return `redirect to an unexpected place: ${classify(response)}`;
  if (status === 404) return null; // route not resolvable in this transport shape — nothing exposed
  if (status === 401 || status === 403 || status === 400 || status === 405) return null;
  if (isEmptyPrefetchAnswer(response)) return null;
  if (status === 200 && /text\/x-component/i.test(response.headers["content-type"] ?? "")) {
    if (/NEXT_REDIRECT/.test(response.body)) return null;
    if (isPrefetchRequest(context)) return null;
    if (!response.body.includes("(admin)")) return null;
    return `admin page rendered over RSC without the guard's redirect: ${classify(response)}`;
  }
  return `unauthenticated request was served: ${classify(response)}`;
}

/** Admin host + /api/admin/*: session guard answers 401/403; 404/405 are fine, 2xx/5xx are not. */
export function expectAdminApiUnauthenticated(response) {
  const { status } = response;
  if (status === 401 || status === 403 || status === 404 || status === 405 || status === 400) return null;
  if (isEmptyPrefetchAnswer(response)) return null;
  return `unauthenticated API request answered ${classify(response)}`;
}

function bodyLeaksAdminUi(response) {
  return /海外阅读后台|admin-shell|cps_admin/.test(response.body);
}

// ---------------------------------------------------------------------------
// Probe matrix
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, group: string, ghsa?: string, hostRole: "public"|"admin", target: string,
 *   hostHeader?: string, method?: string, headers?: Array<[string,string]>, body?: string,
 *   noFollow?: boolean, knownFinding?: string,
 *   check: (response: any, context?: any) => (string|null), control?: boolean }} Probe
 */

/** @returns {Probe[]} */
export function buildProbes({ publicHost = PUBLIC_HOST_DEFAULT, adminHost = ADMIN_HOST_DEFAULT, buildId = "BUILDID" } = {}) {
  /** @type {Probe[]} */
  const probes = [];
  const add = (probe) => probes.push({ headers: [], ...probe });

  // ---- Controls: if these fail the harness is not talking to the app we think it is (exit 2). ----
  add({ id: "control/public-home-200", group: "control", control: true, hostRole: "public", target: "/",
    check: (r) => (r.status === 200 ? null : `public home should be 200, got ${classify(r)}`) });
  add({ id: "control/public-health-shared-path", group: "control", control: true, hostRole: "public", target: "/api/health",
    check: (r) => (r.status === 200 || r.status === 503 ? null : `health should answer 200/503 on the public host, got ${classify(r)}`) });
  add({ id: "control/admin-health-shared-path", group: "control", control: true, hostRole: "admin", target: "/api/health",
    check: (r) => (r.status === 200 || r.status === 503 ? null : `health should answer 200/503 on the admin host, got ${classify(r)}`) });
  add({ id: "control/admin-login-200", group: "control", control: true, hostRole: "admin", target: "/login",
    check: (r) => (r.status === 200 ? null : `admin-host /login should render, got ${classify(r)}`) });
  add({ id: "control/public-admin-path-proxy-deny", group: "control", control: true, hostRole: "public", target: "/novels",
    check: expectProxyDenialSignature });
  add({ id: "control/public-login-proxy-deny", group: "control", control: true, hostRole: "public", target: "/login",
    check: expectProxyDenialSignature });
  add({ id: "control/public-admin-api-proxy-deny", group: "control", control: true, hostRole: "public", target: "/api/admin/tasks",
    check: expectProxyDenialSignature });
  add({ id: "control/admin-public-path-proxy-deny", group: "control", control: true, hostRole: "admin", target: "/browse",
    check: expectProxyDenialSignature });
  add({ id: "control/admin-unauth-page-guard-redirect", group: "control", control: true, hostRole: "admin", target: "/novels",
    check: (r) => (isGuardRedirect(r) ? null : `unauthenticated admin page should be answered by the page guard's /login redirect, got ${classify(r)}`) });
  add({ id: "control/admin-unauth-api-401", group: "control", control: true, hostRole: "admin", target: "/api/admin/tasks",
    check: (r) => (r.status === 401 || r.status === 403 ? null : `unauthenticated admin API should be 401/403, got ${classify(r)}`) });

  // ---- Public host: every admin path x every transport variant must be a 404. ----
  const adminPathsOnPublic = [...PROBE_ADMIN_PAGES, ...PROBE_AUTH_PAGES, ...PROBE_ADMIN_API];
  for (const p of adminPathsOnPublic) {
    for (const variant of pathVariants(p, buildId)) {
      add({
        id: `public/${p}/${variant.name}`,
        group: "public-host-admin-path",
        ghsa: variant.name.startsWith("segment") || variant.name.startsWith("rsc")
          ? "GHSA-267c-6grr-h53f,GHSA-26hh-7cqf-hhc6"
          : variant.name.startsWith("query")
            ? "GHSA-492v-c6pp-mqqv"
            : variant.name.startsWith("next-data")
              ? "GHSA-36qx-fr4f-26g5"
              : undefined,
        hostRole: "public",
        target: variant.target,
        headers: variant.headers,
        // The plain path and every request-target the registry cannot normalise must be the *proxy's* own bare 404
        // (B-24: isAdminPath() is fail-closed). Before that fix `/<admin-root>/<id>%2f` / `%5c` slipped through the
        // public-host gate into the dynamic admin routes (`/novels/[novelId]`, `/tasks/[id]`), where only the page
        // guard (and nginx's admin-root regex in production) stood in the way; that used to be listed here as the
        // KNOWN_FINDING `PROXY-NORMALIZE-FAILOPEN`. The knownFinding mechanism itself stays for future categories.
        check: variant.name === "plain" || UNNORMALIZABLE_VARIANTS.includes(variant.name)
          ? expectProxyDenialSignature
          : expectPublicAdminPath404,
      });
    }
  }

  // ---- Public host: ordinary public URLs must not be caught by the fail-closed path rule (B-24). ----
  // Percent-encoded non-ASCII slugs (the real shape of ko/ja/ru/... novel URLs), query strings, and the
  // non-page routes (sitemap, robots, icons) all normalise fine and must keep reaching Next.
  for (const [name, target, requireNo5xx] of [
    ["ko-percent-encoded-slug", "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd", true],
    ["ja-percent-encoded-slug", "/ja/novel/%E6%9D%B1%E4%BA%AC%E3%81%AE%E7%A9%BA-p1234abcd", true],
    ["ru-percent-encoded-slug", "/ru/novel/%D0%BB%D1%8E%D0%B1%D0%BE%D0%B2%D1%8C-p1234abcd", true],
    ["percent-encoded-slug-with-query", "/ko/novel/%EC%84%9C%EC%9A%B8%EC%9D%98-%EB%B4%84-p1234abcd?utm_source=x&q=%E3%81%82", true],
    ["browse-with-query", "/browse?page=2&q=%E3%81%82", true],
    ["locale-browse", "/ko/browse", true],
    ["sitemap-index", "/sitemap.xml", false],
    ["sitemap-file", "/sitemap/site_mainpage_ko.xml", false],
    ["robots", "/robots.txt", true],
    ["icon", "/icon", true],
    ["apple-icon", "/apple-icon", true],
  ]) {
    add({
      id: `public-legit/${name}`,
      group: "public-host-legit-path",
      hostRole: "public",
      target,
      check: (r) => expectPublicPathNotDenied(r, { requireNo5xx }),
    });
  }

  // ---- Public host: Host-header smuggling toward the admin host. ----
  for (const p of ["/novels", "/login", "/api/admin/tasks", `/novels/${ZERO_UUID}`]) {
    for (const variant of hostSmugglingVariants(p, publicHost, adminHost)) {
      add({
        id: `host/${p}/${variant.name}`,
        group: "host-smuggling",
        hostRole: "public",
        target: variant.target,
        hostHeader: variant.hostHeader,
        headers: variant.headers,
        // Node/Next derive the Host from the Host header, not the absolute-form target: still public -> 404.
        // "host-suffix"/"host-prefix"/"host-userinfo" are unrecognised hosts: admin paths fail closed (404) there too.
        // An absolute-form request-target (`GET http://host/path`) is something no browser sends; Next answers it
        // with a same-shape 308 normalisation redirect, so the invariant is only "no content, no 5xx".
        check: variant.name.startsWith("absolute-form") ? expectNoContentServed : expectPublicAdminPath404,
      });
    }
  }

  // ---- Public host: steer the router with internal headers while the visible path is public. ----
  for (const visible of ["/", "/browse"]) {
    for (const [name, headers] of [
      ["x-matched-path", [["x-matched-path", "/novels"]]],
      ["x-invoke-path", [["x-invoke-path", "/novels"], ["x-invoke-query", "{}"]]],
      ["x-nextjs-rewritten-path", [["x-nextjs-rewritten-path", "/novels"]]],
      ["x-middleware-rewrite", [["x-middleware-rewrite", "/novels"]]],
      ["rsc-segment-header", [["RSC", "1"], ["Next-Router-Segment-Prefetch", "/novels"]]],
    ]) {
      add({
        id: `public-hijack/${visible}/${name}`,
        group: "public-page-hijack",
        hostRole: "public",
        target: visible,
        headers,
        check: (r) => {
          if (REDIRECT_STATUSES.has(r.status) && (locationPath(r) ?? "").startsWith("/login")) return `public page ${visible} was steered into the admin guard (${classify(r)})`;
          if (bodyLeaksAdminUi(r)) return `public page ${visible} rendered admin UI`;
          return null;
        },
      });
    }
  }

  // ---- Public host: Server Action POSTs aimed at admin pages. ----
  for (const p of ["/login", "/novels", "/settings"]) {
    add({
      id: `public/server-action-post${p}`,
      group: "public-host-admin-path",
      hostRole: "public",
      method: "POST",
      target: p,
      headers: [["Next-Action", "0000000000000000000000000000000000000000"], ["Content-Type", "text/plain;charset=UTF-8"], ["Accept", "text/x-component"]],
      body: "[]",
      check: expectPublicAdminPath404,
    });
  }

  // ---- Admin host: protected pages without a session, across transport variants. ----
  for (const p of PROBE_ADMIN_PAGES) {
    for (const variant of pathVariants(p, buildId)) {
      // Path-mangling variants are meaningless on the admin host if they leave the admin namespace; they must still never serve content.
      add({
        id: `admin/${p}/${variant.name}`,
        group: "admin-host-protected-page",
        ghsa: variant.name.startsWith("segment") || variant.name.startsWith("rsc") ? "GHSA-267c-6grr-h53f,GHSA-26hh-7cqf-hhc6" : undefined,
        hostRole: "admin",
        target: variant.target,
        headers: variant.headers,
        // An un-normalisable path is not provably an admin path, and the admin host serves nothing else (RC-9):
        // it must be the proxy's bare 404 there too — neither served, nor bounced to /login by the page guard.
        check: UNNORMALIZABLE_VARIANTS.includes(variant.name) ? expectProxyDenialSignature : expectAdminPageUnauthenticated,
      });
    }
  }
  for (const p of PROBE_ADMIN_API) {
    for (const variant of pathVariants(p, buildId).filter((v) => !v.name.startsWith("segment") && !v.name.startsWith("next-data"))) {
      add({
        id: `admin/${p}/${variant.name}`,
        group: "admin-host-api",
        hostRole: "admin",
        target: variant.target,
        headers: variant.headers,
        check: UNNORMALIZABLE_VARIANTS.includes(variant.name) ? expectProxyDenialSignature : expectAdminApiUnauthenticated,
      });
    }
  }

  // ---- GHSA-3g8h-86w9-wvmq: external `x-nextjs-data` must not rewrite the proxy's own redirect. ----
  add({
    id: "redirect/en-prefix-308-keeps-location",
    group: "proxy-redirect-integrity",
    noFollow: true,
    ghsa: "GHSA-3g8h-86w9-wvmq",
    hostRole: "public",
    target: "/en/browse?x=1",
    check: (r) => (r.status === 308 && r.headers.location && !r.headers["x-nextjs-redirect"] ? null : `plain /en/browse redirect malformed: ${classify(r)}`),
    control: true,
  });
  add({
    id: "redirect/en-prefix-with-x-nextjs-data",
    group: "proxy-redirect-integrity",
    noFollow: true,
    ghsa: "GHSA-3g8h-86w9-wvmq",
    hostRole: "public",
    target: "/en/browse?x=1",
    headers: [["x-nextjs-data", "1"]],
    check: (r) => (r.status === 308 && r.headers.location && !r.headers["x-nextjs-redirect"]
      ? null
      : `external x-nextjs-data changed the proxy redirect (would be cacheable poison behind a caching edge): ${classify(r)}`),
  });
  add({
    id: "redirect/en-prefix-with-x-nextjs-data-and-ndr",
    group: "proxy-redirect-integrity",
    noFollow: true,
    ghsa: "GHSA-3g8h-86w9-wvmq",
    hostRole: "public",
    target: "/en/browse?x=1",
    headers: [["x-nextjs-data", "1"], ["x-nextjs-data-request", "1"]],
    check: (r) => (r.status === 308 && r.headers.location && !r.headers["x-nextjs-redirect"] ? null : `external x-nextjs-data changed the proxy redirect: ${classify(r)}`),
  });
  add({
    id: "redirect/root-negotiation-with-x-nextjs-data",
    group: "proxy-redirect-integrity",
    noFollow: true,
    ghsa: "GHSA-3g8h-86w9-wvmq",
    hostRole: "public",
    target: "/",
    headers: [["Accept-Language", "ja,en;q=0.5"], ["x-nextjs-data", "1"]],
    // With no data header the negotiator may or may not redirect; the invariant is only "never a Location-less 3xx".
    check: (r) => (REDIRECT_STATUSES.has(r.status) && !r.headers.location ? `root negotiation redirect lost its Location: ${classify(r)}` : null),
  });

  // ---- Next-auth-shaped inputs (GHSA-xmf8 / GHSA-8fpg are next-auth advisories; this repo has no next-auth).
  //      These prove there is no equivalent "malformed Authorization header -> 500" path here. ----
  for (const [name, value] of [["percent", "Bearer %"], ["bad-percent", "Bearer %E0%A4%A"], ["empty", "Bearer "], ["garbage", "Bearer \u0001\u0002"], ["basic", "Basic !!!"]]) {
    add({
      id: `bearer/admin-page/${name}`,
      group: "malformed-authorization",
      ghsa: "GHSA-xmf8-cvqr-rfgj(next-auth; n/a)",
      hostRole: "admin",
      target: "/novels",
      headers: [["Authorization", value]],
      check: expectAdminPageUnauthenticated,
    });
    add({
      id: `bearer/admin-api/${name}`,
      group: "malformed-authorization",
      ghsa: "GHSA-xmf8-cvqr-rfgj(next-auth; n/a)",
      hostRole: "admin",
      target: "/api/admin/tasks",
      headers: [["Authorization", value]],
      check: expectAdminApiUnauthenticated,
    });
    add({
      id: `bearer/public-page/${name}`,
      group: "malformed-authorization",
      ghsa: "GHSA-xmf8-cvqr-rfgj(next-auth; n/a)",
      hostRole: "public",
      target: "/browse",
      headers: [["Authorization", value]],
      check: (r) => (r.status >= 500 || r.status === 0 ? `public page failed under a malformed Authorization header: ${classify(r)}` : null),
    });
  }

  return probes;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

const SAME_SITE_NO_FOLLOW = /^\/(?:login|two-factor)(?:\/|$)/;

/**
 * Sends the probe, then behaves like a browser for *normalisation* redirects only
 * (trailing slash, `//`, the proxy's own `/en/*` -> `/*` 308): same-host hops are
 * re-sent with the same Host and headers, at most 3 times. A non-308 hop into
 * /login or /two-factor is never followed (that redirect *is* the page guard's
 * answer), and cross-host hops are recorded, not followed. `probe.noFollow`
 * disables following.
 */
async function sendProbe({ host, port, probe, hostHeader }) {
  const first = await rawRequest({
    host,
    port,
    method: probe.method ?? "GET",
    target: probe.target,
    hostHeader,
    headers: probe.headers,
    body: probe.body ?? "",
  });
  const hops = [];
  let response = first;
  let currentHost = hostHeader;
  let crossHostRedirect = false;
  for (let hop = 0; hop < 3 && !probe.noFollow; hop += 1) {
    if (!REDIRECT_STATUSES.has(response.status)) break;
    const raw = response.headers.location ?? response.headers["x-nextjs-redirect"];
    if (!raw) break;
    let url;
    try {
      url = new URL(raw, `http://${currentHost}`);
    } catch {
      break;
    }
    const sameHost = url.hostname.toLowerCase() === (normalizeHostname(currentHost) ?? "");
    if (!sameHost) {
      crossHostRedirect = true;
      break;
    }
    if (response.status !== 308 && SAME_SITE_NO_FOLLOW.test(url.pathname)) break;
    hops.push({ status: response.status, to: `${url.pathname}${url.search}` });
    currentHost = url.host;
    response = await rawRequest({
      host,
      port,
      method: "GET",
      target: `${url.pathname}${url.search}`,
      hostHeader: hostHeader,
      headers: probe.headers,
    });
  }
  return { first, response, hops, crossHostRedirect };
}

function normalizeHostname(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function snippet(response) {
  return response.body.replace(/\s+/g, " ").slice(0, 160);
}

export async function runProbes({ host, port, publicHost, adminHost, buildId, concurrency = 6 }) {
  const probes = buildProbes({ publicHost, adminHost, buildId });
  const results = await runPool(probes, concurrency, async (probe) => {
    const hostHeader = probe.hostHeader ?? (probe.hostRole === "admin" ? adminHost : publicHost);
    const { first, response, hops, crossHostRedirect } = await sendProbe({ host, port, probe, hostHeader });
    let problem = null;
    try {
      problem = probe.check(response, { first, hops, crossHostRedirect, requestHeaders: probe.headers });
    } catch (error) {
      problem = `check threw: ${error?.message ?? error}`;
    }
    const knownFinding = problem !== null && probe.knownFinding ? probe.knownFinding : null;
    return {
      id: probe.id,
      group: probe.group,
      ghsa: probe.ghsa ?? null,
      control: Boolean(probe.control),
      hostRole: probe.hostRole,
      target: probe.target,
      requestHeaders: probe.headers,
      status: response.status,
      outcome: `${hops.length ? `[${hops.map((h) => `${h.status}->${h.to}`).join(" ; ")}] ` : ""}${classify(response)}`,
      location: response.headers.location ?? null,
      guardAnswered: isGuardRedirect(response),
      ok: problem === null || knownFinding !== null,
      knownFinding,
      problem,
      bodySnippet: problem !== null || probe.control ? snippet(response) : undefined,
      contentType: response.headers["content-type"] ?? null,
      bodyHead: probe.control || probe.id.endsWith("/plain")
        ? response.body.slice(0, 3500)
        : response.status === 200 ? response.body.slice(0, 700) : undefined,
    };
  });
  return results;
}

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    publicHost: PUBLIC_HOST_DEFAULT,
    adminHost: ADMIN_HOST_DEFAULT,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--port") options.port = Number(value());
    else if (arg === "--host") options.host = value();
    else if (arg === "--public-host") options.publicHost = value();
    else if (arg === "--admin-host") options.adminHost = value();
    else if (arg === "--build-id") options.buildId = value();
    else if (arg === "--build-id-file") options.buildId = readFileSync(value(), "utf8").trim();
    else if (arg === "--next-version") options.nextVersion = value();
    else if (arg === "--json-out") options.jsonOut = value();
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--strict") options.strict = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port is required");
  options.buildId ??= "BUILDID";
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const results = await runProbes(options);
  const knownFindings = results.filter((r) => r.knownFinding);
  const failed = results.filter((r) => !r.ok || (options.strict && r.knownFinding));
  const controlFailed = failed.filter((r) => r.control && r.group === "control");
  const byGroup = new Map();
  for (const r of results) {
    const g = byGroup.get(r.group) ?? { total: 0, failed: 0 };
    g.total += 1;
    if (!r.ok) g.failed += 1;
    byGroup.set(r.group, g);
  }
  const outcomeHistogram = {};
  for (const r of results.filter((x) => x.group === "public-host-admin-path" || x.group === "host-smuggling")) {
    const key = r.outcome.replace(/->.*/, "->…");
    outcomeHistogram[key] = (outcomeHistogram[key] ?? 0) + 1;
  }
  const knownFindingIds = {};
  for (const r of knownFindings) knownFindingIds[r.knownFinding] = (knownFindingIds[r.knownFinding] ?? 0) + 1;
  const summary = {
    nextVersion: options.nextVersion ?? "unknown",
    total: results.length,
    failed: failed.length,
    knownFindings: knownFindingIds,
    byGroup: Object.fromEntries(byGroup),
    publicHostAdminPathOutcomes: outcomeHistogram,
  };

  for (const r of options.verbose ? results : failed) {
    console.log(`${r.ok ? "ok  " : "FAIL"} [${r.group}] ${r.hostRole} ${r.id} -> ${r.outcome}${r.problem ? `  :: ${r.problem}` : ""}`);
  }
  for (const r of knownFindings) {
    console.log(`KNOWN_FINDING ${r.knownFinding} [${r.hostRole}] ${r.id} -> ${r.outcome}${r.guardAnswered ? " (page guard answered: the admin route was reached)" : ""}`);
  }
  console.log(`NEXT_PROXY_PROBE_SUMMARY ${JSON.stringify(summary)}`);
  if (options.jsonOut) writeFileSync(options.jsonOut, `${JSON.stringify({ summary, results }, null, 2)}\n`);

  if (controlFailed.length > 0) {
    console.log(`NEXT_PROXY_PROBE=HARNESS_ERROR next=${summary.nextVersion} control_failures=${controlFailed.length}`);
    return 2;
  }
  if (failed.length > 0) {
    console.log(`NEXT_PROXY_PROBE=FAIL next=${summary.nextVersion} failed=${failed.length}/${results.length}`);
    return 1;
  }
  console.log(`NEXT_PROXY_PROBE=PASS next=${summary.nextVersion} probes=${results.length} known_findings=${knownFindings.length}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`NEXT_PROXY_PROBE=HARNESS_ERROR ${error?.message ?? error}`);
      process.exit(2);
    },
  );
}
