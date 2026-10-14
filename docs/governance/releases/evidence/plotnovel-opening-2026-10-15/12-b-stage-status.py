opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15')
exitPath=opdir/'b-stage.exit.json';exitData=None
if exitPath.exists():
 try:exitData=json.loads(exitPath.read_text())
 except ValueError:pass
print('B_STAGE_EXIT='+json.dumps(exitData))
for suffix in ['b-stage.log','b-stage.timeline.json','b-stage.wrapper.log']:
 p=opdir/suffix
 if p.exists():print('BEGIN_FILE='+suffix);print(p.read_text()[-18000:]);print('END_FILE='+suffix)
if exitData is not None:assert exitData['exit']==0, 'production B stage failed; stop, no automatic data fix'
