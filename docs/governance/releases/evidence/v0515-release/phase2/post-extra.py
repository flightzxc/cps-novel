import subprocess,json,pathlib,hashlib
expected={'FEATURE_INDEXNOW_OUTBOX': 'true', 'INDEXNOW_OUTBOX_ALLOW_WRITE': 'true', 'FEATURE_INDEXNOW_DELIVERY': 'true', 'INDEXNOW_DELIVERY_ALLOW_WRITE': 'true', 'PREPROD_APPROVED_OPEN_WRITE_GATES': 'catalog_write,promo_write,sitemap_write,auto_tag_write,indexnow_outbox,indexnow_delivery', 'WORKER_TASK_ALLOWLIST': 'credential.validate.v1,credential.supersede.v1,catalog_scan,promo_link.claim.v1,batch.materialize.v1,novel.materialize.v1,article.generate.v1,article.generate.batch.v1,article.generate.batch.v2,moboreader.preview_refresh.v1,tagging.auto_classify,changdu.revenue_sync.v1', 'WORKER_LIGHT_TASK_ALLOWLIST': 'sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1,indexnow.sweep.v1,article.publish.batch.v1,article.publish.v1,indexnow_delivery'}
p=pathlib.Path('/opt/cps-novel/shared/env/preprod.env')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603'
lines=p.read_text().splitlines();actual={k:next((l.split('=',1)[1] for l in lines if l.startswith(k+'=')),None) for k in expected}
assert actual==expected;print('ENV_FLAGS_AND_ALLOWLISTS_UNCHANGED='+json.dumps(actual))
for service in ['web','worker','worker-light','scheduler']:
 name='cps-novel-'+service+'-1'
 version=subprocess.check_output(['docker','exec',name,'node','-e',"console.log(require('next/package.json').version)"],text=True).strip();assert version=='16.3.8'
 print('NEXT_VERSION=16.3.8 service='+service)
 info=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0];env=dict(x.split('=',1) for x in info['Config']['Env'])
 if service in ['worker','worker-light']:
  k='WORKER_TASK_ALLOWLIST' if service=='worker' else 'WORKER_LIGHT_TASK_ALLOWLIST';assert env['WORKER_TASK_ALLOWLIST']==expected[k]
 if service=='worker-light':
  for k in ['FEATURE_INDEXNOW_DELIVERY','INDEXNOW_DELIVERY_ALLOW_WRITE']:assert env[k]=='true'
print('CONSUMER_ENV_AND_NEXT=PASS')
