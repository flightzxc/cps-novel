opdir=pathlib.Path('/opt/cps-novel/shared/operations/plotnovel-opening-2026-10-15');opdir.mkdir(parents=True,exist_ok=True);opdir.chmod(0o700)
backupId='plotnovel-pre-rehome-20261015-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');dump='/var/lib/cps-novel/backups/logical/'+backupId+'.dump'
TABLES=['novel_source_item','promo_link','side_effect_intent','source_label','novel_source_item_label','source_label_mapping']
# pg_dump reads PGPASSFILE inside the backup container; never emit credentials or dump bytes.
pre=run(['docker','exec',NAMES['backup-timer'],'bash','-c','test "$PGUSER" = backup_role && test -r "$PGPASSFILE" && test -z "${PGPASSWORD:-}"']);assert pre.returncode==0
assert run(['docker','exec',NAMES['backup-timer'],'bash','-c','test ! -e "$1"','bash',dump]).returncode==0
args=['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on',NAMES['backup-timer'],'bash','-c','umask 077; exec pg_dump "$@"','bash','--format=custom','--compress=gzip:6','--no-owner','--no-acl','--file='+dump]
for t in TABLES:args+=['--table=public.'+t]
print('SIX_TABLE_BACKUP_STARTED='+json.dumps({'at':stamp(),'backupId':backupId,'tables':TABLES}),flush=True);run(args)
listed=run(['docker','exec',NAMES['backup-timer'],'pg_restore','--list',dump]).stdout
for t in TABLES:assert any('TABLE DATA public '+t+' ' in line for line in listed.splitlines()), 'six-table restore list incomplete'
meta=run(['docker','exec',NAMES['backup-timer'],'bash','-c','sha256sum "$1"; stat -c "%s %a" "$1"','bash',dump]).stdout.splitlines();sha=meta[0].split()[0];size,mode=meta[1].split();assert len(sha)==64 and mode=='600'
backup={'backupId':backupId,'containerPath':dump,'hostPath':'/opt/cps-novel/shared/backups/logical/'+backupId+'.dump','createdAt':stamp(),'bytes':int(size),'sha256':sha,'mode':mode,'tables':TABLES,'pgRestoreList':'PASS','pgRestoreListSha256':hashlib.sha256(listed.encode()).hexdigest()}
(opdir/'backup.json').write_text(json.dumps(backup,indent=2)+'\n');(opdir/'backup.json').chmod(0o600)
print('PG_RESTORE_LIST_BEGIN');print(listed,end='');print('PG_RESTORE_LIST_END');print('SIX_TABLE_BACKUP='+json.dumps(backup));print('SIX_TABLE_BACKUP=PASS')
