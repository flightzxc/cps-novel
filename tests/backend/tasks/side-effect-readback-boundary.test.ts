/**
 * Static scan pinning the readback-recovery confirmation boundary
 * (`src/lib/tasks/side-effect-intent.ts`'s
 * `confirmSideEffectIntentByReadbackInTransaction`): the generic worker
 * graph (`isAllowedSideEffectTransition`) deliberately has no
 * `claim_retry_blocked -> confirmed` edge, so the only place production code
 * may confirm an intent whose outcome was ambiguous is this dedicated
 * function, called from the one readback-capable handler
 * (`worker/handlers/promo-link-claim.ts`). This test documents that
 * invariant the same coarse-but-honest way
 * `tests/backend/tasks/promo-link-claim-intent-bypass.test.ts` and
 * `tests/backend/publish-gate/no-bypass.test.ts` do for their own scans: a
 * textual call-site count, not control-flow analysis.
 *
 * Roots scanned: `src/`, `worker/`, `scheduler/`, `scripts/`, `.ts`/`.tsx`
 * only.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"].map((dir) => path.resolve(process.cwd(), dir));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const DEFINITION_FILE = path.resolve(process.cwd(), "src/lib/tasks/side-effect-intent.ts");
const READBACK_HANDLER_FILE = path.resolve(process.cwd(), "worker/handlers/promo-link-claim.ts");
const TASK_ADMIN_SERVICE_FILE = path.resolve(process.cwd(), "src/server/task-admin/service.ts");

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(target);
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
      return [target];
    }),
  );
  return nested.flat();
}

// Every use below constructs a *fresh* `RegExp` instance rather than reusing
// one shared global-flag regex object — a global-flag regex's
// `.test()`/`.exec()`/`.matchAll()` mutates its own `lastIndex`, and a single
// shared instance reused across many independent scans in this file would
// silently resume from wherever the previous call left off.
function confirmReadbackCallSitePattern(): RegExp {
  return /\bconfirmSideEffectIntentByReadbackInTransaction\s*\(/g;
}
function transitionInTransactionCallSitePattern(): RegExp {
  return /\btransitionSideEffectIntentInTransaction\s*\(/g;
}

describe("SideEffectIntent readback-recovery confirmation boundary: source pin", () => {
  it("confirmSideEffectIntentByReadbackInTransaction( is called from exactly one production file, the readback-capable claim handler", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const callSites: Array<{ file: string; count: number }> = [];
    for (const file of allFiles) {
      if (file === DEFINITION_FILE) continue;
      const source = await readFile(file, "utf8");
      const matches = [...source.matchAll(confirmReadbackCallSitePattern())];
      if (matches.length > 0) {
        callSites.push({ file: path.relative(process.cwd(), file), count: matches.length });
      }
    }
    expect(callSites).toEqual([
      { file: path.relative(process.cwd(), READBACK_HANDLER_FILE), count: 1 },
    ]);
  });

  it("worker/handlers/promo-link-claim.ts is the readback-capable handler that calls it", async () => {
    const source = await readFile(READBACK_HANDLER_FILE, "utf8");
    expect([...source.matchAll(confirmReadbackCallSitePattern())]).toHaveLength(1);
    expect(source).toContain("readPromoAfterClaim");
  });

  it("src/server/task-admin/service.ts does not mention the readback confirmation boundary — adjudication and readback recovery stay separate", async () => {
    const source = await readFile(TASK_ADMIN_SERVICE_FILE, "utf8");
    expect(source).not.toContain("confirmSideEffectIntentByReadback");
  });

  it("no remaining production caller of the generic in-transaction transition variant outside its own definition file", async () => {
    const roots = ["worker", "scheduler", path.resolve(process.cwd(), "src/lib/tasks")];
    const allFiles = (
      await Promise.all(
        roots.map((root) => (path.isAbsolute(root) ? collectSourceFiles(root) : collectSourceFiles(path.resolve(process.cwd(), root)))),
      )
    ).flat();
    const callSites: Array<{ file: string; count: number }> = [];
    for (const file of allFiles) {
      if (file === DEFINITION_FILE) continue;
      const source = await readFile(file, "utf8");
      const matches = [...source.matchAll(transitionInTransactionCallSitePattern())];
      if (matches.length > 0) {
        callSites.push({ file: path.relative(process.cwd(), file), count: matches.length });
      }
    }
    expect(callSites).toEqual([]);
  });
});
