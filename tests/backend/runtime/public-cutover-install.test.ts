import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync, readlinkSync, existsSync, copyFileSync, cpSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { renderPublicNginx } from '../../../scripts/preproduction/render-public-nginx.mjs';
import { checkNginxCandidate } from '../../../scripts/preproduction/verify-nginx-candidate.mjs';

// Every installer case below spawns a bash installer, two node children
// (renderer, candidate check) and 10-80 tiny sh stubs (fake sudo/nginx/systemctl/
// pgrep/ps/ss/sleep); the timeout cases walk ten polling rounds. Under the
// full-suite load that makes the default 15s node-project timeout flaky (the
// B-27 family), so the cases that run the installer carry an explicit 60s.
const SLOW = 60_000;
const repoRoot = realpathSync(process.cwd());

const COPIED_SCRIPTS = ['install-nginx.sh', 'install-public-nginx.sh', 'render-nginx.sh', 'render-public-nginx.mjs', 'verify-nginx-candidate.mjs'];

// Every fake command is a tiny POSIX sh script: a python3 interpreter start-up
// costs 100-250 ms per call on a loaded macOS host and the readiness wait polls
// several commands per round. They share plain files under $FIXTURE/host so a
// case can script the nginx master/worker lifecycle. A reload schedules the
// worker handoff to become visible on the k-th pgrep poll afterwards
// (READY_AFTER) and picks what happens to the old workers (OLD_WORKERS); both
// are comma lists indexed by reload number, e.g. "99,1" = the install reload
// never hands off, the rollback reload does.
const FAKE_LIB = `H="$FIXTURE/host"
rd() { if [ -f "$H/$1" ]; then cat "$H/$1"; else printf '%s' "$2"; fi; }
wr() { printf '%s' "$2" > "$H/$1"; }
nth() { v=$(printf '%s' "$1" | awk -F, -v n="$2" '{ print $n }'); if [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "$3"; fi; }
`;
const FAKE_COMMANDS: Record<string, string> = {
  systemctl: `case "$1" in
  show)
    blip=$(rd blip 0)
    if [ "$blip" -gt 0 ]; then wr blip $((blip - 1)); echo 'MainPID=0'; exit 0; fi
    echo "MainPID=$(rd master 0)"; exit 0 ;;
  reload)
    n=$(( $(cat "$FIXTURE/reloads" 2>/dev/null || echo 0) + 1 )); printf '%s' "$n" > "$FIXTURE/reloads"
    if [ "$FAIL_RELOAD_AT" = "$n" ]; then exit 1; fi
    wr pending "$(nth "$READY_AFTER" "$n" 1)"
    wr behaviour "$(nth "$OLD_WORKERS" "$n" shutting)"
    if [ "$MASTER_CHANGES_AT" = "$n" ]; then wr master 5555; fi
    if [ -n "$MASTER_BLIP" ]; then wr blip "$MASTER_BLIP"; fi
    exit 0 ;;
esac
exit 0
`,
  pgrep: `pending=$(rd pending '')
if [ -n "$pending" ]; then
  left=$((pending - 1))
  if [ "$left" -gt 0 ]; then wr pending "$left"; else
    rm -f "$H/pending"
    gen=$(( $(rd gen 0) + 1 )); wr gen "$gen"
    old=$(rd children '')
    new="$((2000 + gen * 10 + 1)) $((2000 + gen * 10 + 2))"
    case "$(rd behaviour shutting)" in
      gone) wr children "$new"; wr shutting '' ;;
      shutting) wr children "$new $old"; wr shutting "$old" ;;
      *) wr children "$new $old"; wr shutting '' ;;
    esac
  fi
fi
if [ "$1" != -P ]; then exit 2; fi
kids=''
if [ "$2" = "$(rd master '')" ]; then kids=$(rd children ''); fi
if [ -z "$kids" ]; then exit 1; fi
for k in $kids; do echo "$k"; done
`,
  ps: `pid="$4"
case " $(rd children '') " in *" $pid "*) ;; *) exit 1 ;; esac
case " $(rd shutting '') " in *" $pid "*) echo 'nginx: worker process is shutting down' ;; *) echo 'nginx: worker process' ;; esac
`,
  ss: `echo 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
for p in $(rd ports '80 443'); do
  if [ "$p" = 443 ] && [ -n "$NO_443" ]; then continue; fi
  echo "LISTEN 0 511 0.0.0.0:$p 0.0.0.0:*"
done
`,
  sleep: `printf x >> "$H/sleeps"
`,
};
// Path-maps /etc/nginx into the fixture, drops `install -o/-g`, can interrupt the
// installer once before its first nginx child, and can tamper with a file right
// after `install` wrote it (CORRUPT_INSTALL = path suffix).
const FAKE_SUDO = `#!/bin/sh
cmd="$1"
n=$#
i=0
while [ "$i" -lt "$n" ]; do
  a="$1"; shift; i=$((i + 1))
  if [ "$cmd" = install ] && { [ "$a" = -o ] || [ "$a" = -g ]; }; then shift; i=$((i + 1)); continue; fi
  case "$a" in /etc/nginx*) a="$FIXTURE$a" ;; esac
  set -- "$@" "$a"
done
if [ "$1" = nginx ] && [ "$INTERRUPT_AT" = 1 ] && [ ! -e "$FIXTURE/interrupted" ]; then
  : > "$FIXTURE/interrupted"
  kill -TERM "$PPID"
  unset INTERRUPT_AT
fi
"$@"
status=$?
if [ "$status" -eq 0 ] && [ "$cmd" = install ] && [ -n "$CORRUPT_INSTALL" ]; then
  for last; do :; done
  case "$last" in *"$CORRUPT_INSTALL") printf '# tampered after install\\n' >> "$last" ;; esac
fi
exit "$status"
`;
const FAKE_NGINX = `#!/bin/sh
case " $* " in *" -v "*) echo 'nginx version: nginx/1.24.0'; exit 0 ;; esac
n=$(( $(cat "$FIXTURE/checks" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$n" > "$FIXTURE/checks"
if [ "$FAIL_AT" = "$n" ]; then exit 1; fi
exit 0
`;

