#!/usr/bin/env node
// X8 release-identity gate work order (2026-09-05), 施工项一 4.3(五), amended
// by the 2026-09-06 patch work order (Owner-frozen decision 1: reconciliation
// no longer maintains a hand-picked key whitelist).
//
// Two comparisons the gate command needs, kept here as pure functions (no
// filesystem, no docker) so they can be unit tested directly, plus a small
// CLI wrapper scripts/x8-production-like.sh shells out to.
//
// 1. diffRenderedConfigs -- the "rendered config gate" from the reference
//    CPS short-drama implementation (scripts/ops/flag-only-recreate.sh):
//    render the current ("baseline") and requested ("candidate") compose
//    configs and refuse if anything besides the explicitly authorized
//    environment keys would change. Unlike the reference, this also compares
//    everything OUTSIDE of `services` (top-level `name`, `networks`,
//    `secrets`, `volumes`, ...) -- the reference only ever diffs per-service
//    fields, so a top-level rename (e.g. a network name) would render
//    differently and never be reported (2026-09-06 patch, P1-5).
// 2. findActualDrift -- the leg the reference implementation does not have.
//    Its baseline is always a fresh re-render of the persisted config, never
//    a snapshot of what the containers actually have, so when persisted
//    config and running containers have already diverged (confirmed true in
//    this repo's local environment as of the original work order), the
//    rendered diff alone cannot see it. This compares the baseline render's
//    FULL declared environment for each service against the containers'
//    actual live environment -- not a curated handful of keys (that
//    hand-picked list is exactly what the 2026-09-06 patch work order found:
//    it covered 7 keys and missed everything else, including the promo
//    double-gate and the preview source allowlist). Any of the three
//    disagreement shapes -- value differs, baseline declares a key the
//    container lacks, or the container has a key baseline never declared --
//    is drift and fails closed, except for a short, explicit, documented
//    exemption list (see BASE_IMAGE_BAKED_KEYS below).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function withoutEnvironment(service) {
  const rest = { ...service };
  delete rest.environment;
  return rest;
}

function withoutServices(config) {
  const rest = { ...config };
  delete rest.services;
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
  // P1-5: everything that is not per-service (name, networks, secrets,
  // volumes, configs, ...) must also be byte-identical between the two
  // renders. Nothing in this whitelist is ever allowed to change via a
  // catalog-write gate flip, so there is no "allowed" set here -- any
  // difference at all is unauthorized.
  const baselineTop = withoutServices(baseline);
  const candidateTop = withoutServices(candidate);
  if (JSON.stringify(baselineTop) !== JSON.stringify(candidateTop)) {
    unauthorized.push({ service: "(top-level)", key: "(compose definition)", from: baselineTop, to: candidateTop });
  }
  return { unauthorized, changed };
}

// 2026-09-06 patch work order, 决策一: these are baked into the application
// image at build time (Dockerfile ENV / the node:alpine base image's own
// ENV), never declared in docker-compose.yml's `environment:` block for
// every service that has them baked in (worker never declares PORT/HOSTNAME,
// for instance, even though the shared final image stage sets both). They
// are therefore *structurally* absent from the baseline render for at least
// one of the two services the gate command touches, yet always present in
// that service's actual container environment -- an unavoidable, permanent
// asymmetry between "what compose declares" and "what the image bakes in",
// not a runtime injection that could silently vary between deployments. The
// image-digest check the gate command already performs (before this
// reconciliation ever runs) is what actually pins these: they can only ever
// change together with a new image, and a new image is already a hard
// failure by itself. Confirmed empirically against the real running
// cps-novel-x8-local-web-1 / -worker-1 containers during this patch
// (`docker inspect --format '{{json .Config.Env}}'`) -- this is the exact
// and complete set of image-baked keys that are not also compose-declared
// for at least one of web/worker; nothing else is exempted.
export const BASE_IMAGE_BAKED_KEYS = Object.freeze([
  "PATH",
  "NODE_VERSION",
  "YARN_VERSION",
  "NEXT_TELEMETRY_DISABLED",
  "PORT",
  "HOSTNAME",
]);

// 2026-09-06 patch (second round), group 4: findActualDrift() builds its
// per-service key set as the UNION of the baseline render's declared keys
// and the actual container's keys. That is correct for "did any declared
// key drift", but it has a blind spot the terminal auditor named directly:
// a key that is declared on NEITHER side (e.g. a future docker-compose.yml
// edit that accidentally drops FEATURE_NOVEL_CATALOG_SYNC from a service's
// `environment:` block entirely, so it disappears from both the rendered
// baseline and the container's real environment at once) is simply absent
// from that union and never enters the per-key loop at all -- a silent,
// vacuous pass for exactly the two variables this whole gate command exists
// to police. requiredKeys (the `options` parameter below) is what a caller
// uses to name keys that must be checked explicitly regardless of whether
// either side happens to declare them.
//
// 2026-09-06 patch (third round), wording fix: `requiredKeys` is a generic
// parameter of findActualDrift(), but as of this patch it has exactly one
// real caller (gate_catalog_recreate() in scripts/x8-production-like.sh),
// and that caller passes exactly CATALOG_GATE_ENV_KEYS -- these same two
// variables. This "declared on neither side" safety net does NOT extend to
// any other identity-relevant environment variable (the promo double-gate
// roles, ADMIN_TWO_FACTOR_ENFORCEMENT, WORKER_TASK_ALLOWLIST, the preview
// source-app allowlist, ...) unless and until a future caller adds them to
// its own requiredKeys list -- it is not a blanket "any required field
// missing from both sides is rejected" guarantee for the whole gate.
export const CATALOG_GATE_ENV_KEYS = Object.freeze(["FEATURE_NOVEL_CATALOG_SYNC", "NOVEL_CATALOG_SYNC_ALLOW_WRITE"]);

