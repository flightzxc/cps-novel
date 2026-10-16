from pathlib import Path
import hashlib,json
r=Path.cwd();o=r/'.tmp/v061-release/phase2';a=r/'.tmp/preproduction-archive';old=r/'docs/governance/releases/evidence/v060-release/phase2'; final='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'; prev='493eb23b034b0410780228535b3e293e4ee91f9a'
files=[a/'cps-novel-0.6.1-cb255e0.tar.zst',a/(final+'.json'),a/'cps-novel-code-cb255e0.bundle',a/'cps-novel-0.6.1-cb255e0.tar.zst.sha256']
assert all(p.exists() for p in files)
(o/'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in files))
u=(old/'upload.py').read_text();start=u.index('paths=');end=u.index('\nssh=',start);u=u[:start]+'paths='+repr([str(p) for p in files]+[str(o/'SHA256SUMS')])+u[end:];u=u.replace('/staging/v060','/staging/v061');(o/'upload.py').write_text(u)
s=(old/'remote-artifacts.py').read_text().replace(prev,final).replace('db623505539c3ca55f55b1270aab829b8db102d7',prev).replace('/v060','/v061').replace('cps-novel-v0.6.0.bundle','cps-novel-code-cb255e0.bundle').replace("'release/v0.6.0-2026-10-14'","'HEAD'").replace('c44f44702924fcc32fac0dc62ccb39fa0128d502','34d2fcbc052762544cefec1f97466b2d1e786762').replace('9382e6085cd9d4a30eb8b346750d2c1638266f0d40bac705923112c8de715ace','fd28086213f154430d302024840a154824d394cecfe4af24a12966e3636bee13');(o/'remote-artifacts.py').write_text(s)
for name in ['backup.py','env-v060.py','deploy-v060.py']:
 s=(old/name).read_text().replace(prev,final).replace('493eb23','cb255e0').replace('v060','v061').replace('v0.6.0','v0.6.1')
 if name=='env-v060.py':s=(old/name).read_text().replace('v060','v061').replace('53d5c5c48b7c679677f3d30d49f6f9f0a53da84ab843b8806512f516b4d95a50','f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369').replace('0.6.0','0.6.1').replace('0.5.15','0.6.0')
 (o/name.replace('v060','v061')).write_text(s)
print('ARTIFACT_HELPERS_READY')
