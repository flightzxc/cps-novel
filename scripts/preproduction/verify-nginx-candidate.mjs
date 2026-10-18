// Structural gate for a rendered nginx site candidate, run by the installer
// BEFORE it touches /etc/nginx. `nginx -t` accepts an empty site file, and a
// reload into it removes every 443 server (2026-10-05, second B attempt), so
// syntax validity alone is not evidence that the candidate is the site we meant
// to install. This checks the candidate against the shape of the requested
// mode. It is deliberately independent of the renderer: it re-derives the
// expected hosts from the mode rather than importing the renderer's output.
//
// Output only ever contains check codes, a byte count and a digest; it never
// echoes candidate text, so nothing from htpasswd/cert paths reaches the log.
//
// CLI: node verify-nginx-candidate.mjs --mode MODE [--hsts-max-age SECONDS] FILE
//   exit 0  NGINX_CANDIDATE=PASS mode=... bytes=... sha256=...
//   exit 65 NGINX_CANDIDATE=FAIL mode=... missing=code,code
//   exit 64 usage
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CANDIDATE_MODES = Object.freeze(['public', 'rehearsal', 'preprod', 'bootstrap-public']);

const ADMIN_AUTH = 'auth_basic "CPS Novel Administration";';
const HTPASSWD = 'auth_basic_user_file /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd;';
const PROXY = 'proxy_pass http://cps_novel_edge_web;';

