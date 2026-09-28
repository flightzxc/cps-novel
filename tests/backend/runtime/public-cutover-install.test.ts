import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

function fixture() {
 const dir=mkdtempSync(path.join(tmpdir(),'cutover-install-'));
 for(const p of ['bin','etc/nginx/conf.d','etc/nginx/snippets','etc/nginx/sites-enabled','etc/nginx/sites-available','shared'])mkdirSync(path.join(dir,p),{recursive:true});
 writeFileSync(`${dir}/etc/nginx/conf.d/cps-novel-preprod.conf`,'old-site\n');
 writeFileSync(`${dir}/etc/nginx/sites-available/default`,'listen 80 default_server;\n');
 symlinkSync('../sites-available/default',`${dir}/etc/nginx/sites-enabled/default`);
 writeFileSync(`${dir}/bin/sudo`, `#!/usr/bin/env python3
import os,sys,subprocess
args=sys.argv[1:]
args=[os.environ['FIXTURE']+a if a.startswith('/etc/nginx') else a for a in args]
if args[0]=='install':
 for flag in ['-o','-g']:
  if flag in args:
   i=args.index(flag); del args[i:i+2]
sys.exit(subprocess.call(args))
`,{mode:0o755});
 writeFileSync(`${dir}/bin/nginx`, `#!/usr/bin/env python3
import os,sys,signal
if '-v' in sys.argv: print('nginx version: nginx/1.24.0'); sys.exit(0)
p=os.environ['FIXTURE']+'/checks'
n=int(open(p).read())+1 if os.path.exists(p) else 1
open(p,'w').write(str(n))
if os.environ.get('INTERRUPT_AT')==str(n): os.kill(os.getppid(),signal.SIGTERM)
# First sudo child parent is the installer shell via the sudo stub.
if os.environ.get('FAIL_AT')==str(n): sys.exit(1)
`,{mode:0o755});
 // Interrupt the actual installer from the sudo stub, before its child nginx.
 const sudo=readFileSync(`${dir}/bin/sudo`,'utf8').replace("sys.exit(subprocess.call(args))", "\nif args[0]=='nginx' and os.environ.get('INTERRUPT_AT')=='1' and not os.path.exists(os.environ['FIXTURE']+'/interrupted'):\n import signal\n open(os.environ['FIXTURE']+'/interrupted','w').write('1')\n os.kill(os.getppid(),signal.SIGTERM)\n os.environ.pop('INTERRUPT_AT',None)\nsys.exit(subprocess.call(args))");
 writeFileSync(`${dir}/bin/sudo`,sudo,{mode:0o755});
 writeFileSync(`${dir}/bin/systemctl`, `#!/usr/bin/env python3
import os,sys
p=os.environ['FIXTURE']+'/reloads'
n=int(open(p).read())+1 if os.path.exists(p) else 1
open(p,'w').write(str(n))
if os.environ.get('FAIL_RELOAD_AT')==str(n): sys.exit(1)
`,{mode:0o755});
 const run=(args:string[],extra:Record<string,string|undefined>={})=>spawnSync('/bin/bash',['scripts/preproduction/install-nginx.sh',...args],{encoding:'utf8',env:{NODE_ENV:"test",PATH:`${dir}/bin:${process.env.PATH}`,HOME:process.env.HOME,FIXTURE:dir,PREPROD_OWNER_SUDO_APPROVED:'YES',PREPROD_SHARED_ROOT:`${dir}/shared`,...extra}});
 return {dir,run,clean:()=>rmSync(dir,{recursive:true,force:true})};
}
describe('public nginx transaction',()=>{
 it('bootstrap is additive, public replaces it, and exact restore retains the default-site symlink',()=>{
  const f=fixture();try{
   expect(f.run(['--bootstrap-public']).status).toBe(0);expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`,'utf8')).toBe('old-site\n');
   const r=f.run(['--mode','public']);expect(r.status,r.stderr+r.stdout).toBe(0);expect(existsSync(`${f.dir}/etc/nginx/conf.d/cps-novel-public-bootstrap.conf`)).toBe(false);
   const backup=r.stdout.match(/^NGINX_BACKUP=(.+)$/m)![1];expect(existsSync(`${backup}/READY`)).toBe(true);
   const restore=f.run(['--restore-backup',backup]);expect(restore.status,restore.stderr).toBe(0);
   expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`,'utf8')).toBe('old-site\n');expect(existsSync(`${f.dir}/etc/nginx/conf.d/cps-novel-public-bootstrap.conf`)).toBe(true);
   expect(readlinkSync(`${f.dir}/etc/nginx/sites-enabled/default`)).toBe('../sites-available/default');expect(existsSync(backup)).toBe(true);
  }finally{f.clean();}
 });
 for(const failure of [{FAIL_AT:'1'},{FAIL_RELOAD_AT:'1'},{INTERRUPT_AT:'1'}])it(`restores all files after ${Object.keys(failure)[0]}`,()=>{
  const f=fixture();try{const r=f.run(['--mode','public'],failure);expect(r.status,r.stdout+r.stderr).not.toBe(0);expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`,'utf8')).toBe('old-site\n');expect(readlinkSync(`${f.dir}/etc/nginx/sites-enabled/default`)).toBe('../sites-available/default');expect(existsSync(`${f.dir}/etc/nginx/snippets/cps-novel-edge-public-security.conf`)).toBe(false);expect(readdirSync(`${f.dir}/shared/nginx-backups`).length).toBe(1);expect(r.stderr).toContain('candidate_failed_restored');}finally{f.clean();}
 });
 it('refuses incomplete backup before touching live files',()=>{
  const f=fixture();try{const backup=`${f.dir}/shared/nginx-backups/install.invalid`;mkdirSync(backup,{recursive:true});writeFileSync(`${backup}/READY`,'');const r=f.run(['--restore-backup',backup]);expect(r.status).toBe(65);expect(r.stdout).toContain('backup_invalid');expect(readFileSync(`${f.dir}/etc/nginx/conf.d/cps-novel-preprod.conf`,'utf8')).toBe('old-site\n');expect(existsSync(`${f.dir}/reloads`)).toBe(false);}finally{f.clean();}
 });
});
