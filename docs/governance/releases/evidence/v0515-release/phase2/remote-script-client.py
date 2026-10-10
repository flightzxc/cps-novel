from pathlib import Path
import subprocess,sys
p=Path(sys.argv[1]);raise SystemExit(subprocess.run(['ssh','-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=20','-o','BatchMode=yes','haiyue-vps','python3','-u','-'],input=p.read_bytes()).returncode)
