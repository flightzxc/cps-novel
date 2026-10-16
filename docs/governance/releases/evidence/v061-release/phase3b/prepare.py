from pathlib import Path
r=Path.cwd();o=r/'.tmp/v061-release/phase3b';old=r/'docs/governance/releases/evidence/plotnovel-bulk-publish-2026-10-15/phase2/supervise.py.txt';s=old.read_text()
s=s.replace("shared/operations/plotnovel-bulk-publish-2026-10-15","shared/operations/plotnovel-b47-republish-2026-10-16").replace("OUT=ROOT/'phase2'","OUT=ROOT/'phase3b'")
for a,b in [('493eb23b034b0410780228535b3e293e4ee91f9a','cb255e0f1c93041eda6aefeefbb541d7eddfc15f'),('f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369','23425e8289854167d53d91f1f3673e383239458f0ae76fb4a5c695559e224509'),('95cae34466d3b672ff57fa8017c3cb0b7f0a64829c3ca99e665f9aa1d2ade1ec','ac7c225d28200fc6d1d56bf8046b9d324a7d7223666c9127e20566fea460e639'),('194438792336da3d054a2751c16737ef578906bc3de591eb43c3ccd3dd524660','0217ad5978a9f4d43c320fed963f479dd43d79d8099013bf74937185590f2129'),('/tmp/plotnovel-bulk-20261015-manifest.json','/tmp/plotnovel-b47-20261016-manifest.json'),("s['publishedCount']==50","s['publishedCount']==1977"),("(ROOT/'phase1-result.json').read_text())['protectedBefore']","(ROOT/'phase3a-result.json').read_text())['protectionBefore']"),('ab09d1beda4f0b26562ad7db1710d3c0855aec64','c3578aa6f8c18bc0ee39bcd14da95703aaad3098'),("'waveSizes':[500,500,500,485]","'waveSizes':[58]")]:s=s.replace(a,b)
s=s.replace("def protect():\n", "def protect():\n assert hashlib.sha256(pathlib.Path('/opt/cps-novel/shared/env/preprod.env').read_bytes()).hexdigest()==ENV\n")
(o/'supervise.py').write_text(s)
prefix=s.split('action=sys.argv[1];')[0]
init=prefix+"\nsys.argv=['supervise.py','init']\n"+s[s.index('action=sys.argv[1];'):]
(o/'init-remote.py').write_text(init)
for action in ['status','generate','publish','logs']:
 (o/(action+'-remote.py')).write_text(prefix+"\nsys.argv=['supervise.py',"+repr(action)+",'1']\n"+s[s.index('action=sys.argv[1];'):])
(o/'run.py').write_text((r/'.tmp/v061-release/phase2/run.py').read_text().replace('.tmp/v061-release/phase2','.tmp/v061-release/phase3b'))
print('PHASE3B_HELPERS_READY')
