import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SITE_LOCALES } from '../../../src/lib/locale/locale-canonical';
import { SITE_MODE_CASES } from './site-mode-fixture';
import { parseTaskTypes } from '../../../src/lib/tasks/worker-lanes.mjs';

const root = process.cwd();
const text = (p: string) => readFileSync(path.join(root, p), 'utf8');
function render(mode: string) {
  return execFileSync('node', ['scripts/preproduction/render-public-nginx.mjs', mode, '127.0.0.1:3000', '86400'], { encoding: 'utf8' });
}
function preflight(overrides: Record<string, string | undefined>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cutover-preflight-'));
  const values = Object.fromEntries(text('infra/preproduction/preprod.env.example').split('\n').filter(l => /^[A-Z_0-9]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0,i), l.slice(i+1)]; }));
  Object.assign(values, { FEATURE_NOVEL_CATALOG_SYNC: 'false', NOVEL_CATALOG_SYNC_ALLOW_WRITE: 'false', FEATURE_PROMO_LINK_CLAIM: 'false', PROMO_LINK_CLAIM_ALLOW_WRITE: 'false', FEATURE_SITEMAP_AUTO_REFRESH: 'false', SITEMAP_AUTO_REFRESH_ALLOW_WRITE: 'false', PREPROD_APPROVED_OPEN_WRITE_GATES: '' }, overrides);
  const envFile = path.join(dir, 'env');
  writeFileSync(envFile, Object.entries(values).filter(([,v]) => v !== undefined).map(([k,v]) => `${k}='${String(v).replaceAll("'", "'\\''")}'`).join('\n'));
  try { return spawnSync('/bin/bash', ['scripts/preproduction/preflight.sh'], { encoding:'utf8', env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, PREPROD_ENV_FILE: envFile } }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function outcome(env: Record<string,string|undefined>, reason = 'git_commit') {
  const r = preflight(env);
  expect(r.status, r.stderr + r.stdout).toBe(65);
  expect(r.stdout).toContain(`PREPROD_PREFLIGHT=FAIL reason=${reason}\n`);
}

describe.each(['rehearsal','public'])('%s rendered route contract', mode => {
  it('derives every registered locale and puts each page class in the same rendering zones', () => {
    const config = render(mode);
    const blocks = [...config.matchAll(/location ~ (\^\/\(\?:[^\n]+) \{\n([\s\S]*?)\n    \}/g)];
    const page = blocks.find(([, , body]) => body.includes('limit_conn cps_edge_page_conn'));
    expect(page).toBeDefined();
    const regex = new RegExp(page![1]);
    for (const locale of SITE_LOCALES) for (const suffix of ['', '/', '/novel/book', '/novel/book/chapter/1', '/browse', '/category/fiction', '/blog/post']) {
      expect(regex.test(`/${locale}${suffix}`), `${locale}${suffix}`).toBe(true);
    }
    expect(page![2]).toContain('limit_req zone=cps_edge_page_rate burst=30 nodelay;');
    const fallback = config.slice(config.indexOf('    location / {\n        '), config.indexOf('server_name '+(mode === 'public' ? 'zbcwf.pulsenovels.com' : 'zbcwf.bangbangji.cloud')+';', config.indexOf('access_log')));
    expect(fallback).toContain('limit_conn cps_edge_page_conn 10;');
    const go = blocks.find(([, , body]) => body.includes('limit_conn cps_edge_go_conn'));
    for (const prefix of ['', ...SITE_LOCALES.map(l => `${l}/`)]) expect(new RegExp(go![1]).test(`/${prefix}go/code`)).toBe(true);
    expect(config).toContain('map $http_next_router_prefetch $cps_page_key { "" $server_name; default ""; }');
    expect(config).toContain('limit_conn cps_edge_prefetch_conn 4;');
    expect(config).toContain('limit_req_status 429;');
    expect(config).toContain('limit_conn_status 429;');
  });
  it('uses canonical bot names, not addresses, with negative UA coverage', () => {
    const config=render(mode);
    expect(config).toContain('limit_req_zone $cps_training_bot zone=cps_edge_bot_page');
    expect(config).toContain('limit_req_zone $cps_training_bot zone=cps_edge_bot_go');
    const body = config.match(/map \$http_user_agent \$cps_training_bot \{([\s\S]*?)\}/)![1];
    const rules = [...body.matchAll(/~\*([^\s]+)\s+([^;]+);/g)];
    for (const name of ['ClaudeBot','GPTBot','Bytespider','CCBot']) expect(rules.find(([ ,p])=>new RegExp(p,'i').test(`Mozilla ${name}/1.0`))?.[2]).toBe(name);
    for (const ua of ['Claude-User','ChatGPT-User','Googlebot','Bingbot']) expect(rules.some(([,p])=>new RegExp(p,'i').test(ua))).toBe(false);
  });
});
it('keeps preprod template and its rendered bytes identical to the approved baseline', () => {
  const before = execFileSync('git', ['show','02f9996:infra/preproduction/nginx/cps-novel-preprod.conf.template'], { encoding:'utf8' });
  expect(text('infra/preproduction/nginx/cps-novel-preprod.conf.template')).toBe(before);
  const dir=mkdtempSync(path.join(tmpdir(),'cutover-render-')); const output=path.join(dir,'site.conf');
  try { execFileSync('/bin/bash',['scripts/preproduction/render-nginx.sh','--output',output]); expect(readFileSync(output,'utf8')).toBe(before.replaceAll('__UPSTREAM__','127.0.0.1:3000')); }
  finally { rmSync(dir,{recursive:true,force:true}); }
});
it('rejects colliding topology and invalid render inputs without overwriting output', () => {
  const r=spawnSync('node',['--input-type=module','-e',`import {validateRenderedTopology} from './scripts/preproduction/render-public-nginx.mjs'; validateRenderedTopology('', 'same.example','same.example');`],{encoding:'utf8'});
  expect(r.status).not.toBe(0); expect(r.stderr).toContain('hosts must differ');
  const dir=mkdtempSync(path.join(tmpdir(),'cutover-invalid-')); const output=path.join(dir,'site.conf'); writeFileSync(output,'original');
  try { for (const args of [['--mode','unknown'],['--mode','public','--hsts-max-age','0'],['--bootstrap-public','--mode','public']]) { expect(spawnSync('/bin/bash',['scripts/preproduction/render-nginx.sh','--output',output,...args]).status).not.toBe(0); expect(readFileSync(output,'utf8')).toBe('original'); } }
  finally {rmSync(dir,{recursive:true,force:true});}
});
it('ships the exact Owner PNG and copies public into the standalone image', () => {
  const png=readFileSync('public/brand/og-default.png');
  expect(png.length).toBe(17150); expect(png.readUInt32BE(16)).toBe(1200); expect(png.readUInt32BE(20)).toBe(630); expect(png[25]).toBe(2);
  expect(createHash('sha256').update(png).digest('hex')).toBe('c4a4a7f4d89a6bce6a3bbf6b50c965cfce53982f85c8aed76be17367731627fb');
  expect(text('Dockerfile')).toContain('COPY --from=builder --chown=nextjs:nodejs /app/public ./public');
});
describe.each(SITE_MODE_CASES)('$mode preflight IndexNow contract', site => {
  const domain={SITE_URL:site.SITE_URL,ADMIN_CANONICAL_ORIGIN:site.ADMIN_CANONICAL_ORIGIN};
  it('accepts the matched domain pair and reports mode',()=>{const r=preflight(domain);expect(r.stdout).toContain(`PREPROD_SITE_MODE=${site.mode}`);outcome(domain);});
  it('rejects other, mismatched, and identical domains',()=>{outcome({...domain,SITE_URL:'https://www.pulsenovels.com'},'site_url');outcome({...domain,ADMIN_CANONICAL_ORIGIN:site.SITE_URL},'admin_origin');outcome({...domain,ADMIN_CANONICAL_ORIGIN:SITE_MODE_CASES.find(s=>s.mode!==site.mode)!.ADMIN_CANONICAL_ORIGIN},'admin_origin');});
  for(const name of ['FEATURE_INDEXNOW_OUTBOX','INDEXNOW_OUTBOX_ALLOW_WRITE','FEATURE_INDEXNOW_DELIVERY','INDEXNOW_DELIVERY_ALLOW_WRITE']) {
    const gate=name.includes('OUTBOX')?'indexnow_outbox':'indexnow_delivery';
    it(`rejects unregistered ${name}`,()=>outcome({...domain,[name]:'true'},gate));
    for(const bad of ['TRUE','1','',undefined]) it(`rejects invalid ${name}=${bad}`,()=>outcome({...domain,[name]:bad},`${gate}_invalid`));
  }
  it('rejects delivery consumer without registration',()=>outcome({...domain,WORKER_LIGHT_TASK_ALLOWLIST:'sitemap_refresh,indexnow_delivery'},'indexnow_delivery_allowlist_mismatch'));
  for(const task of ['indexnow_delivery','indexnow.sweep.v1']) it(`rejects main ${task}`,()=>outcome({...domain,WORKER_TASK_ALLOWLIST:task},'worker_main_indexnow_forbidden'));
  if(site.mode==='preprod') {
    for(const approved of ['indexnow_outbox','indexnow_delivery','indexnow_outbox,indexnow_delivery']) it(`rejects preprod registration ${approved}`,()=>outcome({...domain,PREPROD_APPROVED_OPEN_WRITE_GATES:approved},'indexnow_registration_requires_public'));
  } else {
    for(const f of ['false','true']) for(const w of ['false','true']) it(`registered outbox allows ${f}/${w}`,()=>outcome({...domain,PREPROD_APPROVED_OPEN_WRITE_GATES:'indexnow_outbox',FEATURE_INDEXNOW_OUTBOX:f,INDEXNOW_OUTBOX_ALLOW_WRITE:w}));
    it('requires outbox before delivery registration',()=>outcome({...domain,PREPROD_APPROVED_OPEN_WRITE_GATES:'indexnow_delivery'},'indexnow_delivery_requires_outbox'));
    it('requires the delivery consumer together with registration',()=>outcome({...domain,PREPROD_APPROVED_OPEN_WRITE_GATES:'indexnow_outbox,indexnow_delivery'},'indexnow_delivery_allowlist_mismatch'));
    for(const f of ['false','true']) for(const w of ['false','true']) it(`registered delivery allows ${f}/${w} when consumer present`,()=>outcome({...domain,PREPROD_APPROVED_OPEN_WRITE_GATES:'indexnow_outbox,indexnow_delivery',FEATURE_INDEXNOW_DELIVERY:f,INDEXNOW_DELIVERY_ALLOW_WRITE:w,WORKER_LIGHT_TASK_ALLOWLIST:'sitemap_refresh, indexnow.sweep.v1 indexnow_delivery'}));
    for(const name of ['FEATURE_INDEXNOW_OUTBOX','INDEXNOW_OUTBOX_ALLOW_WRITE','FEATURE_INDEXNOW_DELIVERY','INDEXNOW_DELIVERY_ALLOW_WRITE']) it(`registered invalid ${name} rejected`,()=>outcome({...domain,PREPROD_APPROVED_OPEN_WRITE_GATES:'indexnow_outbox,indexnow_delivery',WORKER_LIGHT_TASK_ALLOWLIST:'indexnow_delivery',[name]:'TRUE'},name.includes('OUTBOX')?'indexnow_outbox_invalid':'indexnow_delivery_invalid'));
  }
});
it('uses the worker-lanes token boundaries, not substring matching',()=>{
  for(const raw of ['indexnow_delivery','sitemap_refresh, indexnow_delivery','sitemap_refresh\nindexnow_delivery\tindexnow.sweep.v1','not_indexnow_delivery','indexnow_delivery_extra','']) {
    const r=spawnSync('/bin/bash',['-c','source scripts/preproduction/lib.sh; preprod_allowlist_has "$1" indexnow_delivery','--',raw],{encoding:'utf8'});
    expect(r.status===0,raw).toBe(parseTaskTypes(raw).includes('indexnow_delivery'));
  }
});
