import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAllowedFlags,
  assertDatabaseUrlFingerprint,
  assertTmpOutputPath,
  redactSensitive,
} from "../lib/acceptance-safety";

type Args = { output: string; databaseUrlSha256: string };

function readArg(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find((token) => token.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  assertAllowedFlags(argv, ["output", "database-url-sha256", "help"]);
  const output = readArg(argv, "output");
  const databaseUrlSha256 = readArg(argv, "database-url-sha256");
  if (!output) throw new Error("--output <absolute /tmp path> is required");
  if (!databaseUrlSha256) throw new Error("--database-url-sha256 <sha256> is required");
  return { output: assertTmpOutputPath(output), databaseUrlSha256 };
}

function help(): string {
  return [
    "P2-12 acceptance CLI (read-only test runner)",
    "",
    "Required:",
    "  --output /tmp/p2-12-acceptance.json",
    "  --database-url-sha256 <sha256 of the exported DATABASE_URL>",
    "",
    "The raw DATABASE_URL is never accepted as an argument or written to the report.",
  ].join("\n");
}

export function runAcceptance(argv = process.argv.slice(2)): number {
  if (argv.includes("--help")) {
    console.log(help());
    return 0;
  }
  const args = parseArgs(argv);
  assertDatabaseUrlFingerprint(args.databaseUrlSha256);

  const vitestBin = path.resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
  const startedAt = new Date();
  const child = spawnSync(process.execPath, [
    vitestBin,
    "run",
    "--project",
    "node",
    "tests/integration/p2-12-vertical-acceptance.test.ts",
  ], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  const report = redactSensitive({
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    mode: "read_only_acceptance",
    status: child.status === 0 ? "pass" : "fail",
    command: "vitest run --project node tests/integration/p2-12-vertical-acceptance.test.ts",
    exitCode: child.status,
    signal: child.signal,
    stdout: child.stdout,
    stderr: child.stderr,
  });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ status: child.status === 0 ? "pass" : "fail", reportFile: args.output }));
  return child.status ?? 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    process.exitCode = runAcceptance();
  } catch (error) {
    console.error(`[p2-12-acceptance] ${String(redactSensitive(error instanceof Error ? error.message : String(error)))}`);
    process.exitCode = 1;
  }
}
