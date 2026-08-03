export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
export const MAX_SHUTDOWN_DRAIN_TIMEOUT_MS = 600_000;

export class ShutdownDrainTimeoutConfigError extends Error {
  readonly code = "WORKER_SHUTDOWN_DRAIN_TIMEOUT_INVALID";

  constructor() {
    super(
      `shutdown drain timeout must be a finite safe integer between 1 and ${MAX_SHUTDOWN_DRAIN_TIMEOUT_MS} milliseconds`,
    );
    this.name = "ShutdownDrainTimeoutConfigError";
  }
}

export function validateShutdownDrainTimeoutMs(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_SHUTDOWN_DRAIN_TIMEOUT_MS
  ) {
    throw new ShutdownDrainTimeoutConfigError();
  }
  return value;
}

export function parseShutdownDrainTimeoutEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new ShutdownDrainTimeoutConfigError();
  return validateShutdownDrainTimeoutMs(Number(value));
}
