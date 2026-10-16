import subprocess,hashlib,json,pathlib
web='cps-novel-web-1';p='/tmp/plotnovel-b47-20261016-manifest.json';sha='ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639'
assert pathlib.Path('/opt/cps-novel/current').resolve().name=='cb255e0f1c93041eda6aefeefbb541d7eddfc15f'
assert subprocess.check_output(['docker','exec','-u','0',web,'sha256sum',p],text=True).split()[0]==sha
subprocess.run(['docker','exec','-u','0',web,'chown','1001:1001',p],check=True)
assert subprocess.check_output(['docker','exec',web,'sha256sum',p],text=True).split()[0]==sha
print(subprocess.check_output(['docker','exec',web,'stat','-c','%a %u %g %n',p],text=True));print('TEMP_MANIFEST_OWNERSHIP_RESTORED=PASS bytes_unchanged=true')
