# Runs only on haiyue-vps. Secret values and supplied response bodies stay in memory.
import html
q="""SELECT json_object_agg(a.id::text,p.upstream_code) FROM article a JOIN promo_link p ON p.id=a.promo_link_id JOIN generic_task_item i ON (i.result->>'articleId')::uuid=a.id WHERE i.task_id='48eba852-5fd8-479b-a74a-0b850ff6af71' AND i.status='success';"""
raw=sql(q);codes=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
assert len(codes)==50 and all(isinstance(c,str) and c.strip() for c in codes.values())
print(json.dumps({'ready':True,'protectedCodes':len(codes)}),flush=True)
for line in sys.stdin:
 try:
  obj=json.loads(line)
  if obj.get('kind')=='quit':break
  body=obj['body'];normalized=html.unescape(body)
  # Include Next/RSC JSON unicode escaping without recording any candidate values.
  normalized=re.sub(r'\\u([0-9a-fA-F]{4})',lambda m:chr(int(m[1],16)),normalized)
  counts={key:sum(code in row for row in normalized.splitlines()) for key,code in codes.items()}
  own=obj.get('articleId');inter=obj.get('kind')=='interstitial'
  result={'leakMatchingLines':sum(counts.values()) if not inter else sum(n for k,n in counts.items() if k!=own),'checkedCodes':len(codes)}
  if inter:result.update(codeCardMatches=obj.get('card')==codes.get(own),ownCodePresent=counts.get(own,0)>0)
  print(json.dumps(result),flush=True)
 except Exception:
  print(json.dumps({'error':'secret_check_failed'}),flush=True);raise SystemExit(1)
