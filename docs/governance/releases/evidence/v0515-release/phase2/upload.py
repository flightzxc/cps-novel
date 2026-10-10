from pathlib import Path
import subprocess
ssh=['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','haiyue-vps']
subprocess.run(ssh+['mkdir -m 700 /opt/cps-novel/shared/artifacts/staging/v0515'],check=True)
root=Path.cwd();files=[root/'.tmp/preproduction-archive/cps-novel-0.5.15-db62350.tar.zst',root/'.tmp/preproduction-archive/db623505539c3ca55f55b1270aab829b8db102d7.json',root/'.tmp/v0515-release/cps-novel-v0.5.15.bundle',root/'.tmp/v0515-release/phase2/SHA256SUMS']
transport="ssh -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=20 -o BatchMode=yes -o ProxyCommand='nc -X connect -x 127.0.0.1:7899 %h %p'"
subprocess.run(['rsync','--archive','--partial','--stats','-e',transport]+[str(p) for p in files]+['haiyue-vps:/opt/cps-novel/shared/artifacts/staging/v0515/'],check=True)
print('UPLOAD=PASS')