// Freshly created executables cost 0.7-1.6 s each on the first exec (endpoint
// scanning on the dev host), so the stubs and a pristine release copy are built
// ONCE for the file and every fixture reaches them through PATH / a symlink.
// A case that has to tamper with the release gets a private tree whose scripts
// are symlinks to the already-scanned originals (templates are plain data).
let kit: { root: string; bin: string; release: string };
beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cutover-kit-'));
  const bin = `${root}/bin`;
  const release = `${root}/release`;
  mkdirSync(bin, { recursive: true });
  mkdirSync(`${release}/scripts/preproduction`, { recursive: true });
  mkdirSync(`${release}/src/lib/locale`, { recursive: true });
  for (const name of COPIED_SCRIPTS) copyFileSync(path.join(repoRoot, 'scripts/preproduction', name), `${release}/scripts/preproduction/${name}`);
  cpSync(path.join(repoRoot, 'infra/preproduction/nginx'), `${release}/infra/preproduction/nginx`, { recursive: true });
  copyFileSync(path.join(repoRoot, 'src/lib/locale/locale-canonical.ts'), `${release}/src/lib/locale/locale-canonical.ts`);
  writeFileSync(`${bin}/sudo`, FAKE_SUDO, { mode: 0o755 });
  writeFileSync(`${bin}/nginx`, FAKE_NGINX, { mode: 0o755 });
  writeFileSync(`${bin}/_lib.sh`, FAKE_LIB);
  for (const [name, body] of Object.entries(FAKE_COMMANDS)) writeFileSync(`${bin}/${name}`, `#!/bin/sh\n. "$(dirname "$0")/_lib.sh"\n${body}`, { mode: 0o755 });
  kit = { root, bin, release };
  // Warm the scanner for the pristine scripts once, outside any test timer.
  spawnSync('/bin/bash', ['-n', `${release}/scripts/preproduction/install-nginx.sh`]);
});
afterAll(() => { if (kit) rmSync(kit.root, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cutover-install-'));
  for (const p of ['host', 'etc/nginx/conf.d', 'etc/nginx/snippets', 'etc/nginx/sites-enabled', 'etc/nginx/sites-available', 'shared', 'releases']) mkdirSync(path.join(dir, p), { recursive: true });
  // Reached through a `current` symlink exactly like /opt/cps-novel/current.
  symlinkSync(kit.release, `${dir}/current`);
  writeFileSync(`${dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'old-site\n');
  writeFileSync(`${dir}/etc/nginx/sites-available/default`, 'listen 80 default_server;\n');
  symlinkSync('../sites-available/default', `${dir}/etc/nginx/sites-enabled/default`);
  writeFileSync(`${dir}/host/master`, '4242');
  writeFileSync(`${dir}/host/children`, '1001 1002');

  let privateRelease = '';
  const tamperRoot = () => {
    if (!privateRelease) {
      privateRelease = `${dir}/releases/private`;
      mkdirSync(`${privateRelease}/scripts/preproduction`, { recursive: true });
      // Shell scripts are symlinks (their root comes from the path they are run by);
      // Node resolves a main module to its real path, so the .mjs files are copies.
      for (const name of COPIED_SCRIPTS) {
        const from = `${kit.release}/scripts/preproduction/${name}`;
        if (name.endsWith('.mjs')) copyFileSync(from, `${privateRelease}/scripts/preproduction/${name}`);
        else symlinkSync(from, `${privateRelease}/scripts/preproduction/${name}`);
      }
      for (const sub of ['infra', 'src']) cpSync(`${kit.release}/${sub}`, `${privateRelease}/${sub}`, { recursive: true });
      unlinkSync(`${dir}/current`);
      symlinkSync(privateRelease, `${dir}/current`);
    }
    return privateRelease;
  };
  /** Edit a data file (template) of this fixture's private release; the edit must change something. */
  const edit = (rel: string, change: (text: string) => string) => {
    const file = `${tamperRoot()}/${rel}`;
    const before = readFileSync(file, 'utf8');
    const after = change(before);
    if (after === before) throw new Error(`tamper anchor missing in ${rel}`);
    writeFileSync(file, after);
  };
  /** Replace a script of this fixture's private release (a symlink is removed first: never write through to the shared original). */
  const replaceScript = (name: string, body: string) => {
    const file = `${tamperRoot()}/scripts/preproduction/${name}`;
    unlinkSync(file);
    writeFileSync(file, body, { mode: 0o755 });
  };

  const run = (args: string[], extra: Record<string, string | undefined> = {}, via: 'link-abs' | 'link-rel' = 'link-abs') => spawnSync('/bin/bash',
    [via === 'link-abs' ? `${dir}/current/scripts/preproduction/install-nginx.sh` : 'scripts/preproduction/install-nginx.sh', ...args],
    // link-rel reproduces `cd /opt/cps-novel/current && scripts/preproduction/install-nginx.sh`: a logical PWD through the symlink.
    { encoding: 'utf8', cwd: via === 'link-rel' ? `${dir}/current` : dir, env: { NODE_ENV: 'test', PATH: `${kit.bin}:${process.env.PATH}`, HOME: process.env.HOME, FIXTURE: dir, ...(via === 'link-rel' ? { PWD: `${dir}/current` } : {}), PREPROD_OWNER_SUDO_APPROVED: 'YES', PREPROD_SHARED_ROOT: `${dir}/shared`, ...extra } });
  const read = (name: string) => readFileSync(`${dir}/host/${name}`, 'utf8');
  return { dir, edit, replaceScript, run, read, sleeps: () => (existsSync(`${dir}/host/sleeps`) ? read('sleeps').length : 0), clean: () => rmSync(dir, { recursive: true, force: true }) };
}
type Fixture = ReturnType<typeof fixture>;

/** Whole fake /etc/nginx as one comparable string (paths, bytes, link targets). */
function etcTree(f: Fixture) {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(`${f.dir}/${rel}`).sort()) {
      const p = `${rel}/${entry}`;
      const stat = lstatSync(`${f.dir}/${p}`);
      if (stat.isSymbolicLink()) out.push(`L ${p} -> ${readlinkSync(`${f.dir}/${p}`)}`);
      else if (stat.isDirectory()) { out.push(`D ${p}`); walk(p); }
      else out.push(`F ${p}\n${readFileSync(`${f.dir}/${p}`, 'utf8')}`);
    }
  };
  walk('etc');
  return out.join('\n');
}
function expectNothingTouched(f: Fixture, before: string) {
  expect(etcTree(f)).toBe(before);
  expect(existsSync(`${f.dir}/shared/nginx-backups`)).toBe(false);
  expect(existsSync(`${f.dir}/checks`)).toBe(false);
  expect(existsSync(`${f.dir}/reloads`)).toBe(false);
}
function expectRestored(f: Fixture) {
  expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).toBe('old-site\n');
  expect(readlinkSync(`${f.dir}/etc/nginx/sites-enabled/default`)).toBe('../sites-available/default');
  expect(existsSync(`${f.dir}/etc/nginx/snippets/cps-novel-edge-public-security.conf`)).toBe(false);
  expect(readdirSync(`${f.dir}/shared/nginx-backups`).length).toBe(1);
}
const SITE = 'infra/preproduction/nginx/cps-novel-public.conf.template';

describe('renderer entry detection through symlinked release directories', () => {
  // 2026-10-05: `cd /opt/cps-novel/current` made render-nginx.sh hand Node a
  // symlink path while the module resolved to the real release, so the CLI guard
  // was false and the render exited 0 with an empty body.
  it.each(['rehearsal', 'public'])('%s: physical, symlink-absolute and relative invocations are byte-identical and non-empty', mode => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutover-render-link-'));
    try {
      symlinkSync(repoRoot, `${dir}/current`);
      const args = ['scripts/preproduction/render-public-nginx.mjs', mode, '127.0.0.1:3000', '86400'];
      const node = (script: string, options: { cwd?: string; env?: Record<string, string> } = {}) => execFileSync('node', [script, ...args.slice(1)], { cwd: options.cwd, env: { ...process.env, ...options.env } });
      const physical = node(`${repoRoot}/${args[0]}`);
      expect(physical.length).toBeGreaterThan(10_000);
      expect(node(`${dir}/current/${args[0]}`).equals(physical)).toBe(true);
      expect(node(args[0], { cwd: repoRoot }).equals(physical)).toBe(true);
      expect(node(args[0], { cwd: `${dir}/current`, env: { PWD: `${dir}/current` } }).equals(physical)).toBe(true);
      expect(Buffer.from(renderPublicNginx(mode, '127.0.0.1:3000', '86400')).equals(physical)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['rehearsal', 'public'])('render-nginx.sh --mode %s resolves a physical root from a logical cwd and from a symlink path', mode => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutover-render-sh-'));
    try {
      symlinkSync(repoRoot, `${dir}/current`);
      const render = (script: string, output: string, cwd: string, env: Record<string, string> = {}) => {
        const r = spawnSync('/bin/bash', [script, '--mode', mode, '--output', output], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
        expect(r.status, r.stderr + r.stdout).toBe(0);
        return readFileSync(output);
      };
      const physical = render(`${repoRoot}/scripts/preproduction/render-nginx.sh`, `${dir}/physical.conf`, repoRoot);
      expect(physical.length).toBeGreaterThan(10_000);
      expect(render(`${dir}/current/scripts/preproduction/render-nginx.sh`, `${dir}/abs.conf`, dir).equals(physical)).toBe(true);
      expect(render('scripts/preproduction/render-nginx.sh', `${dir}/rel.conf`, `${dir}/current`, { PWD: `${dir}/current` }).equals(physical)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('render-nginx.sh refuses an empty body and leaves the existing output untouched', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutover-render-empty-'));
    try {
      mkdirSync(`${dir}/scripts/preproduction`, { recursive: true });
      copyFileSync(path.join(repoRoot, 'scripts/preproduction/render-nginx.sh'), `${dir}/scripts/preproduction/render-nginx.sh`);
      writeFileSync(`${dir}/scripts/preproduction/render-public-nginx.mjs`, "process.stdout.write('');\n");
      writeFileSync(`${dir}/site.conf`, 'original');
      const r = spawnSync('/bin/bash', [`${dir}/scripts/preproduction/render-nginx.sh`, '--mode', 'public', '--output', `${dir}/site.conf`], { encoding: 'utf8' });
      expect(r.status).toBe(65);
      expect(r.stderr).toContain('NGINX_RENDER=FAIL reason=empty_output');
      expect(r.stdout).not.toContain('NGINX_RENDER=PASS');
      expect(readFileSync(`${dir}/site.conf`, 'utf8')).toBe('original');
      expect(readdirSync(dir).filter(name => name.includes('.tmp.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('candidate shape check', () => {
  const render = (mode: string, hsts = '86400') => renderPublicNginx(mode, '127.0.0.1:3000', hsts);
  it.each(['rehearsal', 'public'])('accepts the real %s render', mode => {
    expect(checkNginxCandidate(render(mode), mode)).toEqual([]);
  });
  it('binds the HSTS value to the requested max-age (the 31536000 promotion)', () => {
    expect(checkNginxCandidate(render('public', '31536000'), 'public', { hstsMaxAge: '31536000' })).toEqual([]);
    expect(checkNginxCandidate(render('public', '86400'), 'public', { hstsMaxAge: '31536000' })).toEqual(['hsts_value']);
  });
  it('does not accept a candidate rendered for the other mode', () => {
    expect(checkNginxCandidate(render('rehearsal'), 'public').length).toBeGreaterThan(5);
    expect(checkNginxCandidate(render('public'), 'rehearsal').length).toBeGreaterThan(5);
  });
  it.each([
    ['empty text', '', 'public', ['candidate_empty']],
    ['whitespace only', ' \n\t\n', 'rehearsal', ['candidate_empty']],
  ] as const)('reports %s', (_name, text, mode, codes) => {
    expect(checkNginxCandidate(text, mode)).toEqual(codes);
  });
  it.each([
    ['public', 'the :80 reject server', (t: string) => t.replace('return 444;', 'return 404;'), 'reject_http_default'],
    ['public', 'the unknown-Host TLS reject', (t: string) => t.replace('listen 443 ssl http2 default_server;', 'listen 443 ssl http2;'), 'reject_https_default'],
    ['public', 'the www.pulsenovels.com 301', (t: string) => t.replaceAll('www.pulsenovels.com', 'www.example.test'), 'www_redirect'],
    ['public', 'the legacy public host 301', (t: string) => t.replaceAll('server_name www.bangbangji.cloud;', 'server_name www.example.test;'), 'legacy_public_redirect'],
    ['public', 'the legacy admin host 301', (t: string) => t.replaceAll('server_name zbcwf.bangbangji.cloud;', 'server_name zbcwf.example.test;'), 'legacy_admin_redirect'],
    ['public', 'the administration auth_basic line itself', (t: string) => t.replaceAll('auth_basic "CPS Novel Administration";', ''), 'admin_https_app'],
    ['public', 'the administration auth_basic', (t: string) => t.replaceAll('auth_basic "CPS Novel Administration";', 'auth_basic off;'), 'admin_https_app'],
    ['rehearsal', 'the administration auth_basic', (t: string) => t.replaceAll('auth_basic "CPS Novel Administration";', 'auth_basic off;'), 'admin_https_app'],
    ['rehearsal', 'the rehearsal realm', (t: string) => t.replaceAll('auth_basic "CPS Novel Rehearsal";', 'auth_basic off;'), 'public_rehearsal_auth'],
    ['public', 'public openness', (t: string) => t.replaceAll('auth_basic off;', 'auth_basic "CPS Novel Rehearsal";'), 'public_open'],
    ['public', 'the public robots value', (t: string) => t.replace('map $host $cps_public_robots { default ""; }', 'map $host $cps_public_robots { default "noindex"; }'), 'robots_value'],
    ['rehearsal', 'the rehearsal noindex', (t: string) => t.replace('default "noindex, nofollow, noarchive"', 'default ""'), 'robots_value'],
    ['rehearsal', 'HSTS staying off', (t: string) => t.replace('map $host $cps_public_hsts { default ""; }', 'map $host $cps_public_hsts { default "max-age=86400"; }'), 'hsts_value'],
    ['public', 'a resolved token', (t: string) => `${t}\n# __LEFTOVER__\n`, 'tokens_resolved'],
  ] as const)('%s: flags a missing %s', (mode, _what, tamper, code) => {
    expect(checkNginxCandidate(tamper(render(mode)), mode)).toContain(code);
  });
  it('also knows the preprod and bootstrap-public shapes (installer --mode preprod / --bootstrap-public)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutover-shapes-'));
    try {
      const rendered = (args: string[]) => { const out = `${dir}/${args.join('_')}.conf`; execFileSync('/bin/bash', [path.join(repoRoot, 'scripts/preproduction/render-nginx.sh'), ...args, '--output', out]); return readFileSync(out, 'utf8'); };
      const preprod = rendered(['--mode', 'preprod']);
      expect(checkNginxCandidate(preprod, 'preprod')).toEqual([]);
      expect(checkNginxCandidate(preprod.replaceAll('server_name zbcwf.bangbangji.cloud;', 'server_name zbcwf.example.test;'), 'preprod')).toEqual(['admin_http_redirect', 'admin_https_app']);
      expect(checkNginxCandidate(preprod, 'rehearsal').length).toBeGreaterThan(5);
      const bootstrap = rendered(['--bootstrap-public']);
      expect(checkNginxCandidate(bootstrap, 'bootstrap-public')).toEqual([]);
      expect(checkNginxCandidate(bootstrap.replace('listen 80;', 'listen 443 ssl;'), 'bootstrap-public')).toEqual(['bootstrap_server', 'bootstrap_http_only']);
      expect(checkNginxCandidate(preprod, 'bootstrap-public').length).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('verifier CLI runs through a symlinked path and prints only codes and a digest', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cutover-verify-cli-'));
    try {
      symlinkSync(repoRoot, `${dir}/current`);
      writeFileSync(`${dir}/ok.conf`, render('public'));
      writeFileSync(`${dir}/bad.conf`, render('public').replaceAll('auth_basic "CPS Novel Administration";', 'auth_basic off;'));
      writeFileSync(`${dir}/empty.conf`, '');
      const cli = (file: string, mode = 'public') => spawnSync('node', [`${dir}/current/scripts/preproduction/verify-nginx-candidate.mjs`, '--mode', mode, '--hsts-max-age', '86400', file], { encoding: 'utf8' });
      const ok = cli(`${dir}/ok.conf`);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/^NGINX_CANDIDATE=PASS mode=public bytes=\d+ sha256=[0-9a-f]{64}\n$/);
      const bad = cli(`${dir}/bad.conf`);
      expect(bad.status).toBe(65);
      expect(bad.stdout).toBe('NGINX_CANDIDATE=FAIL mode=public missing=admin_https_app,admin_auth_not_disabled\n');
      const empty = cli(`${dir}/empty.conf`);
      expect(empty.status).toBe(65);
      expect(empty.stdout).toContain('missing=candidate_empty');
      expect(cli(`${dir}/nonexistent.conf`).stdout).toContain('candidate_unreadable');
      expect(cli(`${dir}/ok.conf`, 'unknown').status).toBe(64);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('public nginx transaction', () => {
  it('bootstrap is additive, public replaces it, and exact restore retains the default-site symlink', () => {
    const f = fixture(); try {
      expect(f.run(['--bootstrap-public']).status).toBe(0); expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).toBe('old-site\n');
      const r = f.run(['--mode', 'public']); expect(r.status, r.stderr + r.stdout).toBe(0); expect(existsSync(`${f.dir}/etc/nginx/conf.d/cps-novel-public-bootstrap.conf`)).toBe(false);
      const backup = r.stdout.match(/^NGINX_BACKUP=(.+)$/m)![1]; expect(existsSync(`${backup}/READY`)).toBe(true);
      const restore = f.run(['--restore-backup', backup]); expect(restore.status, restore.stderr).toBe(0);
      expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).toBe('old-site\n'); expect(existsSync(`${f.dir}/etc/nginx/conf.d/cps-novel-public-bootstrap.conf`)).toBe(true);
      expect(readlinkSync(`${f.dir}/etc/nginx/sites-enabled/default`)).toBe('../sites-available/default'); expect(existsSync(backup)).toBe(true);
    } finally { f.clean(); }
  }, SLOW);
  for (const failure of [{ FAIL_AT: '1' }, { FAIL_RELOAD_AT: '1' }, { INTERRUPT_AT: '1' }]) it(`restores all files after ${Object.keys(failure)[0]}`, () => {
    const f = fixture(); try { const r = f.run(['--mode', 'public'], failure); expect(r.status, r.stdout + r.stderr).not.toBe(0); expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).toBe('old-site\n'); expect(readlinkSync(`${f.dir}/etc/nginx/sites-enabled/default`)).toBe('../sites-available/default'); expect(existsSync(`${f.dir}/etc/nginx/snippets/cps-novel-edge-public-security.conf`)).toBe(false); expect(readdirSync(`${f.dir}/shared/nginx-backups`).length).toBe(1); expect(r.stderr).toContain('candidate_failed_restored'); } finally { f.clean(); }
  }, SLOW);
  it('refuses incomplete backup before touching live files', () => {
    const f = fixture(); try { const backup = `${f.dir}/shared/nginx-backups/install.invalid`; mkdirSync(backup, { recursive: true }); writeFileSync(`${backup}/READY`, ''); const r = f.run(['--restore-backup', backup]); expect(r.status).toBe(65); expect(r.stdout).toContain('backup_invalid'); expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).toBe('old-site\n'); expect(existsSync(`${f.dir}/reloads`)).toBe(false); } finally { f.clean(); }
  }, SLOW);

  // link-abs: absolute path through the `current` symlink; link-rel: relative path from a logical cwd inside it.
  describe.each(['link-abs', 'link-rel'] as const)('installs the real candidate (%s)', via => {
    it.each([['public', ['--mode', 'public', '--hsts-max-age', '31536000'], '31536000'], ['rehearsal', ['--mode', 'rehearsal'], '86400']] as const)('%s mode writes the complete, verified candidate', (mode, args, hsts) => {
      const f = fixture(); try {
        const r = f.run([...args], {}, via);
        expect(r.status, r.stderr + r.stdout).toBe(0);
        const installed = readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8');
        expect(installed.length).toBeGreaterThan(10_000);
        expect(installed).toBe(renderPublicNginx(mode, '127.0.0.1:3000', hsts));
        expect(r.stdout).toMatch(/^NGINX_CANDIDATE=PASS mode=.+ bytes=\d+ sha256=[0-9a-f]{64}$/m);
        expect(r.stdout).toMatch(/^NGINX_READY=PASS phase=install round=1 master=4242 listeners=80 443$/m);
        expect(r.stdout).toMatch(/^NGINX_INSTALL=PASS mode=/m);
        expect(f.sleeps()).toBe(0);
        // Nothing sensitive: no Basic Auth secret, only config shape and digests.
        expect(r.stdout + r.stderr).not.toMatch(/matrix-secret|password|BEGIN [A-Z ]*PRIVATE KEY/i);
      } finally { f.clean(); }
    }, SLOW);
  });
});

