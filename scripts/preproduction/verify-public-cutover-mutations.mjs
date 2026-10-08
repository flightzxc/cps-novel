// Explicit local mutation gate: require a clean committed baseline, restore
// bytes in finally, and prove each target matches HEAD again after its test.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.chdir(root);
execFileSync('git',['diff','--quiet']);
execFileSync('git',['diff','--cached','--quiet']);
mkdirSync('.tmp/public-cutover',{recursive:true});
const contract=['test','--','--maxWorkers=4','tests/backend/runtime/public-cutover-edge.test.ts'];
const installer=['test','--','--maxWorkers=4','tests/backend/runtime/public-cutover-install.test.ts'];
const mutations=[
 {name:'locale_omission',file:'scripts/preproduction/render-public-nginx.mjs',from:"locales.join('|')",to:"locales.filter(locale => locale !== 'ko').join('|')",cmd:'npm',args:[...contract,'-t','derives every registered locale']},
 {name:'crawler_ip_key',file:'infra/preproduction/nginx/cps-novel-public.conf.template',from:'limit_req_zone $cps_training_bot zone=cps_edge_bot_page',to:'limit_req_zone $binary_remote_addr zone=cps_edge_bot_page',cmd:'npm',args:[...contract,'-t','uses canonical bot names']},
 {name:'unregistered_indexnow',file:'scripts/preproduction/lib.sh',from:'if (( ! outbox )) &&',to:'if (( 0 )) &&',cmd:'npm',args:[...contract,'-t','rejects unregistered FEATURE_INDEXNOW_OUTBOX']},
 {name:'delivery_allowlist_desync',file:'scripts/preproduction/lib.sh',from:'if (( delivery != light_delivery ));',to:'if (( 0 ));',cmd:'npm',args:[...contract,'-t','requires the delivery consumer together with registration']},
 // Installer protections (2026-10-05 incident): every protection must be load-bearing.
 {name:'entry_guard_realpath',file:'scripts/preproduction/render-public-nginx.mjs',from:'realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))',to:'process.argv[1] === fileURLToPath(import.meta.url)',cmd:'npm',args:[...installer,'-t','renderer entry detection|installs the real candidate']},
 {name:'render_empty_guard_removed',file:'scripts/preproduction/render-nginx.sh',from:'if ! [[ -s "$temporary" ]]; then',to:'if false; then',cmd:'npm',args:[...installer,'-t','refuses an empty body']},
 {name:'gate_empty_check_removed',file:'scripts/preproduction/install-public-nginx.sh',from:'  if ! [[ -s "$rendered" ]]; then',to:'  if false; then',cmd:'npm',args:[...installer,'-t','refuses an empty candidate']},
 {name:'gate_shape_check_removed',file:'scripts/preproduction/install-public-nginx.sh',from:'    assert_candidate "$mode"',to:'    true',cmd:'npm',args:[...installer,'-t','candidate gate']},
 {name:'candidate_admin_auth_removed',file:'scripts/preproduction/verify-nginx-candidate.mjs',from:'[PROXY, ADMIN_AUTH, HTPASSWD, ...certLines(adminCert)]',to:'[PROXY, HTPASSWD, ...certLines(adminCert)]',cmd:'npm',args:[...installer,'-t','auth_basic line']},
 {name:'hash_check_removed',file:'scripts/preproduction/install-public-nginx.sh',from:'  if [[ "$got" != "$want" ]]; then',to:'  if false; then',cmd:'npm',args:[...installer,'-t','post-install hash check']},
 {name:'ready_wait_removed',file:'scripts/preproduction/install-public-nginx.sh',from:'  wait_ready "$phase" "$@"',to:'  true',cmd:'npm',args:[...installer,'-t','reload readiness wait']},
 {name:'ready_listener_probe_removed',file:'scripts/preproduction/install-public-nginx.sh',from:'      port_listening "$port" || missing="$missing $port"',to:'      :',cmd:'npm',args:[...installer,'-t','443 is not listening']},
 {name:'ready_old_worker_check_removed',file:'scripts/preproduction/install-public-nginx.sh',from:'case "$title" in *"shutting down"*|"") ;; *) return 1 ;; esac',to:'case "$title" in *) ;; esac',cmd:'npm',args:[...installer,'-t','without being told to quit']},
 {name:'public_noindex',file:'scripts/preproduction/render-public-nginx.mjs',from:"PUBLIC_ROBOTS: live ? '' :",to:"PUBLIC_ROBOTS: live ? 'noindex, nofollow, noarchive' :",cmd:'/bin/bash',args:['scripts/preproduction/verify-nginx-matrix.sh','--mode','public']},
];
// Optional names run a subset (keeps one foreground command short); a subset
// never prints the full-gate PASS line.
const only=process.argv.slice(2);
for(const name of only)if(!mutations.some(m=>m.name===name))throw Error(`unknown mutation: ${name}`);
for(const m of mutations.filter(m=>!only.length||only.includes(m.name))){
 const original=readFileSync(m.file),source=original.toString();
 if(!source.includes(m.from))throw Error(`mutation anchor missing: ${m.name}`);
 let result;
 try{
  writeFileSync(m.file,source.replace(m.from,m.to));
  result=spawnSync(m.cmd,m.args,{encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync(`.tmp/public-cutover/mutation-${m.name}.log`,`${result.stdout??''}${result.stderr??''}`);
  if(result.status===0||result.status===null)throw Error(`mutation did not fail normally: ${m.name}`);
  const output=`${result.stdout}${result.stderr}`;
  if(m.name==='public_noindex'&&!output.includes('public X-Robots-Tag leaked'))throw Error('matrix failed for a reason other than the intended noindex mutation');
  if(m.name!=='public_noindex'&&!output.includes('AssertionError'))throw Error(`mutation failed without a test assertion: ${m.name}`);
 }finally{
  writeFileSync(m.file,original);
  execFileSync('git',['diff','--quiet','--',m.file]);
 }
 console.log(`MUTATION=PASS name=${m.name} exit=${result.status} restored=git_diff_quiet`);
}
execFileSync('git',['diff','--quiet']);
console.log(only.length?`PUBLIC_CUTOVER_MUTATIONS=PARTIAL names=${only.join(',')}`:'PUBLIC_CUTOVER_MUTATIONS=PASS');
