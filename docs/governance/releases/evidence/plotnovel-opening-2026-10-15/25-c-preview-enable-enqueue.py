target='00de5521-d075-4472-87eb-cc5d1732f4d0'
sourceIds=['db8216e5-2349-4ebc-a513-7e408ecf2598', 'e55982ea-2543-43d5-8cad-811d28571c17', 'fdcee1ef-07c1-4a69-9ff4-0bd2badea63f', '73fabb91-e8bd-4e05-be05-67799b39a529', '0a379b8e-2ca5-4470-b4d3-61af4396539b', '00f76c41-041c-421c-bece-857e1ff48703', 'e702df26-1dab-41bf-8657-0fe5aad238dd', '038ac0b3-a45c-427d-9cc2-52ff5bce0af9', '5e1a5f5a-d553-44dd-a733-ccfe7243fa70', '8eba21c0-7718-43c1-8c85-2af10a99b83c']
opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15')
def snapshot():
 raw=sql("SELECT json_build_object('manualCount',count(*),'manualDigest',encode(sha256(convert_to(string_agg(id::text||status||response_shape::text,'|' ORDER BY id),'UTF8')),'hex'),'promoDigest',(SELECT encode(sha256(convert_to(string_agg(id::text||status||upstream_code_present::text||updated_at::text,'|' ORDER BY id),'UTF8')),'hex') FROM promo_link WHERE channel_app_id='"+target+"')) FROM side_effect_intent WHERE channel_app_id='"+target+"' AND status='manual_review_required';")
 return json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
baseline=snapshot();assert baseline['manualCount']==635
(opdir/'c-manual-promo-baseline.json').write_text(json.dumps(baseline)+'\n');print('C_PROTECTED_BASELINE='+json.dumps(baseline),flush=True)
def cli(args):
 r=run(args);return json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{'):])[0]
capResults=[]
for key in ['getbydataid','getchapterinfo']:
 args=['docker','exec','-e','CHANNEL_CAPABILITY_OPERATOR=codex',NAMES['worker'],'tsx','scripts/set-channel-capability-status.ts','--channel-app',target,'--capability',key,'--to','enabled','--reason','plotnovel-preview-'+key+'-enable-20261015：Owner授权试读金丝雀','--evidence',str(opdir/'c-runtime.json')]
 preview=cli(args);print('PREVIEW_CAPABILITY_DRY='+json.dumps(preview,ensure_ascii=False),flush=True)
 assert preview['currentStatus']=='registered_disabled' and preview['proposedStatus']=='enabled'
 applied=cli(args+['--apply']);assert applied['wrote'] and applied['afterStatus']=='enabled';capResults.append(applied);print('PREVIEW_CAPABILITY_APPLY='+json.dumps(applied),flush=True)
raw=sql("SELECT json_object_agg(capability_key,status) FROM channel_capability WHERE channel_app_id='"+target+"';")
caps=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0];assert caps=={'claimPromo':'registered_disabled','getlistpc':'registered_disabled','getbydataid':'enabled','getchapterinfo':'enabled'}
args=['docker','exec',NAMES['worker'],'tsx','scripts/preview-backfill-recovery.ts','--channel-app-id',target,'--request-id','plotnovel-preview-canary-20261015','--limit',str(len(sourceIds)),'--batch-size',str(len(sourceIds)),'--source-item-ids',','.join(sourceIds)]
def safe_report(x):
 return {k:x[k] for k in ['mode','preflight','channelAppId','requestId','limit','batchSize','onlySourceItemIds','candidateCount','truncated','batches']}|{'sampleCandidates':[{'novelSourceItemId':v['novelSourceItemId'],'novelId':v['novelId'],'lastPreviewItemStatus':v['lastPreviewItemStatus']} for v in x['sampleCandidates']],'failureBreakdownByHash':{hashlib.sha256(k.encode()).hexdigest():v for k,v in x['failureBreakdown'].items()}}
dry=cli(args);print('PREVIEW_CANARY_SURVEY='+json.dumps(safe_report(dry)),flush=True)
assert dry['mode']=='survey' and dry['preflight']['status']=='usable' and dry['candidateCount']==len(sourceIds) and not dry['truncated'] and not dry['batches']
with (opdir/'c-preview-canary.started').open('x') as f:f.write(stamp()+'\n')
applied=cli(args+['--apply','--confirm','APPLY_PREVIEW_BACKFILL']);safe=safe_report(applied);print('PREVIEW_CANARY_APPLY='+json.dumps(safe),flush=True)
assert applied['candidateCount']==len(sourceIds) and len(applied['batches'])==1
queued=applied['batches'][0]['enqueue'];assert queued['queued'] and queued['status']=='enqueued' and queued['taskStatus']=='pending' and queued['eligibleCount']==len(sourceIds) and not queued['skipReasonCounts']
x={'at':stamp(),'sourceIds':sourceIds,'taskId':queued['taskId'],'candidateCount':len(sourceIds),'capabilityApplies':capResults,'caps':caps,'survey':safe_report(dry),'apply':safe,'protectedBaseline':baseline}
(opdir/'c-preview-enqueued.json').write_text(json.dumps(x)+'\n');print('C_PREVIEW_ENQUEUED='+json.dumps(x),flush=True);print('C_PREVIEW_ENQUEUE=PASS',flush=True)
