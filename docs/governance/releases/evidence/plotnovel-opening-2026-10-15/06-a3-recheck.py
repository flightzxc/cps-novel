ARGS=['docker','exec','-e','PLOTNOVEL_REHOME_OPERATOR=codex',NAMES['worker'],'tsx','scripts/rehome-plotnovel-source-items.ts','--request-id','plotnovel-rehome-20261015','--reason','预演']
r=run(ARGS,allowed=(0,2));report=json.loads(r.stdout[r.stdout.index('{'):]);assert report['mode']=='dry-run' and report['applied'] is None
assert r.returncode==(2 if report['blocked'] else 0), 'preview exit does not match blockers'
print('REHOME_PREVIEW='+json.dumps(report,ensure_ascii=False));print('REHOME_PREVIEW_EXIT='+str(r.returncode));print('PHASE_A2_PREVIEW_CAPTURED=PASS')

assert report['targetStatus']=='registered_disabled' and not report['blocked'] and all(x['total']==0 for x in report['blockers'].values()), 'new blockers; stop before backup'
print('A3_RECHECK=PASS')
