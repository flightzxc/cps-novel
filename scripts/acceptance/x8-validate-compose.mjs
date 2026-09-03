import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`X8 compose isolation violation: ${message}`);
}

// RC-2b: single source of truth for the per-X8_LEVEL WORKER_TASK_ALLOWLIST /
// double-gate values is scripts/lib/x8-levels.json — scripts/lib/
// x8-production-like-env.sh reads the same file (via `node -e`) so the two
// can never assert different strings for the same level.
const levelsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "x8-levels.json");
let levelTable;
try {
  levelTable = JSON.parse(fs.readFileSync(levelsPath, "utf8"));
} catch (error) {
  fail(`unable to read X8 level table at ${levelsPath}: ${error.message}`);
}
const allowedLevels = Object.keys(levelTable).filter((key) => key !== "_comment");
const level = process.env.X8_LEVEL ?? "0";
if (!allowedLevels.includes(level)) {
  fail(`unknown X8_LEVEL "${level}" (allowed: ${allowedLevels.join(", ")})`);
}
const levelEntry = levelTable[level];

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const services = config.services ?? {};
const serviceNames = Object.keys(services).sort();
const expectedServices = ["backup-timer", "nginx", "postgres", "scheduler", "web", "worker"];
if (JSON.stringify(serviceNames) !== JSON.stringify(expectedServices)) {
  fail(`resident services are ${serviceNames.join(",")}`);
}

