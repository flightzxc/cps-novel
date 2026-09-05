#!/usr/bin/env node
// X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五).
//
// Two comparisons the gate command needs, kept here as pure functions (no
// filesystem, no docker) so they can be unit tested directly, plus a small
// CLI wrapper scripts/x8-production-like.sh shells out to.
//
// 1. diffRenderedConfigs -- the "rendered config gate" from the reference
//    CPS short-drama implementation (scripts/ops/flag-only-recreate.sh):
//    render the current ("baseline") and requested ("candidate") compose
//    configs and refuse if anything besides the explicitly authorized
//    environment keys would change.
// 2. findActualDrift -- the leg the reference implementation does not have.
//    Its baseline is always a fresh re-render of the persisted config, never
//    a snapshot of what the containers actually have, so when persisted
//    config and running containers have already diverged (confirmed true in
//    this repo's local environment as of this work order), the rendered
//    diff alone cannot see it. This compares the baseline render against the
//    containers' actual live environment for a curated set of
//    identity-relevant keys, and reports every field that disagrees.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function withoutEnvironment(service) {
  const rest = { ...service };
  delete rest.environment;
  return rest;
}

/**
 * @param {{services?: Record<string, {environment?: Record<string, unknown>}>}} baseline
 * @param {{services?: Record<string, {environment?: Record<string, unknown>}>}} candidate
 * @param {readonly string[]} allowedKeys
 */
export function diffRenderedConfigs(baseline, candidate, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const serviceNames = new Set([
    ...Object.keys(baseline.services ?? {}),
    ...Object.keys(candidate.services ?? {}),
  ]);
  const unauthorized = [];
  const changed = [];
  for (const name of serviceNames) {
    const a = (baseline.services ?? {})[name] ?? {};
    const b = (candidate.services ?? {})[name] ?? {};
    const keys = new Set([...Object.keys(a.environment ?? {}), ...Object.keys(b.environment ?? {})]);
    for (const key of keys) {
      const from = (a.environment ?? {})[key];
      const to = (b.environment ?? {})[key];
      if (from === to) continue;
      const entry = { service: name, key, from, to };
      if (allowed.has(key)) changed.push(entry);
      else unauthorized.push(entry);
    }
    const aRest = withoutEnvironment(a);
    const bRest = withoutEnvironment(b);
    if (JSON.stringify(aRest) !== JSON.stringify(bRest)) {
      unauthorized.push({ service: name, key: "(service definition)", from: aRest, to: bRest });
    }
  }
  return { unauthorized, changed };
}

/**
 * @param {Record<string, {environment?: Record<string, unknown>}>} baselineServices
 * @param {Record<string, Record<string, unknown>>} actualByService
 * @param {Record<string, readonly string[]>} keysByService
 */
export function findActualDrift(baselineServices, actualByService, keysByService) {
  const drift = [];
  for (const [service, keys] of Object.entries(keysByService)) {
    const rendered = baselineServices?.[service]?.environment ?? {};
    const actual = actualByService?.[service] ?? {};
    for (const key of keys) {
      const expected = rendered[key];
      // Not every key applies to every service (e.g. WORKER_TASK_ALLOWLIST
      // is worker-only); skip keys the baseline render never set for it.
      if (expected === undefined) continue;
      const got = actual[key];
      if (String(expected) !== String(got ?? "")) {
        drift.push({ service, key, expected, actual: got ?? "" });
      }
    }
  }
  return drift;
}

export function formatEntry(entry) {
  return `${entry.service}.${entry.key}: ${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)}`;
}

export function formatDrift(entry) {
  return `${entry.service}.${entry.key}: baseline="${entry.expected}" actual="${entry.actual}"`;
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === "rendered") {
    const [baselinePath, candidatePath, allowedCsv] = rest;
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    const allowedKeys = (allowedCsv ?? "").split(",").filter(Boolean);
    const { unauthorized, changed } = diffRenderedConfigs(baseline, candidate, allowedKeys);
    if (unauthorized.length > 0) {
      process.stderr.write("UNAUTHORIZED_RENDER_DIFF:\n");
      for (const entry of unauthorized) process.stderr.write(`${formatEntry(entry)}\n`);
      process.exit(1);
    }
    process.stdout.write(changed.length > 0 ? `${changed.map(formatEntry).join("\n")}\n` : "(no rendered difference)\n");
    process.exit(0);
  } else if (mode === "actual") {
    const [baselinePath, actualPath, keysSpecPath] = rest;
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const actualByService = JSON.parse(readFileSync(actualPath, "utf8"));
    const keysByService = JSON.parse(readFileSync(keysSpecPath, "utf8"));
    const drift = findActualDrift(baseline.services ?? {}, actualByService, keysByService);
    if (drift.length > 0) {
      process.stderr.write("ACTUAL_CONTAINER_DRIFT:\n");
      for (const entry of drift) process.stderr.write(`${formatDrift(entry)}\n`);
      process.exit(1);
    }
    process.stdout.write("(no drift between the persisted state file and the running containers)\n");
    process.exit(0);
  } else {
    process.stderr.write(`ERROR: unknown x8-gate-diff mode "${mode ?? ""}" (expected "rendered" or "actual")\n`);
    process.exit(64);
  }
}

// Comparing raw file:// URL strings breaks whenever the path contains
// non-ASCII characters (as this repo's own path does: ".../cps海阅/...") --
// import.meta.url percent-encodes them, argv does not. fileURLToPath()
// undoes the encoding back to a real filesystem path before comparing, the
// same fix vitest.config.ts already documents for the identical class of
// bug in this repo.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2));
}
