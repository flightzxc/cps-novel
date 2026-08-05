export const HEALTH_REASON_CODES = [
  "build_metadata_missing",
  "build_metadata_malformed",
  "runtime_version_claim_missing",
  "runtime_version_mismatch",
  "runtime_commit_claim_missing",
  "runtime_commit_mismatch",
  "database_timeout",
  "database_unreachable",
] as const;

export type HealthReasonCode = (typeof HEALTH_REASON_CODES)[number];
export type HealthStatus = "healthy" | "unhealthy";
export type HealthCheckStatus = "passed" | "failed";

export interface HealthBuildIdentity {
  version: string | null;
  commit: string | null;
  builtAt: string | null;
}

export interface HealthMetadataConsistency {
  status: HealthCheckStatus;
  runtimeClaims: {
    version: string | null;
    commit: string | null;
  };
}

export interface HealthDatabaseCheck {
  status: HealthCheckStatus;
  durationMs: number;
  reason: "timeout" | "unreachable" | null;
}

export interface HealthReport {
  ok: boolean;
  status: HealthStatus;
  build: HealthBuildIdentity;
  featureFlags: Readonly<Record<string, boolean>>;
  metadataConsistency: HealthMetadataConsistency;
  database: HealthDatabaseCheck;
  reasons: readonly HealthReasonCode[];
}
