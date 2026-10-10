import subprocess,datetime,json
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
p='/var/lib/cps-novel/backups/logical/cps-novel-v0515-'+stamp+'.dump'
base=['docker','exec','cps-novel-backup-timer-1']
subprocess.run(base+['/bin/bash','/app/scripts/db/backup-logical.sh','--output',p],check=True)
subprocess.run(base+['pg_restore','--list',p],check=True)
subprocess.run(base+['cat',p+'.metadata',p+'.sha256'],check=True)
subprocess.run(base+['sh','-c','cd /var/lib/cps-novel/backups/logical && sha256sum -c '+p.split('/')[-1]+'.sha256'],check=True)
print('BACKUP_LIST_VERIFY=PASS')
