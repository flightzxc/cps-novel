ids=['b76261cb-fdae-4fba-a2cb-39cd17ac3963','43086541-d81b-47f3-be17-d6cf14eeec0c','f35e714f-0940-47ed-a4d6-bf230433dfbc','59449d7a-c52c-484f-b6fa-157748b548d5','c67e970d-bff7-4727-b215-fdb3eb539d30']
idSql=','.join("'"+x+"'" for x in ids)
q="SELECT json_build_object('at',clock_timestamp(),'originalFive',(SELECT json_agg(x) FROM (SELECT s.id source_id,count(c.id) valid_chapters FROM novel_source_item s JOIN novel_chapter c ON c.novel_id=s.novel_id JOIN novel_chapter_content cc ON cc.novel_chapter_id=c.id WHERE s.id IN ("+idSql+") AND c.deleted_at IS NULL AND c.status='preview' AND btrim(cc.body)<>'' GROUP BY s.id ORDER BY s.id) x),'plotPublishedArticles',(SELECT count(*) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='00de5521-d075-4472-87eb-cc5d1732f4d0' AND a.status='published' AND a.deleted_at IS NULL));"
raw=sql(q);data=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
assert len(data['originalFive'])==5 and all(x['valid_chapters']==3 for x in data['originalFive'])
assert data['plotPublishedArticles']==0
states={}
for service,name in NAMES.items():
 info=json.loads(run(['docker','inspect',name]).stdout)[0]
 states[service]={'id':info['Id'],'running':info['State']['Running'],'health':info['State'].get('Health',{}).get('Status')}
 assert states[service]['running']
 if service in ['web','worker','worker-light','scheduler']:assert states[service]['health']=='healthy'
print('C_FINAL_READBACK='+json.dumps({'at':stamp(),'sql':data,'containers':states,'envSha256':ENV_SHA,'final':FINAL}),flush=True)
from collections import Counter
counts={}
for service in ['worker','worker-light']:
 r=subprocess.run(['docker','logs','--since','2026-10-14T18:40:08.732307Z','--until','2026-10-14T18:40:27Z',NAMES[service]],stdin=subprocess.DEVNULL,text=True,capture_output=True)
 assert r.returncode==0
 c=Counter();failures=0
 for l in (r.stdout+'\n'+r.stderr).splitlines():
  try:x=json.loads(l)
  except ValueError:continue
  if x.get('event')=='upstream_call' and x.get('endpoint') in ['getbydataid','getchapterinfo','getcode','getlistpc']:
   c[(x['endpoint'],x.get('httpStatus'),x.get('outcome'))]+=1
  if x.get('event')=='preview_read_failure':failures+=1
 counts[service]={'observations':[{'endpoint':a,'httpStatus':b,'outcome':c0,'count':n} for (a,b,c0),n in c.items()],'previewFailureEvents':failures}
print('PREVIEW_TASK_WINDOW_LOG_COUNTS='+json.dumps(counts),flush=True)
print('C_FINAL_READONLY=PASS',flush=True)
