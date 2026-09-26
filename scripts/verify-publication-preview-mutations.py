#!/usr/bin/env python3
"""Run bounded WO1 mutations, always restore source bytes. Requires local Docker
for the selected real-role tests; never points at an existing database."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.tmp/wo1/mutations'
OUT.mkdir(parents=True, exist_ok=True)
UNIT = ['npm', 'exec', 'vitest', 'run', '--', '--project', 'node', 'tests/backend/publication/preview-enqueue.test.ts', 'tests/backend/tasks/preview-account-hold.test.ts']
PG = ['bash', 'scripts/run-publication-preview-postgres-verification.sh']
mutations = [
    ('account-group-lost', 'src/server/publication/preview-enqueue.ts', '`${promo.channelAccountId}:${promo.channelAppId}`', '`${promo.channelAppId}`', UNIT, None),
    ('enqueue-error-escapes', 'src/server/publication/preview-enqueue.ts', '      skip("enqueue_failed");', '      throw error;', UNIT, None),
    ('account-hold-ignored', 'src/lib/tasks/moboreader.ts', 'enabled && writeAllowed && !activeHold', 'enabled && writeAllowed', UNIT, None),
    ('overlap-lock-removed', 'src/lib/tasks/moboreader.ts', """await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('preview:' || ${input.mode} || ':' || id, 0))
      FROM (SELECT unnest(${chunk}::text[]) AS id ORDER BY id) AS books`;""", 'await db.$executeRaw`SELECT 1`;', PG, 'concurrent overlapping'),
    ('overlap-dedupe-removed', 'src/lib/tasks/moboreader.ts', 'if (busyNovels.has(source.novelId))', 'if (false)', PG, 'concurrent overlapping'),
    ('batch-aggregation-removed', 'src/server/publish-gate/service.ts', '}, previewArticleIds);', '});', PG, 'batch aggregates'),
    ('partial-retry-token-collides', 'src/server/publication/preview-enqueue.ts', 'JSON.stringify([input.requestId, key, [...group.ids].sort()])', 'JSON.stringify([input.requestId, key])', PG, 'unexpected middle'),
    ('public-qualification-removed', 'src/server/publication/preview-enqueue.ts', 'buildPublicArticleWhere({ id: { in: ids }, articleType: "novel_article", locale: { in: [...SITE_LOCALES] } }, env)', '{ id: { in: ids } }', PG, 'blog, hidden'),
    ('novel-materialization-preview-restored', 'worker/handlers/novel-materialize.ts', 'if (result.outcome === "created") return { status: "success", result };', '''if (result.outcome === "created") {
        const { enqueueMoboreaderPreviewRefreshTask } = await import("../../src/lib/tasks/moboreader");
        const a = await tx.channelAccount.findFirstOrThrow({ select: { id: true } });
        await enqueueMoboreaderPreviewRefreshTask(tx, { trigger: "auto", channelAccountId: a.id, channelAppId: payload.channelAppId, novelSourceItemIds: [payload.novelSourceItemId], requestToken: lease.itemId, requestId: payload.requestId, actorId: payload.actorId });
        return { status: "success", result };
      }''', PG, 'single and batch materialization'),
]
for name, filename, old, new, command, pattern in mutations:
    file = ROOT / filename
    original = file.read_bytes()
    source = original.decode()
    assert old in source, (name, 'mutation anchor missing')
    try:
        file.write_text(source.replace(old, new, 1))
        env = dict(os.environ)
        if pattern:
            env['PUBLICATION_PREVIEW_TEST_PATTERN'] = pattern
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (OUT / f'{name}.log').write_bytes(result.stdout)
        output = result.stdout.decode(errors='replace')
        assert result.returncode != 0 and 'FAIL ' in output, (name, 'mutation survived or infrastructure failed')
        print(f'MUTATION_KILLED={name}', flush=True)
    finally:
        file.write_bytes(original)
        assert file.read_bytes() == original
print('WO1_MUTATIONS=PASS count=9 restored=byte-identical')
