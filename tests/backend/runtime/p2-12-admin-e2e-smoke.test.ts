import { describe, expect, it } from "vitest";

import { isLocalBaseUrl, parseSmokeArgs, pollTask } from "../../../scripts/admin-e2e-smoke";

describe("P2-12 admin E2E smoke harness", () => {
  it("refuses non-local targets and non-/tmp evidence paths", () => {
    expect(isLocalBaseUrl("http://localhost:3000")).toBe(true);
    expect(isLocalBaseUrl("https://127.0.0.1:3443")).toBe(true);
    expect(isLocalBaseUrl("https://production.example")).toBe(false);
    expect(() => parseSmokeArgs([
      "--base-url", "https://production.example",
      "--public-path", "/novel/example-pabc",
    ])).toThrow(/non-local/);
    expect(() => parseSmokeArgs([
      "--public-path", "/novel/example-pabc",
      "--report-file", `${process.cwd()}/report.json`,
    ])).toThrow(/\/tmp/);
  });

  it("accepts repeatable public paths/task ids and keeps evidence under /tmp", () => {
    const args = parseSmokeArgs([
      "--base-url=http://localhost:3000/",
      "--public-path=/novel/a-pa1",
      "--public-path", "/novel/b-pb2",
      "--task-id=task-1",
      "--report-file=/tmp/p2-12/report.json",
      "--evidence-dir=/tmp/p2-12/evidence",
      "--timeout-ms=3000",
    ]);
    expect(args).toMatchObject({
      baseUrl: "http://localhost:3000",
      publicPaths: ["/novel/a-pa1", "/novel/b-pb2"],
      taskIds: ["task-1"],
      reportFile: "/tmp/p2-12/report.json",
      evidenceDir: "/tmp/p2-12/evidence",
      timeoutMs: 3000,
    });
  });

  it("pollTask recognizes the repository's terminal task states", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      data: { taskId: "task-1", state: "completed", result: null, failureCode: null },
    }), { status: 200, headers: { "content-type": "application/json" } });

    await expect(pollTask(
      "http://localhost:3000",
      "task-1",
      1000,
      fetchImpl as typeof fetch,
    )).resolves.toEqual({ taskId: "task-1", state: "completed", ok: true });
  });
});
