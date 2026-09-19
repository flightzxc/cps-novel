# Preproduction deployment layer

Source of truth for the single-instance Host-Nginx deployment described in
`docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md`.

- `docker-compose.yml`: stable production services/data identity; no edge
  proxy container and no PostgreSQL host port.
- `nginx/`: Ubuntu nginx 1.24 source templates/snippets.
- `backup-loop.sh`: daily logical, weekly verified physical, continuous-WAL
  retention wiring.
- `preprod.env.example`: non-secret fail-closed feature profile.

These files are not evidence of target installation. Phase 2B forbids running
them against the VPS.
