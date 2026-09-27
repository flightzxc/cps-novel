# Preproduction deployment layer

Source of truth for the single-instance Host-Nginx deployment described in
`docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md`.

- `docker-compose.yml`: stable production services/data identity; no edge
  proxy container and no PostgreSQL host port.
- `nginx/`: Ubuntu nginx 1.24 source templates/snippets.
- `backup-loop.sh`: daily logical, weekly verified physical, continuous-WAL
  retention wiring. The `backup-timer` service's healthcheck only tells you
  the loop is stuck or failing while the container is *running* -- it has no
  way to see a stopped container at all (2026-09-22 incident: an ops step
  used backup-timer for a one-off backup, then stopped it, and nothing
  restarted it for 5 days). Don't start/stop this service for an ad-hoc
  backup; `exec` into the running container instead:
  `preprod_compose exec -T backup-timer /bin/bash /app/scripts/db/backup-logical.sh --output <file>`.
- `preprod.env.example`: non-secret feature profile. Most write gates are
  fail-closed; the three Owner-approved open ones (`catalog_write`,
  `promo_write`, `sitemap_write`) must be listed in `PREPROD_APPROVED_OPEN_WRITE_GATES`, or
  `scripts/preproduction/preflight.sh` refuses to pass. See
  `preprod_assert_write_gates()` in `scripts/preproduction/lib.sh` and
  `docs/adr/ADR-PREPROD-APPROVED-OPEN-WRITE-GATES.md`. Opening any other
  write gate requires extending that function's closed enum first, not just
  an env edit.

These files are not evidence of target installation. Phase 2B forbids running
them against the VPS.
