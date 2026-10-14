import pathlib,subprocess,json,hashlib
final='493eb23b034b0410780228535b3e293e4ee91f9a';staging=pathlib.Path('/opt/cps-novel/shared/artifacts/staging/v060');root=pathlib.Path('/opt/cps-novel/releases')/final;old=pathlib.Path('/opt/cps-novel/current').resolve();assert old.name=='db623505539c3ca55f55b1270aab829b8db102d7'
subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=staging,check=True)
assert not root.exists(),root
subprocess.run(['git','clone','--shared','--no-checkout',str(old),str(root)],check=True)
bundle=staging/'cps-novel-v0.6.0.bundle'
subprocess.run(['git','-C',str(root),'bundle','verify',str(bundle)],check=True)
subprocess.run(['git','-C',str(root),'fetch',str(bundle),'release/v0.6.0-2026-10-14'],check=True)
subprocess.run(['git','-C',str(root),'checkout','--detach',final],check=True)
run=lambda a:subprocess.check_output(a,text=True).strip()
assert run(['git','-C',str(root),'rev-parse','HEAD'])==final
assert run(['git','-C',str(root),'rev-parse','HEAD^{tree}'])=='c44f44702924fcc32fac0dc62ccb39fa0128d502'
assert not run(['git','-C',str(root),'status','--porcelain=v1'])
print('REMOTE_CHECKOUT=PASS Final='+final+' tree=c44f44702924fcc32fac0dc62ccb39fa0128d502',flush=True)
subprocess.run([str(root/'scripts/preproduction/verify-release-archive.sh'),'--manifest',str(staging/(final+'.json')),'--expected-archive-sha256','9382e6085cd9d4a30eb8b346750d2c1638266f0d40bac705923112c8de715ace','--approved-commit',final,'--load'],check=True)
print('REMOTE_ARTIFACTS=PASS')

verified=pathlib.Path('/opt/cps-novel/shared/artifacts/verified/v060');assert not verified.exists();verified.parent.mkdir(exist_ok=True);staging.rename(verified)
for p in verified.iterdir():
 if p.is_file():p.chmod(0o600)
print('ARTIFACT_VERIFIED_DIR='+str(verified))
