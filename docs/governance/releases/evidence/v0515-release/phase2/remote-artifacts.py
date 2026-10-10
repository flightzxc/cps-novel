import pathlib,subprocess,json,hashlib
final='db623505539c3ca55f55b1270aab829b8db102d7';staging=pathlib.Path('/opt/cps-novel/shared/artifacts/staging/v0515');root=pathlib.Path('/opt/cps-novel/releases')/final;old=pathlib.Path('/opt/cps-novel/current').resolve();assert old.name=='bf61b5ea276a0981870cdfa63578a822a65836f3'
subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=staging,check=True)
assert not root.exists(),root
subprocess.run(['git','clone','--shared','--no-checkout',str(old),str(root)],check=True)
bundle=staging/'cps-novel-v0.5.15.bundle'
subprocess.run(['git','-C',str(root),'bundle','verify',str(bundle)],check=True)
subprocess.run(['git','-C',str(root),'fetch',str(bundle),'release/v0.5.15-2026-10-10'],check=True)
subprocess.run(['git','-C',str(root),'checkout','--detach',final],check=True)
run=lambda a:subprocess.check_output(a,text=True).strip()
assert run(['git','-C',str(root),'rev-parse','HEAD'])==final
assert run(['git','-C',str(root),'rev-parse','HEAD^{tree}'])=='c8252747d2115d4cc36b2f85add9b985341f2adc'
assert not run(['git','-C',str(root),'status','--porcelain=v1'])
print('REMOTE_CHECKOUT=PASS Final='+final+' tree=c8252747d2115d4cc36b2f85add9b985341f2adc',flush=True)
subprocess.run([str(root/'scripts/preproduction/verify-release-archive.sh'),'--manifest',str(staging/(final+'.json')),'--expected-archive-sha256','54f38dbc8d49e815db22c452825898f438af70c6ca320145aabfd4694a74d8c6','--approved-commit',final,'--load'],check=True)
print('REMOTE_ARTIFACTS=PASS')
