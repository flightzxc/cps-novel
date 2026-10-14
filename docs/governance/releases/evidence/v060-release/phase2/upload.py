import subprocess
paths=['/Users/chenweifeng/Documents/cps海阅/release-v0.6.0/.tmp/v060-release/archive/cps-novel-0.6.0-493eb23.tar.zst', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.0/.tmp/v060-release/archive/493eb23b034b0410780228535b3e293e4ee91f9a.json', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.0/.tmp/v060-release/cps-novel-v0.6.0.bundle', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.0/.tmp/v060-release/archive/cps-novel-0.6.0-493eb23.tar.zst.sha256', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.0/.tmp/v060-release/phase2/SHA256SUMS']
ssh=['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes']
subprocess.run(ssh+['haiyue-vps','mkdir','-m','700','/opt/cps-novel/shared/artifacts/staging/v060'],check=True)
subprocess.run(['rsync','--archive','--partial','--stats','-e',"ssh -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=20 -o BatchMode=yes -o ProxyCommand='nc -X connect -x 127.0.0.1:7899 %h %p'"]+paths+['haiyue-vps:/opt/cps-novel/shared/artifacts/staging/v060/'],check=True)
print('UPLOAD=PASS')