const web = services.web;
const postgres = services.postgres;
const nginx = services.nginx;
const worker = services.worker;
if ((web.ports ?? []).length !== 0) fail("web publishes a host port");
if ((postgres.ports ?? []).length !== 0) fail("postgres publishes a host port");
if ((nginx.ports ?? []).length !== 2) fail("nginx must publish exactly HTTP and HTTPS");
for (const port of nginx.ports) {
  if (port.host_ip !== "127.0.0.1") fail(`nginx port ${port.published} is not loopback-bound`);
}
if (web.environment?.SITE_URL !== "https://novel.test") fail("web SITE_URL is not the X8 origin");
// RC-9 admin-host isolation (2026-09-03, Owner): the admin backend is a
// distinct domain from the public site, matching the default
// X8_ADMIN_DOMAIN=zbcwf.novel.test exported by
// scripts/lib/x8-production-like-env.sh. This is hard-coded (not read back
// from process.env.ADMIN_CANONICAL_ORIGIN) on purpose -- the point of this
// validator is to catch drift in the rendered compose config independently
// of whatever the exporting script currently believes, not to compare the
// env to itself.
if (web.environment?.ADMIN_CANONICAL_ORIGIN !== "https://zbcwf.novel.test") {
  fail("ADMIN_CANONICAL_ORIGIN is not the X8 admin origin");
}
if (web.environment?.ADMIN_CANONICAL_ORIGIN === web.environment?.SITE_URL) {
  fail("ADMIN_CANONICAL_ORIGIN must not equal SITE_URL (RC-9 admin-host isolation)");
}
if (worker.environment?.SITE_URL !== "https://novel.test") fail("worker SITE_URL is not the X8 origin");
if (worker.environment?.WORKER_TASK_ALLOWLIST !== levelEntry.workerTaskAllowlist) {
  fail(
    `worker allowlist is not the frozen X8_LEVEL=${level} set (expected "${levelEntry.workerTaskAllowlist}", got "${worker.environment?.WORKER_TASK_ALLOWLIST}")`,
  );
}
// RC-2 review fixup: the promo:claim capability grant is what actually lets the
// /catalog-sync claim dialog run in apply mode. It is not a double-gate flag, so
// it gets its own assertion — Level 0 must render it empty (granted to nobody).
if ((web.environment?.PROMO_CLAIM_ROLES ?? "") !== levelEntry.promoClaimRoles) {
  fail(
    `PROMO_CLAIM_ROLES must be "${levelEntry.promoClaimRoles}" in web for X8_LEVEL=${level} (got "${web.environment?.PROMO_CLAIM_ROLES ?? ""}")`,
  );
}
for (const service of [worker, services.scheduler]) {
  if (service.environment?.PROMO_CLAIM_ROLES !== undefined) {
    fail("PROMO_CLAIM_ROLES is an admin-UI capability and must not reach worker/scheduler");
  }
}
// RC-10: the global 2FA enforcement switch (src/lib/auth/
// two-factor-enforcement.ts) is admin-UI/session-only, same category as
// PROMO_CLAIM_ROLES above -- asserted on web, forbidden on worker/scheduler.
if ((web.environment?.ADMIN_TWO_FACTOR_ENFORCEMENT ?? "") !== levelEntry.adminTwoFactorEnforcement) {
  fail(
    `ADMIN_TWO_FACTOR_ENFORCEMENT must be "${levelEntry.adminTwoFactorEnforcement}" in web for X8_LEVEL=${level} (got "${web.environment?.ADMIN_TWO_FACTOR_ENFORCEMENT ?? ""}")`,
  );
}
for (const service of [worker, services.scheduler]) {
  if (service.environment?.ADMIN_TWO_FACTOR_ENFORCEMENT !== undefined) {
    fail("ADMIN_TWO_FACTOR_ENFORCEMENT is an admin-UI/session switch and must not reach worker/scheduler");
  }
}
for (const service of [web, worker, services.scheduler]) {
  if (service.network_mode === "host") fail("host networking is forbidden");
}
const webNetworks = Object.keys(web.networks ?? {}).sort();
if (JSON.stringify(webNetworks) !== JSON.stringify(["edge", "runtime"])) fail("web is not the edge/runtime bridge");
if (Object.keys(nginx.networks ?? {}).join(",") !== "edge") fail("nginx has runtime network access");
if (Object.keys(postgres.networks ?? {}).join(",") !== "runtime") fail("postgres is not runtime-only");
if (config.networks?.edge?.name !== "cps_novel_x8_edge") fail("edge network name drift");
if (config.networks?.runtime?.name !== "cps_novel_x8_runtime") fail("runtime network name drift");
for (const [key, name] of Object.entries({
  postgres_data: "cps_novel_x8_postgres_data",
  sitemap_static: "cps_novel_x8_sitemap_static",
  wal_archive: "cps_novel_x8_wal_archive",
})) {
  if (config.volumes?.[key]?.name !== name) fail(`${key} volume name drift`);
}
// RC-2b: the "must equal a value" set is unchanged; the expected value per
// flag now comes from levelEntry.flags instead of a hard-coded "false", so
// X8_LEVEL=uat/r can assert their own frozen true/false combination while
// X8_LEVEL=0 keeps asserting exactly what this file asserted before.
for (const flag of [
  "FEATURE_PROMO_LINK_CLAIM",
  "PROMO_LINK_CLAIM_ALLOW_WRITE",
  "FEATURE_SITEMAP_AUTO_REFRESH",
  "SITEMAP_AUTO_REFRESH_ALLOW_WRITE",
  "FEATURE_INDEXNOW_OUTBOX",
  "INDEXNOW_OUTBOX_ALLOW_WRITE",
]) {
  const expected = levelEntry.flags[flag];
  if (web.environment?.[flag] !== expected) {
    fail(`${flag} must be ${expected} in web for X8_LEVEL=${level} (got ${web.environment?.[flag]})`);
  }
}
for (const flag of [
  "FEATURE_PROMO_LINK_CLAIM",
  "PROMO_LINK_CLAIM_ALLOW_WRITE",
  "FEATURE_SITEMAP_AUTO_REFRESH",
  "SITEMAP_AUTO_REFRESH_ALLOW_WRITE",
  "FEATURE_INDEXNOW_DELIVERY",
  "INDEXNOW_DELIVERY_ALLOW_WRITE",
]) {
  const expected = levelEntry.flags[flag];
  if (worker.environment?.[flag] !== expected) {
    fail(`${flag} must be ${expected} in worker for X8_LEVEL=${level} (got ${worker.environment?.[flag]})`);
  }
}
console.log(`X8_COMPOSE_ISOLATION=PASS (X8_LEVEL=${level})`);
