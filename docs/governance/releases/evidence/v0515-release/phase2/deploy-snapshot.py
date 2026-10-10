import pathlib,json
base=pathlib.Path('/opt/cps-novel/logs/release-v0.5.15-db62350')
for suffix in ['.log','.timeline.json','.exit.json','.wrapper.log']:
 p=pathlib.Path(str(base)+suffix)
 if p.exists():
  print('FILE='+str(p));print(p.read_text() if suffix!='.log' else p.read_text()[-9000:])
