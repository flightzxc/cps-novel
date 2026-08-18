import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAllowedFlags,
  assertTmpOutputPath,
  redactSensitive,
} from "./lib/acceptance-safety";

type SmokeStatus = "success" | "failed";

type SmokeArgs = {
  baseUrl: string;
  publicPaths: string[];
  taskIds: string[];
  reportFile: string;
  evidenceDir: string;
  timeoutMs: number;
};

export type AdminE2ESmokeReport = {
  generatedAt: string;
  driver: "fetch";
  status: SmokeStatus;
  baseUrl: string;
  taskChecks: Array<{ taskId: string; state: string; ok: boolean }>;
  publicChecks: Array<{ path: string; status: number | null; finalUrl: string | null; title: string | null; ok: boolean }>;
  evidenceFiles: string[];
  errors: string[];
  notes: string[];
};

function allArgValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === `--${name}`) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      values.push(value);
    } else if (token.startsWith(`--${name}=`)) {
      values.push(token.slice(name.length + 3));
    }
  }
  return values;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
}

export function isLocalBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

export function parseSmokeArgs(argv = process.argv.slice(2)): SmokeArgs {
  assertAllowedFlags(argv, [
    "base-url",
    "public-path",
    "task-id",
    "report-file",
    "evidence-dir",
    "timeout-ms",
    "help",
  ]);
  const baseUrl = (allArgValues(argv, "base-url")[0] ?? "http://localhost:3000").replace(/\/$/, "");
  if (!isLocalBaseUrl(baseUrl)) throw new Error("--base-url must be localhost/127.0.0.1; refusing non-local E2E");

  const publicPaths = allArgValues(argv, "public-path");
  if (publicPaths.length === 0) throw new Error("at least one --public-path is required");
  for (const publicPath of publicPaths) {
    if (!publicPath.startsWith("/") || publicPath.startsWith("//")) {
      throw new Error("--public-path must be a same-origin absolute path");
    }
  }

  return {
    baseUrl,
    publicPaths: [...new Set(publicPaths)],
    taskIds: [...new Set(allArgValues(argv, "task-id"))],
    reportFile: assertTmpOutputPath(allArgValues(argv, "report-file")[0] ?? `/tmp/p2-12-admin-e2e-${Date.now()}.json`),
    evidenceDir: assertTmpOutputPath(allArgValues(argv, "evidence-dir")[0] ?? `/tmp/p2-12-admin-e2e-${Date.now()}`),
    timeoutMs: positiveInt(allArgValues(argv, "timeout-ms")[0], 15 * 60 * 1000, "timeout-ms"),
  };
}

function taskState(body: unknown): string {
  if (!body || typeof body !== "object") return "unknown";
  const envelope = body as { state?: unknown; data?: { state?: unknown; status?: unknown }; status?: unknown };
  const value = envelope.data?.state ?? envelope.data?.status ?? envelope.state ?? envelope.status;
  return typeof value === "string" ? value : "unknown";
}

/** Adapted from CPS pollTask: same timeout/3s loop, novel task terminal states. */
export async function pollTask(
  baseUrl: string,
  taskId: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ taskId: string; state: string; ok: boolean }> {
  const terminal = new Set(["completed", "completed_with_errors", "failed", "disabled"]);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetchImpl(
      `${baseUrl}/api/admin/credential-tasks/status?taskId=${encodeURIComponent(taskId)}`,
      { credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs) },
    );
    const result = {
      ok: response.ok,
      status: response.status,
      body: await response.json().catch(() => null),
    };
    if (!result.ok) throw new Error(`task_status_http_${result.status}:${taskId}`);
    const state = taskState(result.body);
    if (terminal.has(state)) return { taskId, state, ok: state === "completed" };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`task_timeout:${taskId}`);
}

async function captureEvidence(dir: string, name: string, body: string, report: AdminE2ESmokeReport) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${Date.now()}-${name}.txt`);
  await fs.writeFile(target, body, { encoding: "utf8", mode: 0o600 });
  report.evidenceFiles.push(target);
}

export async function runAdminE2ESmoke(args: SmokeArgs): Promise<AdminE2ESmokeReport> {
  const report: AdminE2ESmokeReport = {
    generatedAt: new Date().toISOString(),
    driver: "fetch",
    status: "failed",
    baseUrl: args.baseUrl,
    taskChecks: [],
    publicChecks: [],
    evidenceFiles: [],
    errors: [],
    notes: [
      "Uses only existing HTTP routes; it imports neither Prisma nor internal write helpers.",
      "Current repository has no publish UI and no generic task-status route, so optional polling targets the existing credential-task status route only.",
      "Uses Node's built-in fetch so it does not change the repository's frozen no-browser-screenshot-dependency contract.",
    ],
  };

  try {
    for (const taskId of args.taskIds) report.taskChecks.push(await pollTask(args.baseUrl, taskId, args.timeoutMs));
    for (const publicPath of args.publicPaths) {
      const response = await fetch(`${args.baseUrl}${publicPath}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      const html = await response.text();
      const status = response.status;
      const finalUrl = response.url;
      const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1]?.trim() ?? null;
      const ok = status === 200;
      report.publicChecks.push({ path: publicPath, status, finalUrl, title, ok });
      if (!ok) {
        await captureEvidence(
          args.evidenceDir,
          "public-check-failed",
          String(redactSensitive(`path=${publicPath}\nstatus=${status}\nbody=${html.slice(0, 4000)}`)),
          report,
        ).catch(() => undefined);
      }
    }
    report.status = report.publicChecks.every((check) => check.ok)
      && report.taskChecks.every((check) => check.ok)
      ? "success"
      : "failed";
  } catch (error) {
    const message = String(redactSensitive(error instanceof Error ? error.message : String(error)));
    report.errors.push(message);
    await captureEvidence(args.evidenceDir, "failure", message, report).catch(() => undefined);
  }
  return report;
}

function help(): string {
  return [
    "P2-12 local HTTP E2E smoke",
    "",
    "Required:",
    "  --public-path /novel/<slug>-p<short-id>   repeatable",
    "",
    "Optional:",
    "  --base-url http://localhost:3000",
    "  --task-id <credential-task-id>             repeatable",
    "  --report-file /tmp/p2-12-smoke.json",
    "  --evidence-dir /tmp/p2-12-smoke-evidence",
    "  --timeout-ms 900000",
  ].join("\n");
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(help());
    return;
  }
  const args = parseSmokeArgs();
  const report = await runAdminE2ESmoke(args);
  await fs.mkdir(path.dirname(args.reportFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(args.reportFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportFile: args.reportFile }));
  if (report.status !== "success") process.exitCode = 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(`[admin-e2e-smoke] ${String(redactSensitive(error instanceof Error ? error.message : String(error)))}`);
    process.exit(1);
  });
}
