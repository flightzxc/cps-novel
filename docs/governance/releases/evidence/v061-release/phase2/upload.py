import subprocess
paths=['/Users/chenweifeng/Documents/cps海阅/release-v0.6.1/.tmp/preproduction-archive/cps-novel-0.6.1-cb255e0.tar.zst', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.1/.tmp/preproduction-archive/cb255e0f1c93041eda6aefeefbb541d7eddfc15f.json', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.1/.tmp/preproduction-archive/cps-novel-code-cb255e0.bundle', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.1/.tmp/preproduction-archive/cps-novel-0.6.1-cb255e0.tar.zst.sha256', '/Users/chenweifeng/Documents/cps海阅/release-v0.6.1/.tmp/v061-release/phase2/SHA256SUMS']
ssh=['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes']
subprocess.run(ssh+['haiyue-vps','mkdir','-m','700','/opt/cps-novel/shared/artifacts/staging/v061'],check=True)
subprocess.run(['rsync','--archive','--partial','--stats','-e',"ssh -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=20 -o BatchMode=yes -o ProxyCommand='nc -X connect -x 127.0.0.1:7899 %h %p'"]+paths+['haiyue-vps:/opt/cps-novel/shared/artifacts/staging/v061/'],check=True)
print('UPLOAD=PASS')
