import { appendFileSync, writeFileSync } from "node:fs";
import { runWorkerProcess } from "../../../../worker/runtime/process-lifecycle";

const [mode, eventFile, readyFile] = process.argv.slice(2);
if (!eventFile || !readyFile || (mode !== "drain" && mode !== "timeout")) process.exit(64);
const event = (name: string) => appendFileSync(eventFile, `${name}\n`);

const keepAlive = setInterval(() => undefined, 1_000);
await runWorkerProcess({
  run: async (signal) => {
    writeFileSync(readyFile, "ready\n");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      event("sigterm_observed");
      if (mode === "drain") {
        setTimeout(() => { event("handler_completed"); resolve(); }, 250);
      } else {
        setTimeout(() => { event("drain_timeout"); resolve(); }, 500);
      }
    }, { once: true }));
  },
  disconnect: async () => { event("prisma_disconnected"); },
});
clearInterval(keepAlive);
event("process_exit");