describe('other entry points keep working through the symlinked release', () => {
  it('--mode preprod installs the preprod template with the same gates and readiness wait', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'preprod']);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('NGINX_CANDIDATE=PASS mode=preprod');
      expect(r.stdout).toContain('NGINX_READY=PASS phase=install round=1 master=4242 listeners=80 443');
      expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).toContain('upstream cps_novel_preprod_web');
    } finally { f.clean(); }
  }, SLOW);
  it.each([[[]], [['--bootstrap']]] as const)('legacy install-nginx.sh %j still installs and reloads', args => {
    const f = fixture(); try {
      const r = f.run([...args]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('NGINX_INSTALL=PASS');
      expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`, 'utf8')).not.toBe('old-site\n');
      expect(readFileSync(`${f.dir}/reloads`, 'utf8')).toBe('1');
    } finally { f.clean(); }
  }, SLOW);
});

describe('candidate gate: nothing under /etc/nginx is touched when the candidate is wrong', () => {
  // 65 = REFUSED. The fake /etc/nginx tree, the backup area and the nginx -t /
  // reload counters must all be exactly as they were.
  it('refuses an empty candidate (installer-side check, independent of the renderer)', () => {
    const f = fixture(); try {
      // A renderer regression of any kind that reports success but writes nothing.
      f.replaceScript('render-nginx.sh', '#!/usr/bin/env bash\nwhile (($#)); do [[ "$1" == --output ]] && : >"$2"; shift; done\necho NGINX_RENDER=PASS\n');
      const before = etcTree(f);
      const r = f.run(['--mode', 'public']);
      expect(r.status, r.stdout + r.stderr).toBe(65);
      expect(r.stdout).toContain('NGINX_INSTALL=REFUSED reason=candidate_empty');
      expectNothingTouched(f, before);
    } finally { f.clean(); }
  }, SLOW);
  it('refuses when the renderer itself produces nothing (the 2026-10-05 symptom, end to end)', () => {
    const f = fixture(); try {
      f.replaceScript('render-public-nginx.mjs', "process.stdout.write('');\n");
      const before = etcTree(f);
      const r = f.run(['--mode', 'public']);
      expect(r.status, r.stdout + r.stderr).toBe(65);
      expect(r.stderr).toContain('NGINX_RENDER=FAIL reason=empty_output');
      expectNothingTouched(f, before);
    } finally { f.clean(); }
  }, SLOW);
  it.each([
    { mode: 'public', args: ['--mode', 'public'], what: 'a missing server (no legacy-domain redirects)', tamper: (t: string) => t.replace('__REDIRECT_SERVERS__', ''), codes: 'www_redirect,legacy_public_redirect,legacy_admin_redirect' },
    { mode: 'public', args: ['--mode', 'public'], what: 'a missing :80 reject server', tamper: (t: string) => t.replace('server { listen 80 default_server; server_name _; return 444; }', ''), codes: 'reject_http_default' },
    { mode: 'public', args: ['--mode', 'public'], what: 'a missing unknown-Host TLS reject server', tamper: (t: string) => t.replace('listen 443 ssl http2 default_server;', 'listen 443 ssl http2;'), codes: 'reject_https_default' },
    { mode: 'public', args: ['--mode', 'public'], what: 'the administration auth_basic line', tamper: (t: string) => t.replaceAll('auth_basic "CPS Novel Administration";', ''), codes: 'admin_https_app' },
    { mode: 'rehearsal', args: ['--mode', 'rehearsal'], what: 'the administration auth_basic (rehearsal shape, replaced by auth_basic off)', tamper: (t: string) => t.replaceAll('auth_basic "CPS Novel Administration";', 'auth_basic off;'), codes: 'admin_https_app,admin_auth_not_disabled' },
    { mode: 'public', args: ['--mode', 'public', '--hsts-max-age', '31536000'], what: 'the requested HSTS max-age', tamper: (t: string) => t.replace('map $host $cps_public_hsts { default "__PUBLIC_HSTS__"; }', 'map $host $cps_public_hsts { default ""; }'), codes: 'hsts_value' },
  ])('$mode: refuses $what with exit 65', ({ mode, args, tamper, codes }) => {
    const f = fixture(); try {
      f.edit(SITE, tamper);
      const before = etcTree(f);
      const r = f.run(args);
      expect(r.status, r.stdout + r.stderr).toBe(65);
      expect(r.stdout).toContain(`NGINX_CANDIDATE=FAIL mode=${mode} missing=${codes}\n`);
      expect(r.stdout).toContain('NGINX_INSTALL=REFUSED reason=candidate_incomplete');
      expectNothingTouched(f, before);
    } finally { f.clean(); }
  }, SLOW);
  it('refuses a bootstrap candidate that is not the HTTP-only bootstrap', () => {
    const f = fixture(); try {
      f.edit('infra/preproduction/nginx/cps-novel-public-bootstrap.conf.template', () => 'server { listen 443 ssl; server_name pulsenovels.com; }\n');
      const before = etcTree(f);
      const r = f.run(['--bootstrap-public']);
      expect(r.status, r.stdout + r.stderr).toBe(65);
      expect(r.stdout).toContain('reason=candidate_incomplete');
      expectNothingTouched(f, before);
    } finally { f.clean(); }
  }, SLOW);
  it('legacy install-nginx.sh (no --mode) also refuses an empty candidate before touching anything', () => {
    const f = fixture(); try {
      f.replaceScript('render-nginx.sh', '#!/usr/bin/env bash\nwhile (($#)); do [[ "$1" == --output ]] && : >"$2"; shift; done\n');
      const before = etcTree(f);
      const r = f.run([]);
      expect(r.status, r.stdout + r.stderr).toBe(65);
      expect(r.stdout).toContain('NGINX_INSTALL=REFUSED reason=candidate_empty');
      expectNothingTouched(f, before);
    } finally { f.clean(); }
  }, SLOW);
});

describe('post-install hash check', () => {
  it.each([
    ['the site file', 'cps-novel-preprod.conf', '/etc/nginx/conf.d/cps-novel-preprod.conf'],
    ['an installed snippet', 'cps-novel-edge-admin-security.conf', '/etc/nginx/snippets/cps-novel-edge-admin-security.conf'],
  ])('rolls back and exits non-zero when %s differs from the candidate', (_what, suffix, file) => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], { CORRUPT_INSTALL: suffix });
      expect(r.status, r.stdout + r.stderr).toBe(72);
      expect(r.stdout).toMatch(new RegExp(`^NGINX_INSTALL=FAIL reason=installed_hash_mismatch file=${file} installed_sha256=[0-9a-f]{64} expected_sha256=[0-9a-f]{64}$`, 'm'));
      expect(r.stderr).toContain('candidate_failed_restored');
      expectRestored(f);
      // The mismatching file was never loaded: the only reload is the rollback's.
      expect(readFileSync(`${f.dir}/reloads`, 'utf8')).toBe('1');
      expect(r.stdout).toContain('NGINX_READY=PASS phase=rollback');
    } finally { f.clean(); }
  }, SLOW);
});

describe('reload readiness wait', () => {
  it('waits until the new workers appear (ready on the 4th poll: three sleeps)', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], { READY_AFTER: '4' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('NGINX_READY=PASS phase=install round=4 master=4242 listeners=80 443');
      expect(f.sleeps()).toBe(3);
    } finally { f.clean(); }
  }, SLOW);
  it('accepts old workers that have already exited as well as ones announcing shutdown', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'rehearsal'], { OLD_WORKERS: 'gone' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('NGINX_READY=PASS phase=install round=1');
    } finally { f.clean(); }
  }, SLOW);
  it.each([
    ['no new worker ever appears', { READY_AFTER: '99' }],
    ['an old worker keeps serving without being told to quit', { OLD_WORKERS: 'linger' }],
  ])('times out after 10 rounds when %s, rolls back, exits 73', (_what, env) => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], env);
      expect(r.status, r.stdout + r.stderr).toBe(73);
      expect(r.stdout).toContain('NGINX_INSTALL=FAIL reason=ready_handoff_timeout phase=install rounds=10 handoff=pending master=4242');
      expect(r.stderr).toContain('candidate_failed_restored');
      expectRestored(f);
      expect(readFileSync(`${f.dir}/reloads`, 'utf8')).toBe('2');
      expect(r.stdout).toContain('NGINX_READY=PASS phase=rollback');
      expect(r.stdout).not.toContain('NGINX_INSTALL=PASS');
    } finally { f.clean(); }
  }, SLOW);
  it('fails with its own reason when the workers handed off but :443 is not listening', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], { NO_443: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(73);
      expect(r.stdout).toContain('reason=ready_listener_missing phase=install rounds=10 handoff=ok master=4242 missing_listeners=443');
      expectRestored(f);
    } finally { f.clean(); }
  }, SLOW);
  it('does not read a transiently unreadable master (systemctl show hiccup) as a restart', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], { MASTER_BLIP: '2', READY_AFTER: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('NGINX_READY=PASS phase=install round=3 master=4242');
      expect(f.sleeps()).toBe(2);
    } finally { f.clean(); }
  }, SLOW);
  it('fails immediately when the master process changed during the reload', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], { MASTER_CHANGES_AT: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(73);
      expect(r.stdout).toContain('reason=ready_master_changed phase=install before=4242 after=5555 round=1');
      expect(f.sleeps()).toBe(0);
      expectRestored(f);
    } finally { f.clean(); }
  }, SLOW);
  it('reports an unconfirmed rollback distinctly (71) when the restore reload never hands off either', () => {
    const f = fixture(); try {
      const r = f.run(['--mode', 'public'], { READY_AFTER: '99,99' });
      expect(r.status, r.stdout + r.stderr).toBe(71);
      expect(r.stdout).toContain('reason=ready_handoff_timeout phase=install');
      expect(r.stdout).toContain('reason=ready_handoff_timeout phase=rollback');
      expect(r.stderr).toContain('rollback_failed');
    } finally { f.clean(); }
  }, SLOW);
  it('the additive HTTP bootstrap only needs :80, and a restore asserts the handoff but no port', () => {
    const f = fixture(); try {
      const boot = f.run(['--bootstrap-public'], { NO_443: '1' });
      expect(boot.status, boot.stdout + boot.stderr).toBe(0);
      expect(boot.stdout).toContain('NGINX_READY=PASS phase=install round=1 master=4242 listeners=80\n');
      const backup = boot.stdout.match(/^NGINX_BACKUP=(.+)$/m)![1];
      const restore = f.run(['--restore-backup', backup], { NO_443: '1' });
      expect(restore.status, restore.stdout + restore.stderr).toBe(0);
      expect(restore.stdout).toContain('NGINX_READY=PASS phase=install round=1 master=4242 listeners=none');
    } finally { f.clean(); }
  }, SLOW);
  it('refuses before writing anything when a tool the wait depends on is missing', () => {
    const f = fixture(); try {
      // A PATH holding the stubs but neither the stub nor a real ss (macOS has none, Linux CI has one).
      const shadow = `${f.dir}/shadow`;
      mkdirSync(shadow);
      for (const name of readdirSync(kit.bin)) if (name !== 'ss') symlinkSync(`${kit.bin}/${name}`, `${shadow}/${name}`);
      for (const tool of ['bash', 'env', 'dirname', 'cat', 'sh', 'node']) {
        const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        if (found) symlinkSync(found, `${shadow}/${tool}`);
      }
      const before = etcTree(f);
      const r = f.run(['--mode', 'public'], { PATH: shadow });
      expect(r.status, r.stdout + r.stderr).toBe(69);
      expect(r.stdout).toContain('NGINX_INSTALL=REFUSED reason=ready_tool_missing tool=ss');
      expectNothingTouched(f, before);
    } finally { f.clean(); }
  }, SLOW);
});
