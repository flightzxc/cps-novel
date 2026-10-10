from pathlib import Path
import subprocess
p=Path('.tmp/v0515-release/phase2/remote-initial.py')
raise SystemExit(subprocess.run(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','haiyue-vps','python3','-u','-'],input=p.read_bytes()).returncode)
