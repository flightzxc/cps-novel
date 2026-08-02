import type {
  TaskHandlerRegistration,
  TaskHandlerRegistry,
  WorkerAllowlistConfig,
} from "./types";

export class UnregisteredTaskTypeError extends Error {
  readonly code = "UNREGISTERED_TASK_TYPE";

  constructor(readonly taskType: string) {
    super(`Task type is not registered: ${taskType}`);
    this.name = "UnregisteredTaskTypeError";
  }
}

export function createHandlerRegistry(
  registrations: Record<string, TaskHandlerRegistration>,
): TaskHandlerRegistry {
  for (const [taskType, registration] of Object.entries(registrations)) {
    if (!taskType.trim()) throw new Error("Task type must not be empty");
    if ((registration.maxAttempts ?? 3) < 1) {
      throw new Error(`maxAttempts must be positive for task type ${taskType}`);
    }
  }
  return Object.freeze({ ...registrations });
}

/** P1-07 intentionally registers no production business handlers. */
export const HANDLERS: TaskHandlerRegistry = createHandlerRegistry({});

export function requireHandler(
  registry: TaskHandlerRegistry,
  taskType: string,
): TaskHandlerRegistration {
  const registration = registry[taskType];
  if (!registration) throw new UnregisteredTaskTypeError(taskType);
  return registration;
}

export function buildWorkerAllowlist(
  raw: string | undefined,
  registry: TaskHandlerRegistry,
): WorkerAllowlistConfig {
  const requested = Array.from(
    new Set(
      (raw ?? "")
        .split(/[,\s]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  const effective = requested.filter((taskType) => taskType in registry);
  const invalid = requested.filter((taskType) => !(taskType in registry));
  return { requested, effective, invalid, willConsume: effective.length > 0 };
}
