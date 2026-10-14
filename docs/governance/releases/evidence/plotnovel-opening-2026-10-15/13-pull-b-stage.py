opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15');exitData=json.loads((opdir/'b-stage.exit.json').read_text());assert exitData['exit']==0
for name in ['b-stage.log','b-stage.timeline.json','b-stage-result.json','b1-readback.json','b-stage.exit.json']:
 print('BEGIN_FILE='+name);print((opdir/name).read_text(),end='');print('END_FILE='+name)
