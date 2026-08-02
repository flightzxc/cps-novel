import { PrismaClient } from "@prisma/client";
import { claimPendingItem } from "../../../../src/lib/tasks";

const prisma = new PrismaClient();
const lease = await claimPendingItem(prisma, {
  family: "generic",
  taskTypes: ["runtime.test"],
  workerId: process.env.P1_07_CHILD_WORKER_ID ?? "killed-worker",
  leaseMs: Number(process.env.P1_07_CHILD_LEASE_MS ?? "60000"),
});
if (!lease) throw new Error("Child worker did not claim an item");
process.stdout.write(`P1_07_CHILD_CLAIMED=${lease.itemId}\n`);
setInterval(() => undefined, 60_000);
