/**
 * Production sink for the B-36 Preview-read failure report. One structured JSON
 * line per failed Preview upstream read, in the same `{ schemaVersion, event,
 * ... }` shape as `./upstream-call-log.ts` (`upstream_call`) and
 * `worker/runtime/worker.ts` (`worker_finalize_failed`), written to stderr like
 * the latter because it describes a failure.
 *
 * It adds no redaction of its own and needs none: the event is built by
 * `buildPreviewReadFailureLogEvent` (`./preview-read-failure.ts`),
 * which rebuilds every field through a closed-vocabulary / integer / identifier
 * gate and never reads the thrown error's message. Like the upstream-call sink,
 * it never throws — a broken log must not change the failed item's outcome.
 *
 * Wired as the default of `MoboreaderHandlerDependencies.onPreviewReadFailure`
 * in `worker/handlers/moboreader.ts`; tests inject their own collector.
 */
import type { PreviewReadFailureLogEvent } from "./preview-read-failure";

export function logPreviewReadFailure(event: PreviewReadFailureLogEvent): void {
  try {
    console.error(JSON.stringify({ schemaVersion: 1, event: "preview_read_failed", ...event }));
  } catch {
    // Nothing safe to do with an unserializable log line; the durable copy is
    // the `error.detail` persisted on the item.
  }
}
