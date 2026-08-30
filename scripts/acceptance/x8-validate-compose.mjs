import process from "node:process";

function fail(message) {
  throw new Error(`X8 compose isolation violation: ${message}`);
}

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
if (web.environment?.ADMIN_CANONICAL_ORIGIN !== "https://novel.test") {
  fail("ADMIN_CANONICAL_ORIGIN is not the X8 origin");
}
if (worker.environment?.SITE_URL !== "https://novel.test") fail("worker SITE_URL is not the X8 origin");
if (worker.environment?.WORKER_TASK_ALLOWLIST !== "credential.validate.v1,credential.supersede.v1,catalog_scan") {
  fail("worker allowlist is not the frozen Level 0 set");
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
for (const flag of [
  "FEATURE_PROMO_LINK_CLAIM",
  "PROMO_LINK_CLAIM_ALLOW_WRITE",
  "FEATURE_SITEMAP_AUTO_REFRESH",
  "SITEMAP_AUTO_REFRESH_ALLOW_WRITE",
  "FEATURE_INDEXNOW_OUTBOX",
  "INDEXNOW_OUTBOX_ALLOW_WRITE",
]) {
  if (web.environment?.[flag] !== "false") fail(`${flag} must stay false in web`);
}
for (const flag of [
  "FEATURE_PROMO_LINK_CLAIM",
  "PROMO_LINK_CLAIM_ALLOW_WRITE",
  "FEATURE_SITEMAP_AUTO_REFRESH",
  "SITEMAP_AUTO_REFRESH_ALLOW_WRITE",
  "FEATURE_INDEXNOW_DELIVERY",
  "INDEXNOW_DELIVERY_ALLOW_WRITE",
]) {
  if (worker.environment?.[flag] !== "false") fail(`${flag} must stay false in worker`);
}
console.log("X8_COMPOSE_ISOLATION=PASS");
