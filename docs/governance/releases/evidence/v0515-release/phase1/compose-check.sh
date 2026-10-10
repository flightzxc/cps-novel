#!/bin/bash
set -euo pipefail
set +x
cd /Users/chenweifeng/Documents/cps海阅/release-v0.5.15
umask 077
source scripts/lib/p1-12-local-env.sh
prepare_p1_12_local_environment
out="$PWD/.tmp/v0515-release"
docker compose -f docker-compose.yml config --format json > "$out/compose-root.private.json"
export X8_BASE_BACKUP_DIR="$P1_12_RUNTIME_DIR/base-backups"
export X8_NGINX_RUNTIME_DIR="$P1_12_RUNTIME_DIR/nginx"
export X8_TLS_DIR="$P1_12_RUNTIME_DIR/tls"
export X8_BACKUP_DIR="$P1_12_RUNTIME_DIR/backups"
export X8_BACKUP_PGPASS_FILE="$P1_12_SECRET_DIR/backup.pgpass"
docker compose -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json > "$out/compose-production-like.private.json"
source scripts/preproduction/lib.sh
PREPROD_ENV_FILE=/dev/null
preprod_compose config --format json > "$out/compose-preproduction.private.json"
python3 - <<'PY'
import subprocess,re,json
from pathlib import Path
for f in ['docker-compose.yml','infra/production-like/docker-compose.yml','infra/preproduction/docker-compose.yml','.env.example','infra/preproduction/preprod.env.example']:
 before=subprocess.check_output(['git','show',f'v0.5.14:{f}'],text=True)
 after=Path(f).read_text()
 keys=lambda x:set(re.findall(r'\$\{([A-Z][A-Z0-9_]*)',x))|set(re.findall(r'^([A-Z][A-Z0-9_]*)=',x,re.M))
 assert keys(before)==keys(after),f
 print(f'COMPOSE_VARIABLES=PASS file={f} added=0 removed=0')
 if f.endswith('docker-compose.yml'):assert before==after,f
summary={}
for name in ['root','production-like','preproduction']:
 data=json.loads(Path(f'.tmp/v0515-release/compose-{name}.private.json').read_text())
 summary[name]={k:sorted(v.get('environment',{})) for k,v in data['services'].items()}
 print(f'COMPOSE_RENDER=PASS mode={name} services={len(data["services"])}')
Path('.tmp/v0515-release/compose-environment-keys.json').write_text(json.dumps(summary,indent=2)+'\n')
print('COMPOSE_ALL=PASS')
PY
