import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(`../../../${relative}`, import.meta.url), "utf8");
}

describe("catalog finalize recovery structural contracts", () => {
  it("keeps dry-run finalize creation behind the persisted task mode", () => {
    const store = source("src/lib/tasks/store.ts");
    expect(store).toContain('if (lease.mode === "apply") await tx.genericTaskItem.upsert');
    expect(store).toContain('if (row.mode === "apply"');
  });

  it("checks both production gates before entering catalog finalization", () => {
    const handler = source("worker/handlers/moboreader.ts");
    const finalizeBranch = handler.indexOf("lease.targetType === MOBOREADER_CATALOG_TARGET_TYPES.finalize");
    const featureGate = handler.indexOf("!isNovelCatalogSyncEnabled(env)", finalizeBranch);
    const writeGate = handler.indexOf("!isNovelCatalogSyncWriteAllowed(env)", featureGate);
    const finalizeCall = handler.indexOf("runCatalogFinalize(db, lease", finalizeBranch);
    expect(finalizeBranch).toBeGreaterThan(-1);
    expect(featureGate).toBeGreaterThan(finalizeBranch);
    expect(writeGate).toBeGreaterThan(featureGate);
    expect(finalizeCall).toBeGreaterThan(writeGate);
  });

  it("uses one max-attempt constant in the handler and registry", () => {
    const handler = source("worker/handlers/moboreader.ts");
    expect(handler).toContain("lease.attemptCount >= MOBOREADER_CATALOG_MAX_ATTEMPTS");
    expect(handler).toContain("maxAttempts: MOBOREADER_CATALOG_MAX_ATTEMPTS");
    expect(handler).not.toContain("lease.attemptCount >= 3");
  });

  it("terminates controlled-recovery pages as success, never skipped", () => {
    const recovery = source("scripts/catalog-finalize-recovery.ts");
    const update = recovery.slice(recovery.indexOf("UPDATE generic_task_item SET"), recovery.indexOf("if (missingIdentities.length"));
    expect(update).toContain("status = 'success'");
    expect(update).not.toContain("status = 'skipped'");
    expect(update).toContain("'returnedCount', 0");
    expect(recovery).toContain("moboreaderUpstreamRateGate");
  });
});
