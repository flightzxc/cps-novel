# Preproduction deployment layer

Source of truth for the single-instance Host-Nginx deployment described in
`docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md`.

- `docker-compose.yml`: stable production services/data identity; no edge
  proxy container and no PostgreSQL host port.
- `nginx/`: Ubuntu nginx 1.24 source templates/snippets.
- `backup-loop.sh`: daily logical, weekly verified physical, continuous-WAL
  retention wiring.
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
