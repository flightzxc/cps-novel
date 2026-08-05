import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHealthService,
  HEALTH_FEATURE_FLAG_ALLOWLIST,
  type HealthDatabaseClient,
  type HealthEnvironment,
} from "@/server/health";

const VERSION = "0.1.0";
const COMMIT = "4e0a4b9c97d21c127c23475bb0cf99ea7c706397";
const BUILT_AT = "2026-08-05T06:00:00Z";
const directories: string[] = [];

function database(probe: () => Promise<unknown>): HealthDatabaseClient {
  return { $queryRaw: vi.fn(probe) } as unknown as HealthDatabaseClient;
}

async function metadataFile(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cps-novel-health-"));
  directories.push(directory);
  const path = join(directory, "build-metadata.json");
  await writeFile(path, content, "utf8");
  return path;
}

function environment(overrides: HealthEnvironment = {}): HealthEnvironment {
  return { APP_VERSION: VERSION, GIT_COMMIT: COMMIT, ...overrides };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("P1-12 health service", () => {
  it("returns the baked identity when metadata and DB are healthy", async () => {
    const path = await metadataFile(JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }));
    const report = await createHealthService({
      metadataPath: path,
      getEnvironment: () => environment(),
    })(database(async () => [{ ok: 1 }]));

    expect(report).toMatchObject({
      ok: true,
      status: "healthy",
      build: { version: VERSION, commit: COMMIT, builtAt: BUILT_AT },
      featureFlags: {},
      metadataConsistency: {
        status: "passed",
        runtimeClaims: { version: VERSION, commit: COMMIT },
      },
      database: { status: "passed", reason: null },
      reasons: [],
    });
  });

  it("uses a stable missing-metadata failure", async () => {
    const report = await createHealthService({
      metadataPath: join(tmpdir(), `missing-health-metadata-${process.pid}.json`),
      getEnvironment: () => environment(),
    })(database(async () => [{ ok: 1 }]));

    expect(report.build).toEqual({ version: null, commit: null, builtAt: null });
    expect(report.reasons).toEqual(["build_metadata_missing"]);
    expect(report.ok).toBe(false);
  });

  it("uses a stable malformed-metadata failure for invalid JSON and invalid fields", async () => {
    for (const content of ["{broken", JSON.stringify({ version: VERSION, commit: "short", builtAt: BUILT_AT })]) {
      const path = await metadataFile(content);
      const report = await createHealthService({
        metadataPath: path,
        getEnvironment: () => environment(),
      })(database(async () => [{ ok: 1 }]));
      expect(report.reasons).toEqual(["build_metadata_malformed"]);
      expect(report.build.version).toBeNull();
    }
  });

  it.each([
    [{ APP_VERSION: "9.9.9" }, ["runtime_version_mismatch"]],
    [{ GIT_COMMIT: "a".repeat(40) }, ["runtime_commit_mismatch"]],
    [
      { APP_VERSION: "9.9.9", GIT_COMMIT: "a".repeat(40) },
      ["runtime_version_mismatch", "runtime_commit_mismatch"],
    ],
  ] as const)("detects runtime claim mismatches without replacing baked identity", async (claims, reasons) => {
    const path = await metadataFile(JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }));
    const report = await createHealthService({
      metadataPath: path,
      getEnvironment: () => environment(claims),
    })(database(async () => [{ ok: 1 }]));

    expect(report.reasons).toEqual(reasons);
    expect(report.build).toEqual({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT });
    expect(report.ok).toBe(false);
  });

  it("reports missing runtime claims in deterministic order", async () => {
    const path = await metadataFile(JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }));
    const report = await createHealthService({
      metadataPath: path,
      getEnvironment: () => ({}),
    })(database(async () => [{ ok: 1 }]));

    expect(report.reasons).toEqual([
      "runtime_version_claim_missing",
      "runtime_commit_claim_missing",
    ]);
  });

  it("marks a rejected DB probe unreachable without returning its error", async () => {
    const path = await metadataFile(JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }));
    const report = await createHealthService({
      metadataPath: path,
      getEnvironment: () => environment(),
    })(database(async () => { throw new Error("postgresql://user:password@postgres/private"); }));

    expect(report.database).toMatchObject({ status: "failed", reason: "unreachable" });
    expect(report.reasons).toEqual(["database_unreachable"]);
    expect(JSON.stringify(report)).not.toContain("password");
  });

  it("bounds a hanging DB probe and never rejects", async () => {
    const path = await metadataFile(JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }));
    const report = await createHealthService({
      metadataPath: path,
      databaseTimeoutMs: 10,
      getEnvironment: () => environment(),
    })(database(() => new Promise(() => undefined)));

    expect(report.database).toMatchObject({ status: "failed", reason: "timeout" });
    expect(report.reasons).toEqual(["database_timeout"]);
    expect(report.ok).toBe(false);
  });

  it("keeps the feature snapshot allowlist empty and excludes every secret", async () => {
    const path = await metadataFile(JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }));
    const report = await createHealthService({
      metadataPath: path,
      getEnvironment: () => environment({
        FEATURE_INVENTED: "true",
        DATABASE_URL: "postgresql://private",
        TOTP_ENCRYPTION_KEY: "totp-secret",
        CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1: "credential-secret",
        CHANNEL_CREDENTIAL_FINGERPRINT_KEY: "fingerprint-secret",
      }),
    })(database(async () => [{ ok: 1 }]));

    expect(HEALTH_FEATURE_FLAG_ALLOWLIST).toEqual([]);
    expect(report.featureFlags).toEqual({});
    const serialized = JSON.stringify(report);
    for (const secret of ["private", "totp-secret", "credential-secret", "fingerprint-secret", "FEATURE_INVENTED"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("never throws when both metadata and DB fail", async () => {
    const service = createHealthService({
      readMetadataFile: async () => { throw new Error("secret metadata failure"); },
      getEnvironment: () => environment(),
    });
    await expect(service(database(async () => { throw new Error("secret DB failure"); }))).resolves.toMatchObject({
      ok: false,
      reasons: ["build_metadata_malformed", "database_unreachable"],
    });
  });
});
