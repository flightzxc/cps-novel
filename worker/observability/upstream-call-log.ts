/**
 * Production sink for `src/lib/adapters/upstream-observation.ts`'s
 * `OnUpstreamObservation` callback. Phase 1 of the promo-link claim
 * latency investigation ("上游请求观测补齐") — this file only turns an
 * already-redacted `UpstreamCallObservation` into one structured JSON log
 * line, matching the `{ schemaVersion, event, ... }` shape already used
 * elsewhere in this runtime (`worker/index.ts`'s `worker_task_allowlist`,
 * `worker/runtime/worker.ts`'s `worker_finalize_failed`). It adds no
 * redaction of its own — the adapter has already dropped everything but
 * the allowlisted fields before this function ever sees the object — and
 * it never throws (a broken log sink must not fail the upstream call it is
 * reporting on).
 *
 * Wired at the two production adapter-construction sites:
 * `worker/handlers/moboreader.ts` (`createMoboreaderCatalogHandler`,
 * `createMoboreaderPreviewHandler`) and `worker/handlers/promo-link-claim.ts`
 * (`createPromoLinkClaimHandler`). Every other construction site (every
 * existing unit test) does not pass this, so nothing logs there.
 */
import type { UpstreamCallObservation } from "../../src/lib/adapters/upstream-observation";

export function logUpstreamCallObservation(observation: UpstreamCallObservation): void {
  try {
    console.log(JSON.stringify({
      schemaVersion: 1,
      event: "upstream_call",
      endpoint: observation.endpoint,
      httpStatus: observation.httpStatus,
      outcome: observation.outcome,
      latencyMs: observation.latencyMs,
      gateWaitMs: observation.gateWaitMs,
      // RC-4 (阶段 4-A per-endpoint rate gate): `null` when the gate in use
      // doesn't report a breakdown (legacy single-queue / no-op gate) —
      // see `UpstreamCallObservation`'s doc comments in
      // `src/lib/adapters/upstream-observation.ts`.
      endpointGateWaitMs: observation.endpointGateWaitMs,
      hostGateWaitMs: observation.hostGateWaitMs,
      remainingBeforeDispatch: observation.remainingBeforeDispatch,
      gatewayHeaders: observation.gatewayHeaders,
    }));
  } catch {
    // A logging failure (e.g. a circular/unserializable value that somehow
    // got past the adapter's allowlist) must never surface as an upstream
    // call failure. There is nothing else safe to do with it here.
  }
}
