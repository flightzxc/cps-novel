import pathlib, hashlib, shutil, os, datetime, difflib, tempfile, subprocess, json

p = pathlib.Path('/opt/cps-novel/shared/env/preprod.env')
old = p.read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(old) == 'f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369'
keys = (b'APP_VERSION=', b'NEXT_PUBLIC_BUILD_VERSION=')
lines = old.splitlines(keepends=True)
for key, value in zip(keys, (b'APP_VERSION=0.6.0', b'NEXT_PUBLIC_BUILD_VERSION=v0.6.0')):
    found = [x for x in lines if x.startswith(key)]
    assert len(found) == 1 and found[0].rstrip(b'\r\n') == value
new_lines = [x.replace(b'0.6.0', b'0.6.1') if x.startswith(keys) else x for x in lines]
new = b''.join(new_lines)
normalize = lambda b: b''.join(x for x in b.splitlines(keepends=True) if not x.startswith(keys))
assert normalize(old) == normalize(new)
backup = p.with_name(p.name + '.bak-v061-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
assert not backup.exists()
shutil.copy2(p, backup)
assert backup.read_bytes() == old
temporary = p.with_name(p.name + '.new-v061')
with temporary.open('xb') as f:
    os.chmod(temporary, p.stat().st_mode & 0o777)
    f.write(new)
os.replace(temporary, p)
assert p.read_bytes() == new
with tempfile.TemporaryDirectory(prefix='v061-cmp-', dir=p.parent) as folder:
    a, b = pathlib.Path(folder)/'before', pathlib.Path(folder)/'after'
    a.write_bytes(normalize(backup.read_bytes())); b.write_bytes(normalize(p.read_bytes()))
    subprocess.run(['cmp', str(a), str(b)], check=True)
before = [x.decode() for x in lines if x.startswith(keys)]
after = [x.decode() for x in new_lines if x.startswith(keys)]
print(''.join(difflib.unified_diff(before, after, fromfile=str(backup), tofile=str(p))), end='')
print(json.dumps({'envBackup':str(backup), 'beforeSha256':sha(old), 'afterSha256':sha(new), 'otherBytesCmp':'PASS', 'allowlists':'UNCHANGED'}))
print('ENV_TWO_LINES_ONLY=PASS')
