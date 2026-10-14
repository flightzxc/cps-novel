target='00de5521-d075-4472-87eb-cc5d1732f4d0'
def state():
 raw=sql("SELECT json_build_object('apps',(SELECT json_agg(json_build_object('code',sa.code,'status',ca.status,'id',ca.id) ORDER BY sa.code) FROM channel_app ca JOIN source_app sa ON sa.id=ca.source_app_id WHERE sa.code IN ('plotnovel','moboreader')),'capabilities',(SELECT json_agg(json_build_object('appId',cc.channel_app_id,'key',cc.capability_key,'status',cc.status) ORDER BY cc.channel_app_id,cc.capability_key) FROM channel_capability cc JOIN channel_app ca ON ca.id=cc.channel_app_id JOIN source_app sa ON sa.id=ca.source_app_id WHERE sa.code IN ('plotnovel','moboreader')));")
 return json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
before=state();args=['docker','exec','-e','CHANNEL_CAPABILITY_OPERATOR=codex',NAMES['worker'],'tsx','scripts/set-channel-capability-status.ts','--channel-app',target,'--capability','claimPromo','--to','registered_disabled','--reason','排查领码人工复核期间暂停']
def cli(a):
 r=run(a);return json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{'):])[0]
preview=cli(args);print('DISABLE_PREVIEW='+json.dumps(preview,ensure_ascii=False),flush=True)
assert preview['mode']=='dry-run' and preview['currentStatus']=='enabled' and preview['proposedStatus']=='registered_disabled'
applied=cli(args+['--apply']);print('DISABLE_APPLY='+json.dumps(applied,ensure_ascii=False),flush=True)
assert applied['wrote'] and applied['beforeStatus']=='enabled' and applied['afterStatus']=='registered_disabled'
after=state();expected=json.loads(json.dumps(before))
for c in expected['capabilities']:
 if c['appId']==target and c['key']=='claimPromo':c['status']='registered_disabled'
assert after==expected, 'unexpected app/capability change'
assert next(a for a in after['apps'] if a['id']==target)['status']=='active'
print('DISABLE_READBACK='+json.dumps({'at':stamp(),'before':before,'after':after,'onlyPlotnovelClaimChanged':True,'auditId':applied['auditId']},ensure_ascii=False),flush=True)
print('PLOTNOVEL_CLAIM_DISABLED=PASS',flush=True)
