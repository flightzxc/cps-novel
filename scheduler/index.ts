import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { HANDLERS, runSchedulerOnce, type ScheduleDefinition } from "../src/lib/tasks";

/** P1-07 provides the scheduler runtime but no production business schedules. */
export const SCHEDULES: readonly ScheduleDefinition[] = Object.freeze([]);

export async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await runSchedulerOnce(prisma, HANDLERS, SCHEDULES);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
