import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireHandler } from "./registry";
import type { TaskHandlerRegistry } from "./types";

export interface ScheduledTaskItemInput {
  targetType: string;
  targetId: string;
  payload?: Prisma.InputJsonValue;
}

export interface ScheduledTaskInput {
  scheduleKey: string;
  scheduleRevision: number;
  scheduledFor: Date;
  timezone: string;
  misfirePolicy?: "bounded_catch_up" | "skip" | "mark_failed";
  maxCatchUpRuns?: number;
  taskType: string;
  mode?: "dry_run" | "apply";
  channelAccountId?: string;
  channelAppId?: string;
  params?: Prisma.InputJsonValue;
  items: ScheduledTaskItemInput[];
}

export interface ScheduleDefinition {
  scheduleKey: string;
  dueInstants(now: Date): Date[];
  build(scheduledFor: Date): ScheduledTaskInput;
}

export interface SchedulerEnqueueResult {
  status: "enqueued" | "duplicate";
  scheduleRunId?: string;
  cronRunId?: string;
  taskId?: string;
}

export interface SchedulerFaultHooks {
  afterTaskCreated?: () => Promise<void> | void;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function enqueueScheduledTask(
  prisma: PrismaClient,
  registry: TaskHandlerRegistry,
  input: ScheduledTaskInput,
  hooks: SchedulerFaultHooks = {},
): Promise<SchedulerEnqueueResult> {
  const registration = requireHandler(registry, input.taskType);
  if (registration.family !== "generic") {
    throw new Error(`Scheduled task type must use the generic family: ${input.taskType}`);
  }
  if (!input.scheduleKey.trim()) throw new Error("scheduleKey must not be empty");
  if (!input.timezone.trim()) throw new Error("timezone must not be empty");
  if (input.scheduleRevision < 1) throw new Error("scheduleRevision must be positive");
  if (input.items.length === 0) throw new Error("Scheduled task must contain at least one item");
  if (Number.isNaN(input.scheduledFor.valueOf())) throw new Error("scheduledFor must be valid");

  return prisma.$transaction(async (tx) => {
    const scheduleRunId = randomUUID();
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO schedule_run (
        id, schedule_key, schedule_revision, trigger_kind, scheduled_for,
        timezone, misfire_policy, max_catch_up_runs, status, updated_at
      ) VALUES (
        ${scheduleRunId}::uuid, ${input.scheduleKey}, ${input.scheduleRevision},
        'scheduled', ${input.scheduledFor}, ${input.timezone},
        ${input.misfirePolicy ?? "bounded_catch_up"}, ${input.maxCatchUpRuns ?? 1},
        'due', transaction_timestamp()
      )
      ON CONFLICT (schedule_key, scheduled_for) DO NOTHING
      RETURNING id
    `);
    if (inserted.length === 0) return { status: "duplicate" };

    const taskId = randomUUID();
    const identity = `${input.scheduleKey}\n${input.scheduleRevision}\n${input.scheduledFor.toISOString()}`;
    await tx.genericTask.create({
      data: {
        id: taskId,
        taskType: input.taskType,
        channelAccountId: input.channelAccountId,
        channelAppId: input.channelAppId,
        operationScopeHash: digest(identity),
        mode: input.mode ?? "apply",
        requestToken: `cron:${digest(identity)}`,
        totalCount: input.items.length,
        params: input.params ?? {},
        items: {
          create: input.items.map((item) => ({
            targetType: item.targetType,
            targetId: item.targetId,
            payload: item.payload ?? {},
          })),
        },
      },
    });
    await hooks.afterTaskCreated?.();

    const cronRun = await tx.cronRun.create({
      data: {
        scheduleRunId,
        genericTaskId: taskId,
        status: "task_created",
        claimedBy: "scheduler",
        claimedAt: new Date(),
        enqueuedAt: new Date(),
      },
    });
    await tx.scheduleRun.update({
      where: { id: scheduleRunId },
      data: { status: "enqueued" },
    });
    return { status: "enqueued", scheduleRunId, cronRunId: cronRun.id, taskId };
  });
}

export async function runSchedulerOnce(
  prisma: PrismaClient,
  registry: TaskHandlerRegistry,
  definitions: readonly ScheduleDefinition[],
  now = new Date(),
): Promise<SchedulerEnqueueResult[]> {
  const results: SchedulerEnqueueResult[] = [];
  for (const definition of definitions) {
    for (const scheduledFor of definition.dueInstants(now)) {
      const input = definition.build(scheduledFor);
      if (input.scheduleKey !== definition.scheduleKey) {
        throw new Error(`Schedule definition key mismatch: ${definition.scheduleKey}`);
      }
      results.push(await enqueueScheduledTask(prisma, registry, input));
    }
  }
  return results;
}
