/** Process signal wrapper kept dependency-free so it can be exercised by a
 * real child-process SIGTERM test without booting a database client. */
export async function runWorkerProcess(input: {
  run(signal: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
}): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await input.run(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await input.disconnect();
  }
}
