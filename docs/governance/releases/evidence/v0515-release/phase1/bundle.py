from pathlib import Path
import subprocess,hashlib,json
bundle=Path('.tmp/v0515-release/cps-novel-v0.5.15.bundle'); assert not bundle.exists()
subprocess.run(['git','bundle','create',str(bundle),'release/v0.5.15-2026-10-10','^v0.5.14'],check=True)
subprocess.run(['git','bundle','verify',str(bundle)],check=True)
hash=hashlib.sha256(bundle.read_bytes()).hexdigest();print('CODE_BUNDLE=PASS');print('CODE_BUNDLE_SHA256='+hash);print('CODE_BUNDLE_BYTES='+str(bundle.stat().st_size));Path('.tmp/v0515-release/code-bundle.json').write_text(json.dumps({'path':str(bundle.resolve()),'sha256':hash,'bytes':bundle.stat().st_size},indent=2)+'\n')
