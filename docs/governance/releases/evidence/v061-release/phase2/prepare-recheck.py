from pathlib import Path
r=Path.cwd();o=r/'.tmp/v061-release/phase2';s=(o/'remote-initial.py').read_text();s=s.split("status=json.loads(run(['docker','exec','cps-novel-worker-light-1'")[0]
s+='''expected={'manualCount':635,'manualDigest':'ac2b4b10e414ef8c7520d718c72439140b5a3c1f7a34a1d9bbca44b6640a386f','publishedCount':1977,'publishedDigest':'42499c6f369bbf44008e62715da659b0f68248e1b8d80c3ecc29a108c95d3f6c'}
assert {k:rows[0][k] for k in expected}==expected,'PROTECTED_SNAPSHOT_CHANGED'
print('IMMEDIATE_PREDEPLOY_RECHECK=PASS')
'''
(o/'recheck.py').write_text(s)
