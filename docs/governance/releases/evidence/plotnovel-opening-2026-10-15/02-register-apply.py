ARGS=['docker', 'exec', '-e', 'PLOTNOVEL_THEATER_OPERATOR=codex', '__WORKER__', 'tsx', 'scripts/register-plotnovel-theater.ts', '--request-id', 'plotnovel-register-20261015', '--app-store-url', 'https://apps.apple.com/app/plotnovel/id6749878264', '--google-play-url', 'https://play.google.com/store/apps/details?id=com.plot.novel_app', '--reason', 'v0.6.0 登记 PlotNovel 剧场（Owner 10-15 提供商店链接）', '--apply']
ARGS[4]=NAMES['worker']
r=run(ARGS)
report=json.loads(r.stdout[r.stdout.index('{'):])
print('REGISTER_REPORT='+json.dumps(report,ensure_ascii=False))
assert report['mode']=='apply' and report['appStatusChange'] is None, 'registration shape mismatch'
assert report['wrote'] and len(report['auditIds'])>0, 'registration apply did not write expected changes'
print('REGISTER_APPLY=PASS')
