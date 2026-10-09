import pathlib, hashlib, shutil, os, datetime, difflib, tempfile, subprocess, json

p = pathlib.Path('/opt/cps-novel/shared/env/preprod.env')
old = p.read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(old) == '02678ac313af230e7084262f532dbc337e5e6d3aa1f9b6d497c6281b5e3bdea8'
keys = (b'APP_VERSION=', b'NEXT_PUBLIC_BUILD_VERSION=')
lines = old.splitlines(keepends=True)
for key, value in zip(keys, (b'APP_VERSION=0.5.13', b'NEXT_PUBLIC_BUILD_VERSION=v0.5.13')):
    found = [x for x in lines if x.startswith(key)]
    assert len(found) == 1 and found[0].rstrip(b'\r\n') == value
new_lines = [x.replace(b'0.5.13', b'0.5.14') if x.startswith(keys) else x for x in lines]
new = b''.join(new_lines)
normalize = lambda b: b''.join(x for x in b.splitlines(keepends=True) if not x.startswith(keys))
assert normalize(old) == normalize(new)
backup = p.with_name(p.name + '.bak-v0514-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
assert not backup.exists()
shutil.copy2(p, backup)
assert backup.read_bytes() == old
temporary = p.with_name(p.name + '.new-v0514')
with temporary.open('xb') as f:
    os.chmod(temporary, p.stat().st_mode & 0o777)
    f.write(new)
os.replace(temporary, p)
assert p.read_bytes() == new
with tempfile.TemporaryDirectory(prefix='v0514-cmp-', dir=p.parent) as folder:
    a, b = pathlib.Path(folder)/'before', pathlib.Path(folder)/'after'
    a.write_bytes(normalize(backup.read_bytes())); b.write_bytes(normalize(p.read_bytes()))
    subprocess.run(['cmp', str(a), str(b)], check=True)
before = [x.decode() for x in lines if x.startswith(keys)]
after = [x.decode() for x in new_lines if x.startswith(keys)]
print(''.join(difflib.unified_diff(before, after, fromfile=str(backup), tofile=str(p))), end='')
print(json.dumps({'envBackup':str(backup), 'beforeSha256':sha(old), 'afterSha256':sha(new), 'otherBytesCmp':'PASS', 'allowlists':'UNCHANGED'}))
print('ENV_TWO_LINES_ONLY=PASS')
