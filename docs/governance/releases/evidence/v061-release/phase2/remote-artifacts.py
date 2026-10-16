import pathlib,subprocess,json,hashlib
final='cb255e0f1c93041eda6aefeefbb541d7eddfc15f';staging=pathlib.Path('/opt/cps-novel/shared/artifacts/staging/v061');root=pathlib.Path('/opt/cps-novel/releases')/final;old=pathlib.Path('/opt/cps-novel/current').resolve();assert old.name=='493eb23b034b0410780228535b3e293e4ee91f9a'
subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=staging,check=True)
assert not root.exists(),root
subprocess.run(['git','clone','--shared','--no-checkout',str(old),str(root)],check=True)
bundle=staging/'cps-novel-code-cb255e0.bundle'
subprocess.run(['git','-C',str(root),'bundle','verify',str(bundle)],check=True)
subprocess.run(['git','-C',str(root),'fetch',str(bundle),'HEAD'],check=True)
subprocess.run(['git','-C',str(root),'checkout','--detach',final],check=True)
run=lambda a:subprocess.check_output(a,text=True).strip()
assert run(['git','-C',str(root),'rev-parse','HEAD'])==final
assert run(['git','-C',str(root),'rev-parse','HEAD^{tree}'])=='34d2fcbc052762544cefec1f97466b2d1e786762'
assert not run(['git','-C',str(root),'status','--porcelain=v1'])
print('REMOTE_CHECKOUT=PASS Final='+final+' tree=34d2fcbc052762544cefec1f97466b2d1e786762',flush=True)
subprocess.run([str(root/'scripts/preproduction/verify-release-archive.sh'),'--manifest',str(staging/(final+'.json')),'--expected-archive-sha256','fd28086213f154430d302024840a154824d394cecfe4af24a12966e3636bee13','--approved-commit',final,'--load'],check=True)
print('REMOTE_ARTIFACTS=PASS')

verified=pathlib.Path('/opt/cps-novel/shared/artifacts/verified/v061');assert not verified.exists();verified.parent.mkdir(exist_ok=True);staging.rename(verified)
for p in verified.iterdir():
 if p.is_file():p.chmod(0o600)
print('ARTIFACT_VERIFIED_DIR='+str(verified))
