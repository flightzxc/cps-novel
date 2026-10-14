import pathlib,json
p=pathlib.Path('/opt/cps-novel/shared/artifacts/staging/v060')
print('UPLOAD_FILES='+json.dumps([{'name':x.name,'bytes':x.stat().st_size} for x in p.iterdir() if x.is_file()]))
