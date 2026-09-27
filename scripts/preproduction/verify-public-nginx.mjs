import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url)),mode=process.argv[2];
assert(['rehearsal','public'].includes(mode));
const dir=mkdtempSync(path.join(tmpdir(),'cps-cutover-')), network=`cps-cutover-${process.pid}`;
const edge=`${network}-edge`, mock=`${network}-mock`, client=`${network}-client`;
const run=(cmd,args,opts={})=>execFileSync(cmd,args,{encoding:'utf8',...opts});
const docker=(...args)=>run('docker',args), pause=ms=>new Promise(r=>setTimeout(r,ms));
const pub=mode==='public'?'pulsenovels.com':'www.bangbangji.cloud', admin=mode==='public'?'zbcwf.pulsenovels.com':'zbcwf.bangbangji.cloud';
const auth={Authorization:'Basic '+Buffer.from('qa:matrix-secret').toString('base64')};
let hp,sp,mp;
function get(host,p,headers={},tls=true){return new Promise((resolve,reject)=>{const q=(tls?https:http).get({hostname:'127.0.0.1',port:tls?sp:hp,path:p,servername:host,rejectUnauthorized:false,headers:{Host:host,...headers},agent:false},r=>{let body='';r.on('data',c=>{body+=c;});r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body}));});q.setTimeout(12000,()=>q.destroy(Error('timeout')));q.on('error',reject);});}
async function probe(host,p,status,h={},tls=true){const r=await get(host,p,h,tls);assert.equal(r.status,status,`${mode} ${host}${p}: ${r.status}`);return r;}
function security(r,kind){assert.equal(r.headers['x-content-type-options'],'nosniff');assert.equal(r.headers['x-frame-options'],'DENY');assert.equal(r.headers['referrer-policy'],'strict-origin-when-cross-origin');assert.equal(r.headers['permissions-policy'],'camera=(), microphone=(), geolocation=()');if(kind==='public'&&mode==='public'){assert.equal(r.headers['x-robots-tag'],undefined,'public X-Robots-Tag leaked');assert.equal(r.headers['strict-transport-security'],'max-age=86400');}else assert.equal(r.headers['x-robots-tag'],'noindex, nofollow, noarchive');}
async function ready(){for(let i=0;i<40;i++){try{await get(pub,'/api/health',auth);return;}catch{await pause(100);}}throw Error('nginx not ready');}
async function reset(){docker('restart',edge);sp=Number(docker('port',edge,'443/tcp').trim().split(':').at(-1));hp=Number(docker('port',edge,'80/tcp').trim().split(':').at(-1));await ready();}
function active(){return new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${mp}/control`,r=>{let b='';r.on('data',c=>{b+=c;});r.on('end',()=>resolve(JSON.parse(b).active));}).on('error',reject));}
async function waitActive(n){for(let i=0;i<80;i++){if(await active()===n)return;await pause(25);}throw Error(`upstream did not reach ${n} active requests`);}
function fromContainer(container,p,ua,prefetch=''){return Number(docker('exec',container,'node','-e',`require('https').get({hostname:'edge',port:443,path:${JSON.stringify(p)},rejectUnauthorized:false,headers:{Host:${JSON.stringify(pub)},Authorization:${JSON.stringify(auth.Authorization)},'User-Agent':${JSON.stringify(ua)},'Next-Router-Prefetch':${JSON.stringify(prefetch)}}} ,r=>{r.resume();r.on('end',()=>console.log(r.statusCode));}).on('error',()=>process.exit(1));`).trim());}
try{
 for(const sub of ['snippets','shared/secrets','shared/maintenance','acme/.well-known/acme-challenge','certs/pulsenovels.com','certs/www.bangbangji.cloud','certs/zbcwf.bangbangji.cloud'])mkdirSync(`${dir}/${sub}`,{recursive:true});
 for(const name of ['cps-novel-preprod-security','cps-novel-preprod-protected','cps-novel-preprod-protected-nomaintenance','cps-novel-preprod-proxy','cps-novel-edge-public-security','cps-novel-edge-admin-security','cps-novel-edge-maintenance'])cpSync(`${root}/infra/preproduction/nginx/${name}.conf`,`${dir}/snippets/${name}.conf`);
 writeFileSync(`${dir}/shared/secrets/nginx-preprod.htpasswd`,'qa:'+run('openssl',['passwd','-apr1','matrix-secret']).trim()+'\n');
 cpSync(`${root}/infra/preproduction/maintenance/__preprod_maintenance.html`,`${dir}/shared/maintenance/__preprod_maintenance.html`);
 writeFileSync(`${dir}/acme/.well-known/acme-challenge/probe`,'challenge-ok');
 run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=pulsenovels.com','-keyout',`${dir}/certs/pulsenovels.com/privkey.pem`,'-out',`${dir}/certs/pulsenovels.com/fullchain.pem`],{stdio:'ignore'});
 for(const host of ['www.bangbangji.cloud','zbcwf.bangbangji.cloud'])for(const f of ['privkey.pem','fullchain.pem'])cpSync(`${dir}/certs/pulsenovels.com/${f}`,`${dir}/certs/${host}/${f}`);
 run('/bin/bash',[`${root}/scripts/preproduction/render-nginx.sh`,'--mode',mode,'--test-upstream','mock-web:3000','--output',`${dir}/site.conf`],{env:{...process.env,PREPROD_NGINX_TEST_MODE:'1'}});
 writeFileSync(`${dir}/mock.cjs`,`const http=require('http');let active=0;http.createServer((q,s)=>{if(q.headers['x-test-abort']){q.socket.destroy();return;}if(q.url==='/control'){s.end(JSON.stringify({active}));return;}active++;setTimeout(()=>{s.setHeader('Content-Type',q.url.includes('.js')?'application/javascript':'text/plain');s.setHeader('Cache-Control','private, max-age=0');if(q.headers.host==='pulsenovels.com')s.setHeader('X-Robots-Tag','noindex');s.statusCode=q.url==='/missing'?404:200;s.end('BUSINESS_CONTENT '+'.'.repeat(4096));active--;},Number(q.headers['x-test-delay']||0));}).listen(3000,'0.0.0.0');`);
 docker('network','create',network);
 docker('run','-d','--name',mock,'--network',network,'--network-alias','mock-web','-p','127.0.0.1::3000','-v',`${dir}/mock.cjs:/mock.cjs:ro`,'node:20-alpine','node','/mock.cjs');
 docker('run','-d','--name',client,'--network',network,'node:20-alpine','tail','-f','/dev/null');
 writeFileSync(`${dir}/nginx.conf`,'user nginx; worker_processes 1; events { worker_connections 4096; } http { include /etc/nginx/mime.types; gzip on; include /etc/nginx/conf.d/*.conf; }\n');
 docker('run','-d','--name',edge,'--network',network,'--network-alias','edge','-p','127.0.0.1::80','-p','127.0.0.1::443','-v',`${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`,'-v',`${dir}/site.conf:/etc/nginx/conf.d/default.conf:ro`,'-v',`${dir}/snippets:/etc/nginx/snippets:ro`,'-v',`${dir}/certs:/etc/letsencrypt/live:ro`,'-v',`${dir}/shared:/opt/cps-novel/shared:ro`,'-v',`${dir}/acme:/var/lib/letsencrypt:ro`,'nginx:1.24.0-alpine');
 docker('exec',edge,'nginx','-t');
 sp=Number(docker('port',edge,'443/tcp').trim().split(':').at(-1));hp=Number(docker('port',edge,'80/tcp').trim().split(':').at(-1));mp=Number(docker('port',mock,'3000/tcp').trim().split(':').at(-1));await ready();
 if(!process.argv.includes('--smoke-only')){
  for(const p of ['/','/ko','/novel/book','/ko/novel/book/chapter/1','/browse','/ko/category/fiction','/blog/a','/go/a','/ko/go/a','/robots.txt','/sitemap.xml','/sitemap/ko.xml','/indexnow-key.txt','/api/health','/brand/og-default.png','/_next/static/a.js','/missing']){
   security(await probe(pub,p,mode==='public'?(p==='/missing'?404:200):401),'public');security(await probe(pub,p,p==='/missing'?404:200,auth),'public');await pause(100);
  }
  for(const p of ['/dashboard','/login','/api/admin','/api/admin/foo','/api/health/worker','/api/health/backup'])for(const h of [{},auth])security(await probe(pub,p,404,h),'public');
  for(const p of ['/login','/dashboard','/api/admin','/api/health','/api/health/worker','/api/health/backup','/_next/static/a.js']){security(await probe(admin,p,401),'admin');security(await probe(admin,p,200,auth),'admin');}
  for(const p of ['/','/ko','/novel/book','/browse','/robots.txt','/sitemap.xml','/go/a','/brand/og-default.png','/api/health-anything','/api/health/other','/api/health/worker/extra'])for(const h of [{},auth])security(await probe(admin,p,404,h),'admin');
  await probe('unknown.example','/',404);await assert.rejects(get('unknown.example','/',{},false));
  for(const h of [pub,admin]){assert.equal((await probe(h,'/path?q=1',301,{},false)).headers.location,`https://${h}/path?q=1`);await probe(h,'/.well-known/acme-challenge/probe',200,{},false);}
  if(mode==='public')for(const [h,target]of [['www.pulsenovels.com',pub],['www.bangbangji.cloud',pub],['zbcwf.bangbangji.cloud',admin]])for(const tls of [false,true]){assert.equal((await probe(h,'/path?q=1',301,{},tls)).headers.location,`https://${target}/path?q=1`);await probe(h,'/.well-known/acme-challenge/probe',200,{},tls);}
  assert.equal((await probe(pub,'/_next/static/a.js',200,auth)).headers['cache-control'],'public, max-age=31536000, immutable');
  assert.equal((await probe(pub,'/brand/og-default.png',200,auth)).headers['cache-control'],'public, max-age=86400');
  for(const p of ['/robots.txt','/sitemap.xml','/sitemap/ko.xml','/indexnow-key.txt','/api/health'])assert.equal((await probe(pub,p,200,auth)).headers['cache-control'],'no-store');
  assert.equal((await probe(pub,'/_next/static/a.js',200,{...auth,'Accept-Encoding':'gzip'})).headers['content-encoding'],'gzip');
  writeFileSync(`${dir}/shared/maintenance/enabled`,'');
  for(const [host,kind]of [[pub,'public'],[admin,'admin']]){for(const h of [{},auth]){const r=await probe(host,host===pub?'/':'/login',503,h);assert(r.body.includes('<h1>Maintenance in progress</h1>'));security(r,kind);assert.equal(r.headers['cache-control'],'no-store');}security(await probe(host,'/api/health',200,auth),kind);}
  await probe(pub,'/api/health',mode==='public'?200:401);await probe(admin,'/api/health',401);await probe(pub,'/api/health/worker',404,auth);
  for(const p of ['/brand/og-default.png','/_next/static/a.js'])assert.equal((await probe(pub,p,503,auth)).headers['cache-control'],'no-store');
  rmSync(`${dir}/shared/maintenance/enabled`);
  if(mode==='rehearsal'){
   run('/bin/bash',[`${root}/scripts/preproduction/render-nginx.sh`,'--bootstrap-public','--output',`${dir}/bootstrap.conf`]);docker('cp',`${dir}/bootstrap.conf`,`${edge}:/etc/nginx/conf.d/public-bootstrap.conf`);docker('exec',edge,'nginx','-t');docker('exec',edge,'nginx','-s','reload');await pause(200);
   for(const h of ['pulsenovels.com','www.pulsenovels.com','zbcwf.pulsenovels.com']){await probe(h,'/.well-known/acme-challenge/probe',200,{},false);await probe(h,'/',404,{},false);await probe(h,'/',404);}
   await probe(pub,'/',401);docker('exec',edge,'rm','/etc/nginx/conf.d/public-bootstrap.conf');await reset();
  }
  // An unavailable upstream must remain a real 502, with the correct headers.
  security(await probe(pub,'/api/health',502,{...auth,'X-Test-Abort':'1'}),'public');
  console.log(`NGINX_MATRIX=PASS mode=${mode}`);
 }
 for(const [p,expected,prefetch]of [['/novel/book',[200,200,200,429],''],['/go/a',[200,200,429],''],['/novel/book',[200,200,200,429],'2']]){await reset();const codes=[];for(let i=0;i<expected.length;i++)codes.push(fromContainer(i%2?client:mock,p,'ClaudeBot',prefetch));assert.deepEqual(codes,expected,`crawler key across two real IPs ${p}`);console.log(`NGINX_RATE=PASS mode=${mode} case=crawler path=${p} prefetch=${prefetch||"none"} statuses=${codes}`);}
 await reset();for(const ua of ['Claude-User','ChatGPT-User','Googlebot','Bingbot'])for(let i=0;i<4;i++)await probe(pub,'/novel/book',200,{...auth,'User-Agent':ua});
 const locales=JSON.parse('['+readFileSync(`${root}/src/lib/locale/locale-canonical.ts`,'utf8').match(/export const SITE_LOCALES:[^=]+?= Object\.freeze\(\[([\s\S]*?)\]\)/)[1].replace(/,\s*$/,'')+']');
 await reset();for(const locale of locales){security(await probe(pub,`/${locale}/browse`,200,auth),'public');await pause(90);}
 for(const [kind,n,headers]of [['page',10,{}],['prefetch',4,{'Next-Router-Prefetch':'1'}],['go',16,{}]]){
  await reset();const p=kind==='go'?'/go/a':'/novel/book';const holding=Array.from({length:n},(_,i)=>get(pub,i%2?`/ko${p}`:p,{...auth,...headers,'X-Test-Delay':'2200'}));await waitActive(n);
  security(await probe(pub,p,429,{...auth,...headers}),'public');if(kind==='page')await probe(pub,p,200,{...auth,'Next-Router-Prefetch':'2'});if(kind==='prefetch')await probe(pub,p,200,auth);
  assert((await Promise.all(holding)).every(r=>r.status===200));console.log(`NGINX_RATE=PASS mode=${mode} case=${kind}_concurrency limit=${n} rejected=429`);
 }
 await reset();const rates=await Promise.all(Array.from({length:60},(_,i)=>get(pub,i%2?'/ko/browse':'/browse',auth)));assert(rates.some(r=>r.status===429));assert(rates.every(r=>[200,429].includes(r.status)));
 const logs=docker('exec',edge,'cat','/var/log/nginx/cps-novel-public.access.log').trim().split('\n').map(l=>JSON.parse(l));assert(logs.some(l=>l.limit_req_status==='REJECTED'));assert(logs.some(l=>l.limit_conn_status==='REJECTED'));for(const l of logs){assert('request_time'in l);assert('upstream_response_time'in l);assert('user_agent'in l);}
 console.log(`NGINX_RATE=PASS mode=${mode} case=mixed_locale_rate json_logs=PASS`);
}catch(error){try{console.error(docker('logs',edge));}catch{}throw error;}
finally{for(const name of [edge,mock,client])try{docker('rm','-f',name);}catch{}try{docker('network','rm',network);}catch{}rmSync(dir,{recursive:true,force:true});}
