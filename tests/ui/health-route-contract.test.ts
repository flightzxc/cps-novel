import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAdminPage, resolveAdminRoute } from "@/server/auth/registry";

/**
 * `/api/health` route-handler contract (P1-12).
 *
 * Lives in `tests/ui/` because that is the only Claude-owned vitest project:
 * `vitest.config.ts` includes `tests/ui/**` and `tests/backend|integration/**`
 * and nothing else, so a test placed beside the route under `src/` would never
 * be collected. `tests/backend/**` is Codex's. Several neighbours here are
 * already non-DOM boundary tests (`admin-secret-boundary`, `admin-nav-parity`),
 * so this file follows the existing discipline rather than bending the config.
 *
 * Scope is the handler only: status mapping, response envelope, cache header and
 * runtime declaration. The report's own semantics are Codex's
 * `tests/backend/health/p1-12-health-service.test.ts`; this file drives the real
 * service through the route so the two stay honest about the same report.
 */

const VERSION = "0.1.0";
const COMMIT = "4e0a4b9c97d21c127c23475bb0cf99ea7c706397";
const OTHER_COMMIT = "bee6a32cb855477202e107c04a09258a85877801";
const BUILT_AT = "2026-08-05T06:00:00Z";

const harness = vi.hoisted(() => ({
  metadataPath: "",
  environment: {} as Record<string, string | undefined>,
  probe: async (): Promise<unknown> => [{ ok: 1 }],
  databaseArgument: null as unknown,
}));

// The route must not construct a client of its own, so the shared one is
// replaced wholesale: if the handler ever stopped importing it, every
// assertion below about the probed connection would fail.
vi.mock("@/app/api/admin/_lib/deps", () => ({
  prisma: { $queryRaw: () => harness.probe() },
}));

// The frozen service is kept — only its baked-metadata path and env source are
// redirected, so the route is exercised against real report construction rather
// than a hand-written stand-in.
vi.mock("@/server/health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/health")>();
  return {
    ...actual,
    getHealthReport: (database: import("@/server/health").HealthDatabaseClient) => {
      harness.databaseArgument = database;
      return actual.createHealthService({
        metadataPath: harness.metadataPath,
        getEnvironment: () => harness.environment,
      })(database);
    },
  };
});

const { prisma } = await import("@/app/api/admin/_lib/deps");
const { GET, dynamic, runtime } = await import("@/app/api/health/route");

const directories: string[] = [];

async function bakeMetadata(content: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cps-novel-health-route-"));
  directories.push(directory);
  const file = path.join(directory, "build-metadata.json");
  await writeFile(file, content, "utf8");
  return file;
}

async function call(): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await GET();
  return { response, body: (await response.json()) as Record<string, unknown> };
}

async function healthy(): Promise<{ response: Response; body: Record<string, unknown> }> {
  harness.metadataPath = await bakeMetadata(
    JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }),
  );
  harness.environment = { APP_VERSION: VERSION, GIT_COMMIT: COMMIT };
  return call();
}

async function routeSource(): Promise<string> {
  return readFile(path.resolve(process.cwd(), "src/app/api/health/route.ts"), "utf8");
}

afterEach(async () => {
  harness.probe = async () => [{ ok: 1 }];
  harness.databaseArgument = null;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("P1-12 /api/health route handler", () => {
  it("answers 200 with the report when the runtime is healthy", async () => {
    const { response, body } = await healthy();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: "healthy",
      build: { version: VERSION, commit: COMMIT, builtAt: BUILT_AT },
      metadataConsistency: { status: "passed" },
      database: { status: "passed", reason: null },
      reasons: [],
    });
  });

  it("answers 503 when the runtime env claim disagrees with the baked identity", async () => {
    harness.metadataPath = await bakeMetadata(
      JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }),
    );
    harness.environment = { APP_VERSION: "9.9.9", GIT_COMMIT: OTHER_COMMIT };

    const { response, body } = await call();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      status: "unhealthy",
      metadataConsistency: {
        status: "failed",
        runtimeClaims: { version: "9.9.9", commit: OTHER_COMMIT },
      },
    });
    expect(body.reasons).toEqual(["runtime_version_mismatch", "runtime_commit_mismatch"]);
  });

  it("answers 503 when the build metadata file is absent", async () => {
    harness.metadataPath = path.join(tmpdir(), `cps-novel-health-route-missing-${process.pid}.json`);
    harness.environment = { APP_VERSION: VERSION, GIT_COMMIT: COMMIT };

    const { response, body } = await call();

    expect(response.status).toBe(503);
    expect(body.reasons).toEqual(["build_metadata_missing"]);
  });

  it("answers 503 when the database probe fails", async () => {
    harness.probe = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    };
    harness.metadataPath = await bakeMetadata(
      JSON.stringify({ version: VERSION, commit: COMMIT, builtAt: BUILT_AT }),
    );
    harness.environment = { APP_VERSION: VERSION, GIT_COMMIT: COMMIT };

    const { response, body } = await call();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      database: { status: "failed", reason: "unreachable" },
    });
    expect(body.reasons).toEqual(["database_unreachable"]);
    // The driver text reached the service and stopped there.
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("returns the report unwrapped and unrenamed", async () => {
    const { body } = await healthy();

    expect(Object.keys(body).sort()).toEqual([
      "build",
      "database",
      "featureFlags",
      "metadataConsistency",
      "ok",
      "reasons",
      "status",
    ]);
    for (const wrapper of ["data", "result", "success", "message", "error", "payload"]) {
      expect(body).not.toHaveProperty(wrapper);
    }
    expect(Object.keys(body.build as object).sort()).toEqual(["builtAt", "commit", "version"]);
    expect(Object.keys(body.database as object).sort()).toEqual(["durationMs", "reason", "status"]);
  });

  it("marks every response no-store", async () => {
    const { response } = await healthy();
    expect(response.headers.get("cache-control")).toBe("no-store");

    harness.probe = async () => {
      throw new Error("down");
    };
    const failed = await call();
    expect(failed.response.status).toBe(503);
    expect(failed.response.headers.get("cache-control")).toBe("no-store");
  });

  it("declares the Node runtime and refuses static generation", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });

  it("probes through the shared client instead of building its own", async () => {
    await healthy();
    expect(harness.databaseArgument).toBe(prisma);

    const source = await routeSource();
    expect(source).not.toContain("new PrismaClient");
    expect(source).not.toContain("DATABASE_URL");
  });

  it("requires no session and is unreachable through the admin registry", async () => {
    expect(resolveAdminRoute("/api/health", "GET")).toBeNull();
    expect(resolveAdminPage("/api/health")).toBeNull();

    const source = await routeSource();
    for (const guard of [
      "guardRead",
      "guardMutation",
      "requireAdminRouteAccess",
      "readSessionToken",
      "next/headers",
      "cookies(",
    ]) {
      expect(source).not.toContain(guard);
    }
  });

  it("reads no environment or secret material of its own", async () => {
    const source = await routeSource();
    for (const forbidden of [
      "process.env",
      "APP_VERSION",
      "GIT_COMMIT",
      "TOTP_ENCRYPTION_KEY",
      "CHANNEL_CREDENTIAL_ENCRYPTION_KEY",
      "CHANNEL_CREDENTIAL_FINGERPRINT_KEY",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    const { body } = await healthy();
    // Empty until a flag is added to the service allowlist; arbitrary env keys
    // are never reflected, so the endpoint cannot become an env dump.
    expect(body.featureFlags).toEqual({});
  });

  it("exposes only GET", async () => {
    const route = await import("@/app/api/health/route");
    expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key))).toEqual(["GET"]);
  });
});
