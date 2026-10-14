opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15')
approved=json.loads((opdir/'a4-approved-preview.json').read_text())
backup=json.loads((opdir/'backup.json').read_text())
baseline=json.loads((opdir/'rehome-baseline.json').read_text())
target=approved['targetChannelAppId']
assert target=='00de5521-d075-4472-87eb-cc5d1732f4d0'
events=[]
def emit(event,value):
 events.append({'event':event,'at':stamp(),'value':value})
 (opdir/'b-stage.timeline.json').write_text(json.dumps(events,ensure_ascii=False,indent=2)+'\n')
 print(event+'='+json.dumps(value,ensure_ascii=False),flush=True)
def cli(args):
 r=run(args);return json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{'):])[0]
def repreview():
 args=['docker','exec','-e','PLOTNOVEL_REHOME_OPERATOR=codex',NAMES['worker'],'tsx','scripts/rehome-plotnovel-source-items.ts','--request-id','plotnovel-rehome-20261015','--reason','v0.6.0 PlotNovel 存量改挂；备份 '+backup['backupId']]
 return args,cli(args)
idsBefore={n:json.loads(run(['docker','inspect',v]).stdout)[0]['Id'] for n,v in NAMES.items()}
wi=json.loads(run(['docker','inspect',NAMES['worker']]).stdout)[0]
wenv=dict(x.split('=',1) for x in wi['Config']['Env'])
flags={k:wenv.get(k)=='true' for k in ['FEATURE_PROMO_LINK_CLAIM','PROMO_LINK_CLAIM_ALLOW_WRITE']}
assert all(flags.values()), 'global claim gates not open; stop before rehome'
sha=run(['docker','exec',NAMES['backup-timer'],'sha256sum',backup['containerPath']]).stdout.split()[0]
assert sha==backup['sha256'] and backup['pgRestoreList']=='PASS', 'backup identity failed'
args,pre=repreview();emit('B1_RECHECK',pre)
assert pre['counts']==approved['counts'] and not pre['blocked'] and all(x['total']==0 for x in pre['blockers'].values()), 'A4 counts or blockers changed'
assert pre['targetStatus']=='registered_disabled' and pre['blockers']['publishedArticles']['total']==0
applied=cli(args+['--apply','--confirm','REHOME_PLOTNOVEL_SOURCE_ITEMS','--expected-source-items',str(pre['counts']['sourceItems']),'--expected-promo-links',str(pre['counts']['promoLinks'])])
emit('REHOME_APPLY',applied)
assert not applied['blocked'] and not applied['noop'] and applied['applied']['rehomedSourceItems']==3845 and applied['applied']['rehomedPromoLinks']==2641, 'rehome result mismatch'
_,noop=repreview();emit('REHOME_NOOP',noop)
assert noop['noop'] and noop['counts']['sourceItems']==0 and noop['counts']['sourceItemsAlreadyAtTarget']==3845 and not noop['blocked'], 'rehome noop readback mismatch'
sampleIds=[x['id'] for x in baseline['samples']]
assert all(re.fullmatch(r'[0-9a-f-]{36}',x) for x in sampleIds)
idSql=','.join("'"+x+"'" for x in sampleIds)
query="WITH s AS (SELECT id FROM novel_source_item WHERE channel_app_id='"+target+"'::uuid AND external_agency_id='1351'),p AS (SELECT p.id,p.idempotency_key FROM promo_link p JOIN s ON s.id=p.novel_source_item_id),i AS (SELECT i.id,i.status,i.channel_app_id FROM side_effect_intent i WHERE i.promo_link_id IN (SELECT id FROM p) OR (i.target_type='promo_link' AND i.target_id IN (SELECT idempotency_key FROM p))) SELECT json_build_object('ownership',(SELECT json_agg(x) FROM (SELECT sa.code AS theater,count(DISTINCT s.id) AS items,count(p.id) AS promo_links FROM novel_source_item s JOIN channel_app ca ON ca.id=s.channel_app_id JOIN source_app sa ON sa.id=ca.source_app_id LEFT JOIN promo_link p ON p.novel_source_item_id=s.id WHERE s.external_agency_id='1351' GROUP BY sa.code) x),'samples',(SELECT json_agg(x) FROM (SELECT id,md5(public_redirect_code) AS station_code_md5,status FROM promo_link WHERE id IN ("+idSql+") ORDER BY id) x),'intents',(SELECT json_agg(i ORDER BY id) FROM i));"
raw=sql(query);post=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
assert post['ownership']==[{'theater':'plotnovel','items':3845,'promo_links':2641}], 'agency ownership readback failed'
assert post['samples']==baseline['samples'], 'three station codes or states changed'
oldIntents={str(x['id']):x['status'] for x in baseline['intents']}
newIntents={str(x['id']):x['status'] for x in post['intents']}
assert oldIntents==newIntents and all(x['channel_app_id']==target for x in post['intents']), 'intent identity/status/ownership readback failed'
readback={'at':stamp(),'ownership':post['ownership'],'stationSamplesUnchanged':3,'sideEffectIntentsMatched':len(newIntents),'intentStatusDifferences':0,'wrongIntentOwners':0,'noop':True,'backupId':backup['backupId']}
(opdir/'b1-readback.json').write_text(json.dumps(readback,ensure_ascii=False,indent=2)+'\n')
emit('B1_READBACK',readback)
activate=['docker','exec','-e','PLOTNOVEL_THEATER_OPERATOR=codex',NAMES['worker'],'tsx','scripts/register-plotnovel-theater.ts','--request-id','plotnovel-activate-20261015','--reason','v0.6.0 PlotNovel 改挂读回通过后启用剧场','--set-app-status','active']
plan=cli(activate);emit('ACTIVATE_PREVIEW',plan)
assert plan['mode']=='dry-run' and not plan['wrote'] and not plan['create'] and plan['moboreaderConfigPatch'] is None and not plan['storeLinkChanges'] and plan['appStatusChange']=={'from':'registered_disabled','to':'active'}, 'activation preview mismatch'
activated=cli(activate+['--apply']);emit('THEATER_ACTIVE',activated)
assert activated['wrote'] and activated['appStatusChange']=={'from':'registered_disabled','to':'active'}, 'activation apply mismatch'
claim=['docker','exec','-e','CHANNEL_CAPABILITY_OPERATOR=codex',NAMES['worker'],'tsx','scripts/set-channel-capability-status.ts','--channel-app',target,'--capability','claimPromo','--to','enabled','--reason','plotnovel-claim-enable-20261015：改挂读回通过后启用领码','--evidence',str(opdir/'b1-readback.json')]
plan=cli(claim);emit('CLAIM_PREVIEW',plan)
assert plan['mode']=='dry-run' and plan['currentStatus']=='registered_disabled' and plan['proposedStatus']=='enabled', 'claim capability preview mismatch'
enabled=cli(claim+['--apply']);emit('CLAIM_ENABLED',enabled)
assert enabled['wrote'] and enabled['beforeStatus']=='registered_disabled' and enabled['afterStatus']=='enabled', 'claim capability apply mismatch'
checkArgs=['docker','exec',NAMES['worker'],'tsx','scripts/ops/effective-tag-projection.ts','check']
initial=run(checkArgs,allowed=(0,3));m=re.search(r'EFFECTIVE_TAG_CHECK missing=(\d+) extra=(\d+) changed=(\d+)',initial.stdout);assert m, 'initial projection output missing'
emit('PROJECTION_BEFORE',{'exit':initial.returncode,'missing':int(m[1]),'extra':int(m[2]),'changed':int(m[3])})
reconciled=run(['docker','exec',NAMES['worker'],'tsx','scripts/ops/effective-tag-projection.ts','reconcile','--apply','--confirm','RECONCILE-EFFECTIVE-TAGS']);emit('PROJECTION_RECONCILE',{'exit':0,'output':reconciled.stdout.strip()})
finalCheck=run(checkArgs);assert 'EFFECTIVE_TAG_CHECK missing=0 extra=0 changed=0' in finalCheck.stdout
emit('PROJECTION_AFTER',{'missing':0,'extra':0,'changed':0})
raw=sql("SELECT json_build_object('apps',(SELECT json_agg(json_build_object('theater',sa.code,'id',ca.id,'status',ca.status,'promoMode',ca.config->>'promoMode','agencyIds',ca.config->'agencyIds') ORDER BY sa.code) FROM channel_app ca JOIN source_app sa ON sa.id=ca.source_app_id WHERE sa.code IN ('plotnovel','moboreader')),'capabilities',(SELECT json_object_agg(cc.capability_key,cc.status) FROM channel_capability cc WHERE cc.channel_app_id='"+target+"'::uuid),'promoStatuses',(SELECT json_object_agg(status,n) FROM (SELECT status,count(*) AS n FROM promo_link WHERE channel_app_id='"+target+"'::uuid GROUP BY status) x),'manualReviewRequired',(SELECT count(*) FROM side_effect_intent WHERE channel_app_id='"+target+"'::uuid AND status='manual_review_required'),'plotnovelPublishedArticles',(SELECT count(*) FROM article a JOIN promo_link p ON p.id=a.promo_link_id WHERE p.channel_app_id='"+target+"'::uuid AND a.status='published' AND a.deleted_at IS NULL));")
finalData=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
plot=next(a for a in finalData['apps'] if a['theater']=='plotnovel');mobo=next(a for a in finalData['apps'] if a['theater']=='moboreader')
assert plot['status']=='active' and plot['promoMode']=='code' and plot['agencyIds']==['1351'] and mobo['status']=='active' and mobo['promoMode']=='link' and mobo['agencyIds']==['3366']
assert finalData['capabilities']=={'getlistpc':'registered_disabled','getbydataid':'registered_disabled','getchapterinfo':'registered_disabled','claimPromo':'enabled'}
assert finalData['plotnovelPublishedArticles']==0 and finalData['promoStatuses']=={'fetched':2032,'pending':609}
idsAfter={n:json.loads(run(['docker','inspect',v]).stdout)[0]['Id'] for n,v in NAMES.items()};assert idsAfter==idsBefore, 'container identity changed'
assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV_SHA
result={'status':'B1_B2_PASS_STOP_B3_AWAIT_OWNER_CANARY','completedAt':stamp(),'backup':backup,'rehomeApplied':applied['applied'],'readback':readback,'activation':activated,'claimEnable':enabled,'finalData':finalData,'projection':[0,0,0],'globalClaimGatesOpen':flags,'containersUnchanged':True,'envSha256':ENV_SHA,'previewWhitelistChanged':False,'claimCanarySubmitted':False,'publishedCanarySubmitted':False}
(opdir/'b-stage-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');emit('B1_B2_RESULT',result);print('PHASE_B1_B2=PASS',flush=True)
