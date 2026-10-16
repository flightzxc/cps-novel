from pathlib import Path
import json,re,subprocess
root=Path.cwd(); out=root/'.tmp/v061-release/phase1'
def step_file(name,suffix):
 aliases=json.loads((out/'effective-runners.json').read_text())
 if (out/'effective-brand.json').exists():aliases.update(json.loads((out/'effective-brand.json').read_text()))
 if (out/'effective-artifact.json').exists():aliases.update(json.loads((out/'effective-artifact.json').read_text()))
 actual=aliases.get(name,name)
 return out/(actual+suffix)

final=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()
assert final=='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'
assert not subprocess.check_output(['git','status','--porcelain=v1'])
scripts=sorted(p.stem for p in Path('scripts').glob('run-*-verification.sh') if p.name!='run-p1-12-runtime-verification.sh');assert len(scripts)==37
for name in scripts:
 meta=json.loads(step_file(name,'.meta.json').read_text());assert meta['exitCode']==0,name
 log=step_file(name,'.log').read_text();assert not re.search(r'Unhandled Errors|Unhandled Rejection|Uncaught Exception',log),name
required_steps=['npm-ci','prisma-generate','typecheck','lint','test-turnstile-retry','build','b21','nginx-matrix','public-cutover-mutations','brand-image','compose','image-e2e','archive-build','archive-verify']
if '--prepush' in __import__('sys').argv:required_steps=[n for n in required_steps if n not in ['archive-build','archive-verify']]
for name in required_steps:
 assert json.loads(step_file(name,'.meta.json').read_text())['exitCode']==0,name
required={
 'run-publication-preview-postgres-verification':['passed=20 skipped=0'],
 'run-indexnow-sweep-postgres-verification':['WO6_INTEGRATION=PASS passed=40 skipped=0','indexnow-sweep-postgres.test.ts (20 tests)','indexnow-batch-postgres.test.ts (20 tests)'],
 'run-effective-tag-projection-postgres-verification':['B38_MIGRATION_COUNT=PASS applied=27','B38_EFFECTIVE_TAG_INTEGRATION=PASS files=4 passed=44 skipped=0 failed=0'],
 'run-p1-06-postgres-verification':['DICTIONARY_DRIFT=0_OF_1279','TABLE_COUNT=58','P1_06_VERIFICATION=PASS'],
 'run-x9-postgres-verification':['X9_MIGRATION_empty=PASS migrations=27 tables=58','X9_MIGRATION_upgrade=PASS migrations=27 tables=58'],
 'run-next-proxy-probe-verification':['NEXT_PROXY_PROBE=PASS next=16.3.8 probes=1742 known_findings=0'],
 'run-plotnovel-theater-postgres-verification':['PLOTNOVEL_MIGRATION_COUNT=PASS applied=27','PLOTNOVEL_GRANTS_REPLAY_IDEMPOTENT=PASS','PLOTNOVEL_INTEGRATION=PASS files=6','PLOTNOVEL_DICTIONARY_DRIFT=0','PLOTNOVEL_THEATER_POSTGRES_VERIFICATION=PASS'],
 'b21':['B21_MEASUREMENT=PASS'], 'nginx-matrix':['NGINX_MATRIX_ALL=PASS'],
 'public-cutover-mutations':['PUBLIC_CUTOVER_MUTATIONS=PASS'],
 'brand-image':['RUNTIME_IMAGE_DEPS=PASS','BRAND_IMAGE=PASS'],
 'image-e2e':['E2E_MIGRATIONS=PASS applied=27','EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0','INDEXNOW_STATUS_HELP=PASS','PREVIEW_BACKFILL_SCRIPT_LOAD=PASS exit=64 validation=channel_app_id_invalid network=none database_url=unset','PLOTNOVEL_FUNCTION_TRIGGER=PASS','IMAGE_HEALTH=PASS','IMAGE_E2E=PASS'],
 'compose':['COMPOSE_ALL=PASS'], 'archive-build':['ARCHIVE_BUILD=PASS'], 'archive-verify':['IDENTITY=PASS','VERIFY_OFFLINE=PASS','IMAGE=PASS','VERIFY=PASS']}
if '--prepush' in __import__('sys').argv:
 required.pop('archive-build');required.pop('archive-verify')
for name,markers in required.items():
 s=step_file(name,'.log').read_text();assert all(x in s for x in markers),(name,[x for x in markers if x not in s])
rows=[json.loads(s) for s in Path('docs/governance/database-schema-dictionary.jsonl').read_text().splitlines() if s.strip()];assert len(rows)==1349;assert sum(r.get('status')=='active' for r in rows)==1279
assert len(list(Path('prisma/migrations').glob('*/migration.sql')))==27
report=json.loads((out/'test-full.json').read_text());assert report['numFailedTests']==1 and report['numPassedTests']==11423
retry=json.loads((out/'test-turnstile-retry.json').read_text());assert retry['success'] and retry['numFailedTests']==0
failed=[t for t in report['testResults'] if any(a['status']=='failed' for a in t['assertionResults'])];assert len(failed)==1 and failed[0]['name'].endswith('admin-login-turnstile-config-contract.test.ts')
assert len(retry['testResults'])==1 and retry['testResults'][0]['name']==failed[0]['name']
assert {a['fullName'] for a in retry['testResults'][0]['assertionResults']}=={a['fullName'] for a in failed[0]['assertionResults']}
assert not re.search(r'Unhandled Errors|Unhandled Rejection|Uncaught Exception',(out/'test-full.log').read_text())
for name in ['audit-production','audit-all']:
 r=json.loads(step_file(name,'.log').read_text());assert r['metadata']['vulnerabilities']['critical']==0
 if name=='audit-production':assert r['metadata']['vulnerabilities']['high']==4
summary=[f'FINAL={final}',f'TREE={tree}','RUNNERS_ALL=PASS count=37',f"FULL_TEST=PASS passed={report['numPassedTests']+1} skipped={report['numPendingTests']} failed=0 unhandled=0 timeout_retry_files=1",'MIGRATIONS=27 DICTIONARY_TOTAL=1349 DICTIONARY_ACTIVE=1279']
for p in sorted(out.glob('*.log')):
 s=p.read_text(errors='replace');lines=[x for x in s.splitlines() if re.match(r'^[A-Z][A-Z0-9_]*(=| )',x) and ('=PASS' in x or '=0' in x or x.startswith(('ARCHIVE_','IMAGE_TARGET_','IMAGE_CONFIG_','IMAGE_PLATFORM_','IMAGE_REVISION=')))];
 if lines:summary.extend(['',f'# {p.name}',*lines])
for name in ['audit-production','audit-all']:
 r=json.loads(step_file(name,'.log').read_text());v=r['metadata']['vulnerabilities'];names=sorted(n for n,x in r['vulnerabilities'].items() if x['severity']=='high');summary.append(f'{name.upper().replace("-","_")} critical={v["critical"]} high={v["high"]} high_packages={",".join(names)}')
(out/('prepush-summary.txt' if '--prepush' in __import__('sys').argv else 'phase1-summary.txt')).write_text('\n'.join(summary)+'\n')
print('PHASE1_EVIDENCE_VALIDATION=PASS')
