import pathlib,json,re
base=pathlib.Path('/opt/cps-novel/logs/release-v0.6.1-cb255e0')
exitfile=pathlib.Path(str(base)+'.exit.json')
print('FINISHED='+str(exitfile.exists()))
if exitfile.exists():print(exitfile.read_text())
print('TIMELINE='+pathlib.Path(str(base)+'.timeline.json').read_text())
print(re.sub(r'0x4[A-Za-z0-9_-]+','[REDACTED]','\n'.join(pathlib.Path(str(base)+'.log').read_text().splitlines()[-12:])))