/**
 * Full per-service environment reconciliation between a baseline render
 * (persisted intent) and what the containers actually have. Fail-closed on
 * every shape of disagreement:
 *   - a key both sides declare but with different values,
 *   - a key the baseline render declares that the actual container lacks,
 *   - a key present in the actual container that the baseline render never
 *     declared for that service (unless explicitly exempted, see above).
 * A service missing from either side entirely is also drift, not a
 * vacuous "nothing to check" pass.
 *
 * @param {Record<string, {environment?: Record<string, unknown>}>} baselineServices
 * @param {Record<string, Record<string, unknown>>} actualByService
 * @param {{ services: readonly string[], allowedExtraKeys?: readonly string[], requiredKeys?: readonly string[], imageBakedEnv?: Record<string, string> }} options
 */
export function findActualDrift(baselineServices, actualByService, options) {
  const { services, allowedExtraKeys = [], requiredKeys = [], imageBakedEnv = {} } = options ?? {};
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error("findActualDrift requires a non-empty `services` list to reconcile");
  }
  const allowedExtra = new Set(allowedExtraKeys);
  const drift = [];
  for (const service of services) {
    const serviceBaseline = baselineServices?.[service];
    if (!serviceBaseline || typeof serviceBaseline !== "object") {
      drift.push({ service, key: "(service)", expected: "<declared in baseline render>", actual: "<missing from baseline render>" });
      continue;
    }
    const actual = actualByService?.[service];
    if (!actual || typeof actual !== "object") {
      drift.push({ service, key: "(service)", expected: "<running container>", actual: "<no container / unreadable environment>" });
      continue;
    }
    const rendered = serviceBaseline.environment ?? {};
    const keys = new Set([...Object.keys(rendered), ...Object.keys(actual)]);
    // 2026-09-06 patch (second round), group 4: a required key absent from
    // BOTH the rendered baseline and the actual container never appears in
    // `keys` above, so the per-key loop below would never visit it -- this
    // is the explicit, fail-closed check for exactly that shape, checked
    // once per service before the loop so it can never be shadowed by a
    // "the key just happens to be declared somewhere" coincidence.
    for (const requiredKey of requiredKeys) {
      if (!keys.has(requiredKey)) {
        drift.push({
          service,
          key: requiredKey,
          expected: "<required key, but declared in neither the baseline render nor the actual container>",
          actual: "<absent from both>",
        });
      }
    }
    for (const key of keys) {
      const hasBaseline = Object.prototype.hasOwnProperty.call(rendered, key);
      const hasActual = Object.prototype.hasOwnProperty.call(actual, key);
      if (hasBaseline && hasActual) {
        if (String(rendered[key]) !== String(actual[key])) {
          drift.push({ service, key, expected: String(rendered[key]), actual: String(actual[key]) });
        }
        continue;
      }
      if (hasBaseline && !hasActual) {
        drift.push({ service, key, expected: String(rendered[key]), actual: "<missing from container>" });
        continue;
      }
      // !hasBaseline && hasActual
      if (allowedExtra.has(key)) {
        // Terminal review, release-identity gate second round, finding 一:
        // this used to be a bare `continue` -- ANY value was accepted for an
        // exempted key, on the theory that BASE_IMAGE_BAKED_KEYS values are
        // pinned by the image-digest check that already ran before this
        // function. That theory is false: overriding a container's env at
        // `docker run`/compose `environment:` time for a key that ALSO
        // happens to be baked into the image does not change `.Image`'s
        // digest at all, so the digest check cannot catch it. The exemption
        // is now honored only when the actual value is EXACTLY what the
        // identity-bound image itself bakes in by default (imageBakedEnv,
        // read once via `docker image inspect` on that same image) -- any
        // other value, including a key imageBakedEnv never reported at all
        // (e.g. it was resolved against the wrong image, or inspection
        // failed), is drift.
        const hasBakedDefault = Object.prototype.hasOwnProperty.call(imageBakedEnv, key);
        const bakedValue = hasBakedDefault ? String(imageBakedEnv[key]) : undefined;
        if (hasBakedDefault && bakedValue === String(actual[key])) continue;
        drift.push({
          service,
          key,
          expected: hasBakedDefault
            ? `<image-baked default: ${bakedValue}>`
            : "<not declared in baseline render, and not baked into the identity-bound image either>",
          actual: String(actual[key]),
        });
        continue;
      }
      drift.push({ service, key, expected: "<not declared in baseline render>", actual: String(actual[key]) });
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
    const [baselinePath, actualPath, specPath] = rest;
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const actualByService = JSON.parse(readFileSync(actualPath, "utf8"));
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    const drift = findActualDrift(baseline.services ?? {}, actualByService, spec);
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
