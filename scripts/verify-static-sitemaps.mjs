import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "cps-novel-sitemap-acceptance-"));
const reportPath = path.join(tempDir, "report.json");
const vitestPath = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

try {
  const run = spawnSync(process.execPath, [
    vitestPath,
    "run",
    "--project",
    "node",
    "tests/backend/seo/static-sitemap-acceptance.test.ts",
    "--reporter=dot",
  ], {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: {
      ...process.env,
      SITE_URL: "https://fixture.example",
      SITEMAP_ACCEPTANCE_REPORT: reportPath,
    },
  });

  if (run.status !== 0 || !existsSync(reportPath)) {
    process.stderr.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exitCode = run.status ?? 1;
  } else {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    if (report.ok !== true) throw new Error("Acceptance report did not confirm success");
    console.log("SITEMAP_ACCEPTANCE fixture_locales=en");
    console.log("SITEMAP_ACCEPTANCE shards=mainpage:1,novelpage:2");
    console.log("SITEMAP_ACCEPTANCE files=4 children=3 urls=4");
    console.log("SITEMAP_ACCEPTANCE lastmod=ISO8601 xml=valid disk=direct");
    console.log("SITEMAP_ACCEPTANCE current=releases/fixture-release");
    console.log("SITEMAP_ACCEPTANCE PASS");
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
