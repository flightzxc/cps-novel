import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe,it,expect } from 'vitest';
import { SITE_MODE_CASES } from './site-mode-fixture';
function verify(site:typeof SITE_MODE_CASES[number],maintenance:boolean,extra:Record<string,string>={},expectLive=false){
 const dir=mkdtempSync(path.join(tmpdir(),'cutover-release-'));mkdirSync(`${dir}/bin`);mkdirSync(`${dir}/maintenance`);
 if(maintenance)writeFileSync(`${dir}/maintenance/enabled`,'');
 writeFileSync(`${dir}/env`,`P1_12_COMPOSE_PROJECT=cps-novel\nSITE_URL=${site.SITE_URL}\nADMIN_CANONICAL_ORIGIN=${site.ADMIN_CANONICAL_ORIGIN}\nPREPROD_SHARED_ROOT=${dir}\n`);
 writeFileSync(`${dir}/bin/curl`,`#!/usr/bin/env python3
import sys,os
from urllib.parse import urlparse
args=sys.argv[1:];url=args[-1];u=urlparse(url)
public=u.netloc==urlparse(os.environ['SITE_URL']).netloc
live=os.environ['CASE_MODE']=='public'
maintenance=os.path.exists(os.environ['PREPROD_SHARED_ROOT']+'/maintenance/enabled')
code=404 if public and u.path in ['/dashboard','/api/admin'] else 503 if maintenance else 200 if public and live else 401
if os.environ.get('BAD_STATUS')=='1': code=200
headers='X-Content-Type-Options: nosniff\\n'
if not (live and public) or os.environ.get('LEAK_ROBOTS')=='1': headers+='X-Robots-Tag: noindex, nofollow, noarchive\\n'
if live and public: headers+='Strict-Transport-Security: max-age=86400\\n'
body='<h1>Maintenance in progress</h1>' if code==503 else 'fixture'
if os.environ.get('BAD_BODY')=='1': body='upstream failed'
open(args[args.index('--dump-header')+1],'w').write(headers)
open(args[args.index('--output')+1],'w').write(body)
print(code,end='')
`,{mode:0o755});
 try{return spawnSync('/bin/bash',['scripts/preproduction/verify-release.sh','--anonymous-only',...(expectLive?['--expect-live']:[])],{encoding:'utf8',env:{NODE_ENV:"test",PATH:`${dir}/bin:${process.env.PATH}`,HOME:process.env.HOME,PREPROD_ENV_FILE:`${dir}/env`,CASE_MODE:site.mode,...extra}});}
 finally{rmSync(dir,{recursive:true,force:true});}
}
describe.each(SITE_MODE_CASES)('$mode release verification',site=>{
 for(const maintenance of [false,true])it(`checks the real live/maintenance expectation maintenance=${maintenance}`,()=>{const r=verify(site,maintenance);expect(r.status,r.stderr+r.stdout).toBe(0);expect(r.stdout).toContain('RELEASE_VERIFY=PASS mode=anonymous_only');});
 it('never accepts business content while maintenance should be active',()=>expect(verify(site,true,{BAD_STATUS:'1'}).status).toBe(65));
 it('rejects a generic upstream 503 instead of the known maintenance page',()=>expect(verify(site,true,{BAD_BODY:'1'}).status).toBe(65));
 it('refuses stale maintenance marker in the final live check',()=>{const r=verify(site,true,{},true);expect(r.status).toBe(65);expect(r.stdout).toContain('expect_live_maintenance_marker_present');});
 if(site.mode==='public')it('rejects leaked public noindex',()=>{const r=verify(site,false,{LEAK_ROBOTS:'1'});expect(r.status).toBe(65);expect(r.stdout).toContain('public_robots_tag');});
});
