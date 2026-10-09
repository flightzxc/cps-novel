import os, json, subprocess, datetime, pathlib

final = 'bf61b5ea276a0981870cdfa63578a822a65836f3'
root = pathlib.Path('/opt/cps-novel/releases') / final
manifest = pathlib.Path('/opt/cps-novel/shared/artifacts/staging/v0514') / (final + '.json')
log = pathlib.Path('/opt/cps-novel/logs/release-v0.5.14-bf61b5e.log')
timeline_path = log.with_suffix('.timeline.json')
exit_path = log.with_suffix('.exit.json')
stamp = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
with log.with_suffix('.started').open('x') as started:
    started.write(stamp() + '\n')
events = [{'event': 'DEPLOY_STARTED', 'at': stamp()}]
timeline_path.write_text(json.dumps(events, indent=2) + '\n')
env = dict(os.environ, APPROVED_GIT_COMMIT=final, PREPROD_APPROVED_MIGRATION='YES')
with log.open('x') as out:
    out.write('DEPLOY_STARTED_AT=' + events[0]['at'] + '\n')
    out.flush()
    proc = subprocess.Popen([str(root / 'scripts/preproduction/release.sh'), 'deploy', '--manifest', str(manifest)], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        out.write(line)
        out.flush()
        if line.strip() in ('MAINTENANCE=ON', 'MAINTENANCE=OFF', 'DATABASE_MIGRATION=PASS', 'RELEASE=PASS'):
            events.append({'event': line.strip(), 'at': stamp()})
            timeline_path.write_text(json.dumps(events, indent=2) + '\n')
    code = proc.wait()
    out.write('RELEASE_EXIT=' + str(code) + '\n')
events.append({'event': 'DEPLOY_FINISHED', 'at': stamp(), 'exit': code})
timeline_path.write_text(json.dumps(events, indent=2) + '\n')
exit_path.write_text(json.dumps(events[-1], indent=2) + '\n')
raise SystemExit(code)
