/**
 * Static scan guarding the "意图先于外部调用" rule
 * (`CLAUDE.md` §5 修正 4, `src/lib/tasks/side-effect-intent.ts`): every call
 * site that invokes the claim adapter's `claimPromo` method must be able to
 * trace, within the same source file, to a `prepareSideEffectIntent(...)`
 * call that textually precedes it. This is deliberately a *textual*
 * precedence check (not control-flow analysis) — the same coarse-but-honest
 * trade-off `tests/backend/publish-gate/no-bypass.test.ts` documents for
 * its own scans: it narrows the search space, it does not prove the intent
 * is prepared on every runtime path.
 *
 * Roots scanned: `src/`, `worker/`, `scheduler/`, `scripts/`, `.ts`/`.tsx`
 * only. The one call site this scan is meant to find today is
 * `worker/handlers/promo-link-claim.ts`'s `claimViaAdapter` — this test
 * also positively asserts that file is where the call and the intent
 * preparation both live.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"].map((dir) => path.resolve(process.cwd(), dir));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
// The adapter's own definition/interface file legitimately mentions
// `.claimPromo(` as a method *declaration*, not a call — excluded from the
// call-site scan the same way `no-bypass.test.ts` excludes the canonical
// generator file from its own bypass scan.
const ADAPTER_DEFINITION_FILE = path.resolve(process.cwd(), "src/lib/adapters/promo-link-claim.ts");

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

// Matches an *invocation* of `claimPromo` reached through a receiver
// (`adapter.claimPromo(`, `this.adapter.claimPromo(`, ...) — not the bare
// method declaration `claimPromo(request: ...)` that appears once in the
// interface/implementation definition file.
//
// Every use below constructs a *fresh* `RegExp` instance rather than
// reusing one shared global-flag regex object: a global-flag regex's
// `.test()`/`.exec()` mutates its own `lastIndex`, and a single shared
// instance reused across many independent scans/assertions in this file
// would silently resume from wherever the previous call left off instead
// of starting at 0 — exactly the classic stateful-regex footgun.
function claimPromoCallSitePattern(): RegExp {
  return /\.claimPromo\s*\(/g;
}
function prepareIntentCallPattern(): RegExp {
  return /\bprepareSideEffectIntent\s*\(/;
}

function hasClaimPromoCallSite(source: string): boolean {
  return claimPromoCallSitePattern().test(source);
}

function findUntracedClaimCalls(source: string): number[] {
  const untraced: number[] = [];
  for (const match of source.matchAll(claimPromoCallSitePattern())) {
    const callIndex = match.index ?? 0;
    const before = source.slice(0, callIndex);
    if (!prepareIntentCallPattern().test(before)) untraced.push(callIndex);
  }
  return untraced;
}

describe("promo-link claim: intent-before-adapter-call regression", () => {
  it("every .claimPromo( call site in the tree is preceded, in the same file, by a prepareSideEffectIntent( call", async () => {
    const allFiles = (await Promise.all(SCAN_ROOTS.map(collectSourceFiles))).flat();
    const violations: Array<{ file: string; count: number }> = [];
    for (const file of allFiles) {
      if (file === ADAPTER_DEFINITION_FILE) continue;
      const source = await readFile(file, "utf8");
      if (!hasClaimPromoCallSite(source)) continue;
      const untraced = findUntracedClaimCalls(source);
      if (untraced.length > 0) violations.push({ file: path.relative(process.cwd(), file), count: untraced.length });
    }
    expect(violations).toEqual([]);
  });

  it("worker/handlers/promo-link-claim.ts is where the traced call site actually lives", async () => {
    const file = path.resolve(process.cwd(), "worker/handlers/promo-link-claim.ts");
    const source = await readFile(file, "utf8");
    expect(hasClaimPromoCallSite(source)).toBe(true);
    expect(findUntracedClaimCalls(source)).toEqual([]);
  });

  it("sanity: flags a claimPromo call with no prior intent preparation in the same file", () => {
    const bypass = `
      async function claimNow(adapter, request, token) {
        return adapter.claimPromo(request, token);
      }
    `;
    expect(findUntracedClaimCalls(bypass)).toHaveLength(1);
  });

  it("sanity: does not flag a call correctly preceded by prepareSideEffectIntent", () => {
    const legit = `
      async function claimNow(db, adapter, request, token) {
        await prepareSideEffectIntent(db, { effectKey, operationType: "x", idempotencyKey: effectKey, targetType: "y", targetId: "z" });
        return adapter.claimPromo(request, token);
      }
    `;
    expect(findUntracedClaimCalls(legit)).toEqual([]);
  });

  it("sanity: a prepareSideEffectIntent call in a *different* file does not satisfy the trace", () => {
    const bypass = `
      // prepareSideEffectIntent is prepared elsewhere, not in this file.
      async function claimNow(adapter, request, token) {
        return adapter.claimPromo(request, token);
      }
    `;
    expect(findUntracedClaimCalls(bypass)).toHaveLength(1);
  });
});