function parseServers(text) {
  // The renderer and every template start each top-level server at column 0.
  return text.split(/^server \{/m).slice(1).map(raw => ({
    raw,
    listens: [...raw.matchAll(/(?:^|[\s;{])listen\s+([^;]+);/g)].map(m => m[1].trim().split(/\s+/)),
    names: [...raw.matchAll(/(?:^|[\s;{])server_name\s+([^;]+);/g)].flatMap(m => m[1].trim().split(/\s+/)),
  }));
}

// Admin host edge gate (Owner 2026-10-18): the console itself is no longer
// behind nginx Basic Auth -- only the monitoring-only health endpoints are.
// Checked per request path, by selecting the location nginx itself would pick,
// so a new location that shadows one of these paths (e.g. an unauthenticated
// `^~ /api/` in front of the health regex) is caught too, not only an edit
// inside the expected location body.
const ADMIN_GATED_PATHS = Object.freeze(['/api/health', '/api/health/worker', '/api/health/backup']);
const ADMIN_OPEN_PATHS = Object.freeze([
  '/login', '/dashboard', '/novels/book', '/revenue', '/settings', '/two-factor', '/two-factor/challenge',
  '/api/admin', '/api/admin/tasks', '/_next/static/chunks/app.js',
]);
const AUTH_DIRECTIVE = /(?:^|[\s;{])auth_basic(?:_user_file)?\s/;

// Full-line comments only: the templates never put a comment after a
// directive, and a comment may legitimately quote braces (`{2}`).
const stripComments = text => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

/** Top-level `location` blocks of one server body, plus its server-level text. */
function parseLocations(serverRaw) {
  const text = stripComments(serverRaw);
  const locations = [];
  let serverLevel = '';
  let cursor = 0;
  const head = /(?:^|[\s;{}])location\s+(=|\^~|~\*|~)?\s*("(?:[^"\\]|\\.)*"|[^\s{]+)\s*\{/g;
  for (let match; (match = head.exec(text));) {
    const open = match.index + match[0].length - 1;
    let depth = 0, quote = false, end = -1;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
      if (c === '"') quote = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    const raw = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
    locations.push({ modifier: match[1] ?? '', path: raw, body: text.slice(open + 1, end) });
    serverLevel += text.slice(cursor, match.index);
    cursor = end + 1;
    head.lastIndex = end + 1;
  }
  serverLevel += text.slice(cursor);
  return { locations, serverLevel };
}

// nginx's own order: an exact `=` match wins; otherwise the longest prefix,
// which ends the search when it is `^~`; otherwise the first regex in file
// order; otherwise that longest prefix.
function selectLocation(locations, uri) {
  const exact = locations.find(l => l.modifier === '=' && l.path === uri);
  if (exact) return exact;
  const prefix = locations.filter(l => (l.modifier === '' || l.modifier === '^~') && uri.startsWith(l.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (prefix?.modifier === '^~') return prefix;
  for (const l of locations) {
    if (l.modifier !== '~' && l.modifier !== '~*') continue;
    try { if (new RegExp(l.path, l.modifier === '~*' ? 'i' : '').test(uri)) return l; }
    catch { return null; }
  }
  return prefix ?? null;
}

const onPort = (server, port) => server.listens.some(([address]) => new RegExp(`(?:^|:)${port}$`).test(address));
const isDefault = server => server.listens.some(tokens => tokens.includes('default_server'));
const certLines = name => [
  `ssl_certificate /etc/letsencrypt/live/${name}/fullchain.pem;`,
  `ssl_certificate_key /etc/letsencrypt/live/${name}/privkey.pem;`,
];

/**
 * @returns {string[]} codes of every failed check; empty means the candidate
 * has the expected shape for `mode`.
 */
export function checkNginxCandidate(text, mode, { hstsMaxAge = '86400' } = {}) {
  if (!CANDIDATE_MODES.includes(mode)) throw new Error('invalid mode');
  if (!/^[1-9][0-9]{0,8}$/.test(String(hstsMaxAge)) || Number(hstsMaxAge) > 31536000) throw new Error('invalid HSTS max-age');
  if (typeof text !== 'string' || !text.trim()) return ['candidate_empty'];

  const servers = parseServers(text);
  const failed = [];
  const check = (code, ok) => { if (!ok) failed.push(code); };
  const find = (port, host, needles = [], { defaultServer = false } = {}) => servers.some(server =>
    onPort(server, port) && server.names.includes(host) && isDefault(server) === defaultServer && needles.every(needle => server.raw.includes(needle)));
  const block = (port, host) => servers.find(server => onPort(server, port) && server.names.includes(host) && !isDefault(server));

  check('tokens_resolved', !/__[A-Z_]+__/.test(text));

  if (mode === 'bootstrap-public') {
    // Additive certificate bootstrap: one HTTP-only server for the three new
    // names, ACME webroot, everything else 404, no TLS and no application.
    const names = ['pulsenovels.com', 'www.pulsenovels.com', 'zbcwf.pulsenovels.com'];
    check('bootstrap_server', servers.some(server => onPort(server, 80) && names.every(name => server.names.includes(name))
      && server.raw.includes('location ^~ /.well-known/acme-challenge/') && server.raw.includes('return 404;')));
    check('bootstrap_http_only', !servers.some(server => onPort(server, 443)) && !text.includes('proxy_pass'));
    return failed;
  }

  if (mode === 'preprod') {
    const pub = 'www.bangbangji.cloud';
    const admin = 'zbcwf.bangbangji.cloud';
    check('reject_http_default', find(80, '_', ['return 444;'], { defaultServer: true }));
    check('reject_https_default', find(443, '_', ['return 404;', ...certLines(pub)], { defaultServer: true }));
    for (const [label, host] of [['public', pub], ['admin', admin]]) {
      check(`${label}_http_redirect`, find(80, host, [`return 301 https://${host}$request_uri;`]));
      check(`${label}_https_app`, find(443, host, ['proxy_pass http://cps_novel_preprod_web;', 'cps-novel-preprod-protected', ...certLines(host)]));
    }
    check('upstream_defined', /upstream cps_novel_preprod_web \{\s*server [^;]+;/.test(text));
    return failed;
  }

  // public (live) and rehearsal share one template and one topology.
  const live = mode === 'public';
  const pub = live ? 'pulsenovels.com' : 'www.bangbangji.cloud';
  const admin = live ? 'zbcwf.pulsenovels.com' : 'zbcwf.bangbangji.cloud';
  const pubCert = live ? 'pulsenovels.com' : pub;
  const adminCert = live ? 'pulsenovels.com' : admin;

  check('upstream_defined', /upstream cps_novel_edge_web \{\s*server [^;]+;/.test(text));
  check('reject_http_default', find(80, '_', ['return 444;'], { defaultServer: true }));
  check('reject_https_default', find(443, '_', ['return 404;', ...certLines(pubCert)], { defaultServer: true }));
  check('public_http_redirect', find(80, pub, [`return 301 https://${pub}$request_uri;`]));
  check('admin_http_redirect', find(80, admin, [`return 301 https://${admin}$request_uri;`]));
  check('public_https_app', find(443, pub, [PROXY, ...certLines(pubCert)]));
  check('admin_https_app', find(443, admin, [PROXY, ...certLines(adminCert)]));

  const publicBlock = block(443, pub)?.raw ?? '';
  const adminBlock = block(443, admin)?.raw ?? '';
  const { locations: adminLocations, serverLevel: adminServerLevel } = parseLocations(adminBlock);
  const served = path => {
    const location = selectLocation(adminLocations, path);
    return location && location.body.includes(PROXY) ? location.body : null;
  };
  check('admin_health_auth', adminBlock !== '' && ADMIN_GATED_PATHS.every(path => {
    const body = served(path);
    return body !== null && body.includes(ADMIN_AUTH) && body.includes(HTPASSWD);
  }));
  check('admin_console_open', adminBlock !== '' && !AUTH_DIRECTIVE.test(adminServerLevel) && ADMIN_OPEN_PATHS.every(path => {
    const body = served(path);
    return body !== null && !AUTH_DIRECTIVE.test(body);
  }));
  check('admin_auth_not_disabled', adminBlock !== '' && !/auth_basic\s+off;/.test(adminBlock));
  if (live) {
    check('public_open', publicBlock.includes('auth_basic off;') && !/auth_basic\s+"/.test(publicBlock));
  } else {
    check('public_rehearsal_auth', publicBlock.includes('auth_basic "CPS Novel Rehearsal";') && publicBlock.includes(HTPASSWD)
      && !/auth_basic\s+off;/.test(publicBlock));
  }

  const robots = live ? '' : 'noindex, nofollow, noarchive';
  const hsts = live ? `max-age=${hstsMaxAge}` : '';
  check('robots_value', text.includes(`map $host $cps_public_robots { default "${robots}"; }`));
  check('hsts_value', text.includes(`map $host $cps_public_hsts { default "${hsts}"; }`));

  const proxied = servers.filter(server => server.raw.includes(PROXY)).map(server => server.names[0]);
  check('app_topology', proxied.length === 2 && proxied[0] === pub && proxied[1] === admin);

  if (live) {
    for (const [code, host, target, cert] of [
      ['www_redirect', 'www.pulsenovels.com', pub, 'pulsenovels.com'],
      ['legacy_public_redirect', 'www.bangbangji.cloud', pub, 'www.bangbangji.cloud'],
      ['legacy_admin_redirect', 'zbcwf.bangbangji.cloud', admin, 'zbcwf.bangbangji.cloud'],
    ]) {
      const redirect = `return 301 https://${target}$request_uri;`;
      check(code, find(80, host, [redirect]) && find(443, host, [redirect, ...certLines(cert)]));
    }
  }
  return failed;
}

function isCliEntry() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isCliEntry()) {
  const usage = () => { console.error('usage: verify-nginx-candidate.mjs --mode MODE [--hsts-max-age SECONDS] FILE'); process.exit(64); };
  const args = process.argv.slice(2);
  let mode = '', hsts = '86400', file = '';
  while (args.length) {
    const arg = args.shift();
    if (arg === '--mode') mode = args.shift() ?? '';
    else if (arg === '--hsts-max-age') hsts = args.shift() ?? '';
    else if (!file && !arg.startsWith('--')) file = arg;
    else usage();
  }
  if (!CANDIDATE_MODES.includes(mode) || !file) usage();
  let bytes;
  try { bytes = readFileSync(file); }
  catch { console.log(`NGINX_CANDIDATE=FAIL mode=${mode} missing=candidate_unreadable`); process.exit(65); }
  let failed;
  try { failed = checkNginxCandidate(bytes.toString('utf8'), mode, { hstsMaxAge: hsts }); }
  catch (error) { console.error(`NGINX_CANDIDATE=FAIL reason=${error.message}`); process.exit(64); }
  if (failed.length) { console.log(`NGINX_CANDIDATE=FAIL mode=${mode} missing=${failed.join(',')}`); process.exit(65); }
  console.log(`NGINX_CANDIDATE=PASS mode=${mode} bytes=${bytes.length} sha256=${createHash('sha256').update(bytes).digest('hex')}`);
}
