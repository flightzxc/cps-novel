from pathlib import Path
import json,re,subprocess
root=Path.cwd(); out=root/'.tmp/v0515-release/phase1'
final=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],text=True).strip()
assert final=='db623505539c3ca55f55b1270aab829b8db102d7'
assert not subprocess.check_output(['git','status','--porcelain=v1'])
scripts=sorted(p.stem for p in Path('scripts').glob('run-*-verification.sh') if p.name!='run-p1-12-runtime-verification.sh');assert len(scripts)==36
for name in scripts:
 meta=json.loads((out/(name+'.meta.json')).read_text());assert meta['exitCode']==0,name
 log=(out/(name+'.log')).read_text();assert not re.search(r'Unhandled Errors|Unhandled Rejection|Uncaught Exception',log),name
for name in ['npm-ci','prisma-generate','typecheck','lint','test-full','build','b21','nginx-matrix','public-cutover-mutations','brand-image','compose','image-e2e','archive-build','archive-verify']:
 assert json.loads((out/(name+'.meta.json')).read_text())['exitCode']==0,name
required={
 'run-indexnow-sweep-postgres-verification':['WO6_INTEGRATION=PASS passed=40 skipped=0','indexnow-sweep-postgres.test.ts (20 tests)','indexnow-batch-postgres.test.ts (20 tests)'],
 'run-effective-tag-projection-postgres-verification':['B38_MIGRATION_COUNT=PASS applied=26','B38_EFFECTIVE_TAG_INTEGRATION=PASS files=4 passed=44 skipped=0 failed=0'],
 'run-p1-06-postgres-verification':['DICTIONARY_DRIFT=0_OF_1273','TABLE_COUNT=58','P1_06_VERIFICATION=PASS'],
 'run-x9-postgres-verification':['X9_MIGRATION_empty=PASS migrations=26 tables=58','X9_MIGRATION_upgrade=PASS migrations=26 tables=58'],
 'run-next-proxy-probe-verification':['NEXT_PROXY_PROBE=PASS next=16.3.8 probes=1742 known_findings=0'],
 'b21':['B21_MEASUREMENT=PASS'], 'nginx-matrix':['NGINX_MATRIX_ALL=PASS'],
 'public-cutover-mutations':['PUBLIC_CUTOVER_MUTATIONS=PASS'],
 'brand-image':['RUNTIME_IMAGE_DEPS=PASS','BRAND_IMAGE=PASS'],
 'image-e2e':['E2E_MIGRATIONS=PASS applied=26','EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0','INDEXNOW_STATUS_HELP=PASS','IMAGE_HEALTH=PASS','IMAGE_E2E=PASS'],
 'compose':['COMPOSE_ALL=PASS'], 'archive-build':['ARCHIVE_BUILD=PASS'], 'archive-verify':['IDENTITY=PASS','VERIFY_OFFLINE=PASS','IMAGE=PASS','VERIFY=PASS']}
for name,markers in required.items():
 s=(out/(name+'.log')).read_text();assert all(x in s for x in markers),(name,[x for x in markers if x not in s])
rows=[json.loads(s) for s in Path('docs/governance/database-schema-dictionary.jsonl').read_text().splitlines() if s.strip()];assert len(rows)==1343;assert sum(r.get('status')=='active' for r in rows)==1273
assert len(list(Path('prisma/migrations').glob('*/migration.sql')))==26
report=json.loads((out/'test-full.json').read_text());assert report['success'] and report['numFailedTests']==0 and report['numPassedTests']==11181
for name in ['audit-production','audit-all']:
 r=json.loads((out/(name+'.log')).read_text());assert r['metadata']['vulnerabilities']['critical']==0
 if name=='audit-production':assert r['metadata']['vulnerabilities']['high']==4
summary=[f'FINAL={final}',f'TREE={tree}','RUNNERS_ALL=PASS count=36','FULL_TEST=PASS passed=11181 failed=0 unhandled=0','MIGRATIONS=26 DICTIONARY_TOTAL=1343 DICTIONARY_ACTIVE=1273']
for p in sorted(out.glob('*.log')):
 s=p.read_text(errors='replace');lines=[x for x in s.splitlines() if re.match(r'^[A-Z][A-Z0-9_]*(=| )',x) and ('=PASS' in x or '=0' in x or x.startswith(('ARCHIVE_','IMAGE_TARGET_','IMAGE_CONFIG_','IMAGE_PLATFORM_','IMAGE_REVISION=')))];
 if lines:summary.extend(['',f'# {p.name}',*lines])
for name in ['audit-production','audit-all']:
 r=json.loads((out/(name+'.log')).read_text());v=r['metadata']['vulnerabilities'];names=sorted(n for n,x in r['vulnerabilities'].items() if x['severity']=='high');summary.append(f'{name.upper().replace("-","_")} critical={v["critical"]} high={v["high"]} high_packages={",".join(names)}')
(out/'phase1-summary.txt').write_text('\n'.join(summary)+'\n')
print('PHASE1_EVIDENCE_VALIDATION=PASS')
