import { readFile } from "node:fs/promises";

import { Prisma, type PrismaClient } from "@prisma/client";

import type {
  HealthBuildIdentity,
  HealthDatabaseCheck,
  HealthReasonCode,
  HealthReport,
} from "@/domain/health";

export const BUILD_METADATA_PATH = "/app/.build-metadata.json";
export const HEALTH_DATABASE_TIMEOUT_MS = 1_500;

/**
 * P1-12 starts with no implemented FEATURE_* consumer on main. Adding a flag
 * here is an explicit public-health contract change; arbitrary env keys are
 * never reflected.
 */
export const HEALTH_FEATURE_FLAG_ALLOWLIST = Object.freeze([] as const);

export type HealthDatabaseClient = Pick<PrismaClient, "$queryRaw">;
export type HealthEnvironment = Readonly<Record<string, string | undefined>>;

interface BuildMetadata {
  version: string;
  commit: string;
  builtAt: string;
}

export interface HealthServiceOptions {
  metadataPath?: string;
  databaseTimeoutMs?: number;
  getEnvironment?: () => HealthEnvironment;
  readMetadataFile?: (path: string) => Promise<string>;
  now?: () => number;
}

function cleanClaim(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isBuildMetadata(value: unknown): value is BuildMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<BuildMetadata>;
  return (
    typeof item.version === "string"
    && item.version.trim().length > 0
    && item.version !== "latest"
    && typeof item.commit === "string"
    && /^[0-9a-f]{40}$/.test(item.commit)
    && typeof item.builtAt === "string"
    && item.builtAt.trim().length > 0
    && Number.isFinite(Date.parse(item.builtAt))
  );
}

function emptyBuildIdentity(): HealthBuildIdentity {
  return { version: null, commit: null, builtAt: null };
}

function flagSnapshot(env: HealthEnvironment): Readonly<Record<string, boolean>> {
  return Object.freeze(
    Object.fromEntries(
      HEALTH_FEATURE_FLAG_ALLOWLIST.map((name) => [name, env[name] === "true"]),
    ),
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createHealthService(options: HealthServiceOptions = {}) {
  const metadataPath = options.metadataPath ?? BUILD_METADATA_PATH;
  const databaseTimeoutMs = options.databaseTimeoutMs ?? HEALTH_DATABASE_TIMEOUT_MS;
  const getEnvironment = options.getEnvironment ?? (() => process.env);
  const readMetadataFile = options.readMetadataFile ?? ((path: string) => readFile(path, "utf8"));
  const now = options.now ?? Date.now;

  if (!Number.isSafeInteger(databaseTimeoutMs) || databaseTimeoutMs < 1) {
    throw new Error("databaseTimeoutMs must be a positive safe integer");
  }

  return async function collectHealthReport(
    database: HealthDatabaseClient,
  ): Promise<HealthReport> {
    const reasons: HealthReasonCode[] = [];
    const env = getEnvironment();
    const runtimeVersion = cleanClaim(env.APP_VERSION);
    const runtimeCommit = cleanClaim(env.GIT_COMMIT);
    let build = emptyBuildIdentity();

    try {
      const parsed: unknown = JSON.parse(await readMetadataFile(metadataPath));
      if (!isBuildMetadata(parsed)) {
        reasons.push("build_metadata_malformed");
      } else {
        build = {
          version: parsed.version.trim(),
          commit: parsed.commit,
          builtAt: parsed.builtAt.trim(),
        };
        if (!runtimeVersion) reasons.push("runtime_version_claim_missing");
        else if (runtimeVersion !== build.version) reasons.push("runtime_version_mismatch");
        if (!runtimeCommit) reasons.push("runtime_commit_claim_missing");
        else if (runtimeCommit !== build.commit) reasons.push("runtime_commit_mismatch");
      }
    } catch (error) {
      reasons.push(isMissingFileError(error) ? "build_metadata_missing" : "build_metadata_malformed");
    }

    const databaseStartedAt = now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const databaseOutcome = await Promise.race([
      Promise.resolve()
        .then(() => database.$queryRaw(Prisma.sql`SELECT 1 AS ok`))
        .then(
          () => ({ status: "passed" as const, reason: null }),
          () => ({ status: "failed" as const, reason: "unreachable" as const }),
        ),
      new Promise<{ status: "failed"; reason: "timeout" }>((resolve) => {
        timeout = setTimeout(
          () => resolve({ status: "failed", reason: "timeout" }),
          databaseTimeoutMs,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    const databaseCheck: HealthDatabaseCheck = {
      status: databaseOutcome.status,
      reason: databaseOutcome.reason,
      durationMs: Math.max(0, now() - databaseStartedAt),
    };
    if (databaseOutcome.reason === "timeout") reasons.push("database_timeout");
    else if (databaseOutcome.reason === "unreachable") reasons.push("database_unreachable");

    const ok = reasons.length === 0;
    return {
      ok,
      status: ok ? "healthy" : "unhealthy",
      build,
      featureFlags: flagSnapshot(env),
      metadataConsistency: {
        status: reasons.some((reason) => reason.startsWith("build_") || reason.startsWith("runtime_"))
          ? "failed"
          : "passed",
        runtimeClaims: { version: runtimeVersion, commit: runtimeCommit },
      },
      database: databaseCheck,
      reasons: Object.freeze(reasons),
    };
  };
}

export const getHealthReport = createHealthService();
