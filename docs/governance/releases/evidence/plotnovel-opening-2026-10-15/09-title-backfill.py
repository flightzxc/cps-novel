for dry in [True,False]:
 args=['docker','exec',NAMES['worker'],'tsx','scripts/backfill-novel-title-normalized.ts','--max-rows','5000']+(['--dry-run'] if dry else [])
 report=json.loads(run(args).stdout);print('TITLE_BACKFILL='+json.dumps(report));assert report['dryRun']==dry
 if not dry:
  while report['hitMaxRows']:
   report=json.loads(run(args).stdout);print('TITLE_BACKFILL='+json.dumps(report))
raw=sql("SELECT count(*) FROM novel WHERE title_normalized IS NULL;");rows=[x for x in raw.splitlines() if x.isdigit()];assert rows==['0'], 'title normalization still has missing rows'
print('TITLE_NORMALIZED_NULL=0');print('TITLE_BACKFILL=PASS')
