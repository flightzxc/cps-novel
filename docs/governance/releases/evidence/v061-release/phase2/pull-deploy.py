import pathlib,json,re
base=pathlib.Path('/opt/cps-novel/logs/release-v0.6.1-cb255e0');e=json.loads(pathlib.Path(str(base)+'.exit.json').read_text());assert e['exit']==0,e
for suffix in ['.log','.timeline.json','.exit.json']:
 print('BEGIN_FILE='+suffix);print(re.sub(r'0x4[A-Za-z0-9_-]+','[REDACTED]',pathlib.Path(str(base)+suffix).read_text()));print('END_FILE='+suffix)
