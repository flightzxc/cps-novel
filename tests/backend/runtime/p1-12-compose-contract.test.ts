import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const compose = read("docker-compose.yml");
const dockerfile = read("Dockerfile");

function serviceBlock(name: string): string {
  const match = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|\\nnetworks:)`));
  expect(match, `missing service ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("P1-12 Compose and image contracts", () => {
  it("defines exactly the four approved resident services", () => {
    const serviceSection = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
    const services = Array.from(serviceSection.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm), (match) => match[1]);
    expect(services).toEqual(["postgres", "web", "worker", "scheduler"]);
  });

  it("fails closed on one exact application image variable without latest", () => {
    expect(compose).toContain("${CPS_NOVEL_APP_IMAGE:?CPS_NOVEL_APP_IMAGE is required}");
    expect(compose).not.toMatch(/CPS_APP_IMAGE|APP_IMAGE:-|latest/i);
    expect((compose.match(/CPS_NOVEL_APP_IMAGE/g) ?? [])).toHaveLength(2);
  });

  it("uses PostgreSQL 16.14 on the container network with a persistent volume and no published DB port", () => {
    const postgres = serviceBlock("postgres");
    expect(postgres).toContain("image: postgres:16.14");
    expect(postgres).toContain("postgres_data:/var/lib/postgresql/data");
    expect(postgres).toContain("pg_isready -U postgres -d cps_novel");
    expect(postgres).not.toMatch(/\n    ports:/);
    expect(serviceBlock("web")).toContain('"127.0.0.1:${P1_12_WEB_PORT:-3000}:3000"');
    expect(compose).not.toMatch(/network_mode:\s*host/);
  });

  it("contains no SQLite runtime, volume, probe, backup, pragma, or migrate-on-start behavior", () => {
    expect(`${compose}\n${dockerfile}`).not.toMatch(/sqlite|pragma|cps\.db|\/app\/data/i);
    expect(serviceBlock("web")).not.toMatch(/migrate/i);
    expect(serviceBlock("worker")).not.toMatch(/migrate/i);
    expect(serviceBlock("scheduler")).not.toMatch(/migrate/i);
  });

  it("gives Web and Worker only their explicit credential key surface", () => {
    const web = serviceBlock("web");
    const worker = serviceBlock("worker");
    for (const key of ["CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1", "CHANNEL_CREDENTIAL_FINGERPRINT_KEY"]) {
      expect(web).toContain(key);
      expect(worker).toContain(key);
    }
    expect(web).toContain("TOTP_ENCRYPTION_KEY");
    expect(worker).not.toContain("TOTP_ENCRYPTION_KEY");
    expect(worker).toContain("credential.validate.v1,credential.supersede.v1");
  });

  it("keeps Scheduler free of credential/TOTP/recovery keys and indirect env files", () => {
    const scheduler = serviceBlock("scheduler");
    expect(scheduler).toContain("P1_12_SCHEDULER_DATABASE_URL");
    expect(scheduler).not.toMatch(/CHANNEL_CREDENTIAL|FINGERPRINT|TOTP|RECOVERY|DECRYPT/i);
    expect(compose).not.toMatch(/env_file:/);
  });

  it("sets non-root application users, healthchecks, and bounded json-file logs", () => {
    expect(compose).toContain('user: "1001:1001"');
    expect(dockerfile).toContain("USER nextjs");
    for (const name of ["postgres", "web", "worker", "scheduler"]) {
      expect(serviceBlock(name)).toContain("healthcheck:");
    }
    expect(compose).toContain("max-size: 10m");
    expect(compose).toContain('max-file: "3"');
  });

  it("bakes one immutable metadata file and aligned OCI labels from required args", () => {
    for (const argument of ["APP_VERSION", "GIT_COMMIT", "BUILD_DATE"]) {
      expect(dockerfile).toContain(`ARG ${argument}`);
      expect(compose).toContain(`${argument}: \${${argument}:?${argument} is required}`);
    }
    expect(dockerfile).toContain('> /app/.build-metadata.json');
    expect(dockerfile).toContain("chmod 0444 /app/.build-metadata.json");
    expect(dockerfile).toContain('org.opencontainers.image.version="${APP_VERSION}"');
    expect(dockerfile).toContain('org.opencontainers.image.revision="${GIT_COMMIT}"');
    expect(dockerfile).toContain('org.opencontainers.image.created="${BUILD_DATE}"');
  });

  it("keeps migrations one-shot and reuses the P1-06 roles and grants", () => {
    const launcher = read("scripts/p1-12-compose-up.sh");
    expect(launcher).toContain('up -d postgres');
    expect(launcher).toContain("prisma migrate deploy");
    expect(launcher).toContain("infra/postgres/grants.sql");
    expect(launcher.indexOf("prisma migrate deploy")).toBeLessThan(launcher.indexOf("up -d web worker scheduler"));
    expect(read("infra/postgres/init-roles.sh")).toContain("/opt/cps-novel-postgres/roles.sql");
  });

  it("starts the real Worker entry and loops the existing one-shot Scheduler entry", () => {
    expect(serviceBlock("worker")).toContain('command: ["tsx", "worker/index.ts"]');
    expect(serviceBlock("scheduler")).toContain('command: ["bash", "scripts/run-scheduler-loop.sh"]');
    expect(read("scripts/run-scheduler-loop.sh")).toContain("tsx scheduler/index.ts");
  });

  it("ships syntactically valid runtime shell scripts", () => {
    for (const path of [
      "infra/postgres/init-roles.sh",
      "scripts/lib/p1-12-local-env.sh",
      "scripts/p1-12-compose-up.sh",
      "scripts/run-scheduler-loop.sh",
      "scripts/run-p1-12-runtime-verification.sh",
    ]) {
      execFileSync("bash", ["-n", resolve(root, path)]);
    }
  });
});
