import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function renderPublicNginx(mode, upstream, hstsMaxAge = '86400') {
  if (!['rehearsal', 'public'].includes(mode)) throw new Error('invalid mode');
  if (!/^[1-9][0-9]{0,8}$/.test(hstsMaxAge) || Number(hstsMaxAge) > 31536000) throw new Error('invalid HSTS max-age');
  const localeSource = readFileSync(`${root}/src/lib/locale/locale-canonical.ts`, 'utf8');
  const literal = localeSource.match(/export const SITE_LOCALES:[^=]+?= Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1];
  if (!literal || !/^(?:\s|"[a-zA-Z-]+"|,)+$/.test(literal)) throw new Error('SITE_LOCALES literal not found');
  const locales = JSON.parse(`[${literal.replace(/,\s*$/, '')}]`);
  if (!locales.length || new Set(locales).size !== locales.length) throw new Error('invalid SITE_LOCALES');
  let template = readFileSync(`${root}/infra/preproduction/nginx/cps-novel-public.conf.template`, 'utf8');
  const live = mode === 'public';
  const publicHost = live ? 'pulsenovels.com' : 'www.bangbangji.cloud';
  const adminHost = live ? 'zbcwf.pulsenovels.com' : 'zbcwf.bangbangji.cloud';
  if (publicHost === adminHost) throw new Error('public/admin hosts must differ');
  const redirect = (host, target, cert) => `server {
    listen 80;
    server_name ${host};
    location ^~ /.well-known/acme-challenge/ { root /var/lib/letsencrypt; default_type text/plain; try_files $uri =404; }
    location / { return 301 https://${target}$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name ${host};
    ssl_certificate /etc/letsencrypt/live/${cert}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${cert}/privkey.pem;
    location ^~ /.well-known/acme-challenge/ { root /var/lib/letsencrypt; default_type text/plain; try_files $uri =404; }
    location / { return 301 https://${target}$request_uri; }
}`;
  const values = {
    ...Object.fromEntries([...template.matchAll(/^# @([A-Z_]+)=([0-9]+(?:r\/[sm])?)$/gm)].map(m => [m[1], m[2]])),
    UPSTREAM: upstream, SITE_LOCALES: locales.join('|'), PUBLIC_HOST: publicHost, ADMIN_HOST: adminHost,
    PUBLIC_CERT: live ? 'pulsenovels.com' : publicHost, ADMIN_CERT: live ? 'pulsenovels.com' : adminHost,
    PUBLIC_ROBOTS: live ? '' : 'noindex, nofollow, noarchive', PUBLIC_HSTS: live ? `max-age=${hstsMaxAge}` : '',
    PUBLIC_AUTH: live ? 'auth_basic off;' : 'auth_basic "CPS Novel Rehearsal"; auth_basic_user_file /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd;',
    REDIRECT_SERVERS: live ? [redirect('www.pulsenovels.com', publicHost, 'pulsenovels.com'), redirect('www.bangbangji.cloud', publicHost, 'www.bangbangji.cloud'), redirect('zbcwf.bangbangji.cloud', adminHost, 'zbcwf.bangbangji.cloud')].join('\n') : '',
  };
  template = template.replace(/__([A-Z_]+)__/g, (token, key) => values[key] ?? token);
  validateRenderedTopology(template, publicHost, adminHost);
  return template;
}
export function validateRenderedTopology(rendered, publicHost, adminHost) {
  if (publicHost === adminHost) throw new Error('public/admin hosts must differ');
  if (/__[A-Z_]+__/.test(rendered)) throw new Error('unresolved nginx token');
  // Inspect the actual application server blocks, not just the input names:
  // otherwise an accidental PUBLIC_HOST token in the admin TLS block could
  // be hidden by the correctly rendered HTTP redirect block.
  const appHosts = rendered.split(/^server \{/m)
    .filter(block => block.includes('proxy_pass http://cps_novel_edge_web;'))
    .map(block => block.match(/server_name\s+([^;]+);/)?.[1]);
  if (appHosts.length !== 2 || appHosts[0] !== publicHost || appHosts[1] !== adminHost) {
    throw new Error('rendered application topology mismatch');
  }
  for (const host of [publicHost, adminHost]) {
    if (!rendered.includes(`server_name ${host};`)) throw new Error('rendered host missing');
  }
}
// CLI entry detection must survive symlinked release directories: Node locates
// the module by its real path while argv[1] keeps the path the caller typed
// (e.g. /opt/cps-novel/current/...). Comparing the raw strings made the CLI
// exit 0 without writing anything on 2026-10-05 (B second failure). Compare
// real paths, and refuse to emit an empty body so a regression of this guard
// can never again look like a successful render.
function isCliEntry() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isCliEntry()) {
  try {
    const rendered = renderPublicNginx(...process.argv.slice(2));
    if (!rendered.trim()) throw new Error('empty render');
    process.stdout.write(rendered);
  }
  catch (error) { console.error(`NGINX_RENDER=FAIL ${error.message}`); process.exit(65); }
}
