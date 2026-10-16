import pathlib,json,hashlib
r=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-b47-republish-2026-10-16');x=json.loads((r/'phase3a-result.json').read_text());assert x['status']=='PASS';print(json.dumps({'result':x,'manifest':json.loads((r/'manifest.json').read_text()),'manifestSha256':hashlib.sha256((r/'manifest.json').read_bytes()).hexdigest()}))
