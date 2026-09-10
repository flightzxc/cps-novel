import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 施工工单_D9_up数据库准备原子化与镜像保留_2026-09-09.md, D-9b. Exercises
 * x8_gc() (scripts/x8-production-like.sh) directly against a stub `docker`
 * on PATH -- never a real daemon, never a real image. Follows the same
 * pattern as tests/backend/runtime/x8-role-password-alignment.test.ts and
 * x8-identity-lifecycle.test.ts: `source` the real launcher (safe, its CLI
 * dispatch only fires when the file is executed directly) and call the real
 * function.
 *
 * §4.2's five-category retention set is the contract under test: this file
 * covers all five categories individually (one dedicated it() per category,
 * so a regression in any single one is unambiguous about which broke), plus
 * the absolute prohibitions (never `rmi -f`, never any `-a`/`-af`), the
 * dry-run/apply split, N validation, dangling-layer handling, and the
 * previous-identity ledger's transition-period fallback.
 */

const STUB_DOCKER_SCRIPT = readFileSync(resolve(import.meta.dirname, "fixtures/x8-gc-stub-docker.sh"), "utf8");
const root = resolve(import.meta.dirname, "../../..");
const launcher = resolve(root, "scripts/x8-production-like.sh");

let workDir: string;
let runtimeDir: string;
let stubBinDir: string;
let stubLog: string;
let pruneLog: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "x8-gc-"));
  runtimeDir = join(workDir, "runtime");
  stubBinDir = join(workDir, "bin");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stubBinDir, { recursive: true });
  const dockerPath = join(stubBinDir, "docker");
  writeFileSync(dockerPath, STUB_DOCKER_SCRIPT);
  chmodSync(dockerPath, 0o755);
  stubLog = join(workDir, "docker-calls.log");
  pruneLog = join(workDir, "prune-calls.log");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeIdentity(path: string, imageRef: string) {
  // x8_gc() only ever reads `.imageRef` off these files -- the full
  // schemaVersion-3 shape resolve_x8_identity() requires is irrelevant to
  // it and deliberately not reproduced here.
  writeFileSync(path, JSON.stringify({ imageRef }, null, 2));
}

function identityFilePath() {
  return join(runtimeDir, "release-identity.json");
}

function previousIdentityFilePath() {
  return join(runtimeDir, "release-identity.previous.json");
}

/** CreatedAt strings sort correctly with plain `sort -r`: fixed-width, same TZ. */
function imagesLine(createdAt: string, tag: string): string {
  return `${createdAt}|${tag}`;
}

const TAGS = {
  newest: "cps-novel:0.1.0-newest1",
  second: "cps-novel:0.1.0-second2",
  third: "cps-novel:0.1.0-third33",
  fourth: "cps-novel:0.1.0-fourth4",
  fifth: "cps-novel:0.1.0-fifth55",
  sixth: "cps-novel:0.1.0-sixth66",
  oldestInUse: "cps-novel:0.1.0-oldestuse",
};

// Six candidates plus one deliberately-outside-N, oldest, in-use tag --
// mirrors the exact real-world shape the work order's own audit found
// (cps-novel:0.1.0-62453d2, 2026-08-07, still backing another compose
// project's worker/scheduler while sitting well outside "the last 5").
const DEFAULT_IMAGES = [
  imagesLine("2026-09-09 06:00:00 +0000 UTC", TAGS.newest),
  imagesLine("2026-09-09 05:00:00 +0000 UTC", TAGS.second),
  imagesLine("2026-09-09 04:00:00 +0000 UTC", TAGS.third),
  imagesLine("2026-09-09 03:00:00 +0000 UTC", TAGS.fourth),
  imagesLine("2026-09-09 02:00:00 +0000 UTC", TAGS.fifth),
  imagesLine("2026-09-09 01:00:00 +0000 UTC", TAGS.sixth),
  imagesLine("2026-08-07 00:00:00 +0000 UTC", TAGS.oldestInUse),
].join("\n");

function run(cli: string, envOverrides: Record<string, string | undefined> = {}) {
  const script = `
    set -euo pipefail
    source "${launcher}"
    ${cli}
  `;
  return spawnSync("bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH}`,
      X8_RUNTIME_DIR: runtimeDir,
      STUB_GC_LOG: stubLog,
      STUB_GC_PRUNE_LOG: pruneLog,
      STUB_GC_IMAGES: DEFAULT_IMAGES,
      STUB_GC_PS_IMAGES: TAGS.oldestInUse, // the safety-floor scenario, on by default
      ...envOverrides,
    },
  });
}

function stubLogLines(): string[] {
  try {
    return readFileSync(stubLog, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("X8 D-9b release-image retention gc (x8_gc)", () => {
  describe("§4.2 category 1: currently committed identity", () => {
    it("is kept even when it falls outside the most recent N and no container references it", () => {
      writeIdentity(identityFilePath(), TAGS.sixth);
      const result = run("x8_gc --keep 2 --apply", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${TAGS.sixth} reason=committed`);
      expect(result.stdout).not.toContain(`X8_GC_DELETE_IMAGE=${TAGS.sixth}`);
    });
  });

  describe("§4.2 category 2: previous committed identity", () => {
    it("is kept when the previous-identity ledger names it, even outside N and unreferenced", () => {
      writeIdentity(previousIdentityFilePath(), TAGS.sixth);
      const result = run("x8_gc --keep 2 --apply", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${TAGS.sixth} reason=previous`);
      expect(result.stdout).not.toContain("inferred");
    });

    it("falls back to the second-newest tag by creation time when the ledger file does not exist yet, and says so", () => {
      // No previous-identity ledger written at all -- the transition period
      // before any `up` has run under this D-9b patch.
      const result = run("x8_gc --keep 1 --apply", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      // TAGS.second is the second-newest by creation time in DEFAULT_IMAGES.
      expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${TAGS.second} reason=previous(inferred: no ledger file yet)`);
    });
  });

  describe("§4.2 category 3: most recent N by creation time", () => {
    it("keeps exactly the newest N tags and deletes the rest when N=3", () => {
      const result = run("x8_gc --keep 3 --apply", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      for (const tag of [TAGS.newest, TAGS.second, TAGS.third]) {
        expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${tag}`);
      }
      for (const tag of [TAGS.fourth, TAGS.fifth, TAGS.sixth, TAGS.oldestInUse]) {
        expect(result.stdout).toContain(`X8_GC_DELETE_IMAGE=${tag}`);
      }
    });

    it("defaults N to 5 when neither --keep nor either env var is given", () => {
      const result = run("x8_gc --apply", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_KEEP=5");
      for (const tag of [TAGS.newest, TAGS.second, TAGS.third, TAGS.fourth, TAGS.fifth]) {
        expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${tag}`);
      }
    });

    it("honors both env var spellings (X8_GC_KEEP_RECENT and X8_GC_KEEP), with X8_GC_KEEP taking priority", () => {
      const viaRecent = run("x8_gc --apply", { STUB_GC_PS_IMAGES: "", X8_GC_KEEP_RECENT: "2" });
      expect(viaRecent.stdout).toContain("X8_GC_KEEP=2");
      const viaKeep = run("x8_gc --apply", { STUB_GC_PS_IMAGES: "", X8_GC_KEEP: "4", X8_GC_KEEP_RECENT: "2" });
      expect(viaKeep.stdout).toContain("X8_GC_KEEP=4");
    });
  });

  describe("§4.2 category 4: referenced by any container, running or stopped -- the safety floor", () => {
    it("never deletes the oldest tag on the box when a STOPPED container still references it, even though it is outside N and not committed/previous", () => {
      // This is the exact real-world scenario the work order's own 2026-09-09
      // audit found: 0.1.0-62453d2, the oldest tag, still backing another
      // compose project's worker/scheduler containers. Default fixture
      // already wires STUB_GC_PS_IMAGES=TAGS.oldestInUse -- this test just
      // asserts the outcome explicitly instead of relying on other tests'
      // incidental setup.
      const result = run("x8_gc --keep 2 --apply");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${TAGS.oldestInUse} reason=in-use`);
      expect(result.stdout).not.toContain(`X8_GC_DELETE_IMAGE=${TAGS.oldestInUse}`);
    });
  });

  describe("§4.2 category 5: this up's own about-to-build image", () => {
    it("keeps $CPS_NOVEL_APP_IMAGE even when it has no container yet and falls outside N", () => {
      const result = run("x8_gc --keep 2 --apply", {
        STUB_GC_PS_IMAGES: "",
        CPS_NOVEL_APP_IMAGE: TAGS.sixth,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`X8_GC_KEEP_IMAGE=${TAGS.sixth} reason=current-build`);
    });

    it("is a no-op when gc runs standalone and $CPS_NOVEL_APP_IMAGE is unset (never calls prepare_x8_environment())", () => {
      const result = run("x8_gc --keep 2 --apply", { STUB_GC_PS_IMAGES: "", CPS_NOVEL_APP_IMAGE: undefined });
      expect(result.status, result.stderr).toBe(0);
      // No spurious keep-reason should ever be attributed to "current-build"
      // when nothing set the variable.
      expect(result.stdout).not.toContain("current-build");
    });
  });

  describe("dry-run is the default and deletes nothing", () => {
    it("prints the plan but issues zero `docker rmi` calls without --apply", () => {
      const result = run("x8_gc --keep 2", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_DRY_RUN=yes");
      for (const tag of [TAGS.fourth, TAGS.fifth, TAGS.sixth, TAGS.oldestInUse]) {
        expect(result.stdout).toContain(`X8_GC_DELETE_IMAGE=${tag}`);
      }
      const rmiCalls = stubLogLines().filter((line) => line.includes(" rmi "));
      expect(rmiCalls).toEqual([]);
    });

    it("also lists the dangling set in dry-run (informational) without pruning it", () => {
      const result = run("x8_gc --keep 2", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_DANGLING: "sha256:dangling1\nsha256:dangling2",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_DANGLING_COUNT=2");
      // §4.2 asks for the id AND size of each dangling layer, not just a
      // count: `docker image prune -f` is the one host-wide action in this
      // function (it is not restricted to cps-novel:0.1.0-* the way every
      // `rmi` is), so a dry-run has to make that blast radius reviewable
      // before an --apply is ever run. The stub returns bare ids with no
      // "|size" field, which also pins the missing-size fallback.
      expect(result.stdout).toContain("X8_GC_DANGLING_IMAGE=sha256:dangling1 size=unknown");
      expect(result.stdout).toContain("X8_GC_DANGLING_IMAGE=sha256:dangling2 size=unknown");
      const pruneCalls = stubLogLines().filter((line) => line.includes("image prune"));
      expect(pruneCalls).toEqual([]);
    });
  });

  describe("single `docker rmi` failure never aborts the round", () => {
    it("warns and keeps deleting the rest when one tag's rmi is refused", () => {
      const result = run("x8_gc --keep 2 --apply", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_RMI_FAIL: TAGS.fourth,
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain(`gc failed to remove image ${TAGS.fourth}`);
      expect(result.stdout).toContain("X8_GC_REMOVE_FAILED_COUNT=1");
      // The other deletion candidates (third/fifth/sixth/oldestInUse -- PS
      // is overridden empty in this test, so oldestInUse is NOT protected by
      // the in-use category here) still got removed despite fourth's own
      // rmi failure.
      expect(result.stdout).toContain(`X8_GC_REMOVED=${TAGS.third}`);
      expect(result.stdout).toContain(`X8_GC_REMOVED=${TAGS.fifth}`);
      expect(result.stdout).toContain(`X8_GC_REMOVED=${TAGS.sixth}`);
      expect(result.stdout).toContain(`X8_GC_REMOVED=${TAGS.oldestInUse}`);
      expect(result.stdout).not.toContain(`X8_GC_REMOVED=${TAGS.fourth}`);
    });
  });

  describe("X8_GC_PRUNE_DANGLING=0 never touches dangling layers", () => {
    it("calls neither the dangling listing nor `docker image prune` when disabled", () => {
      const result = run("x8_gc --keep 2 --apply", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_DANGLING: "sha256:shouldnotbeseen",
        X8_GC_PRUNE_DANGLING: "0",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_DANGLING_SKIPPED=X8_GC_PRUNE_DANGLING=0");
      expect(result.stdout).not.toContain("X8_GC_DANGLING_COUNT");
      const danglingCalls = stubLogLines().filter((line) => line.includes("dangling=true"));
      expect(danglingCalls).toEqual([]);
      const pruneCalls = stubLogLines().filter((line) => line.includes("image prune"));
      expect(pruneCalls).toEqual([]);
    });

    it("--auto defaults dangling cleanup OFF even though a manual gc would default it on", () => {
      const result = run("x8_gc --auto --keep 2", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_DANGLING: "sha256:shouldnotbeseen",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_DANGLING_SKIPPED=X8_GC_PRUNE_DANGLING=0");
    });

    it("an explicit X8_GC_PRUNE_DANGLING=1 overrides --auto's own default and does prune", () => {
      const result = run("x8_gc --auto --keep 2", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_DANGLING: "sha256:realone",
        X8_GC_PRUNE_DANGLING: "1",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_DANGLING_COUNT=1");
      const pruneCalls = stubLogLines().filter((line) => line.includes("image prune"));
      expect(pruneCalls.length).toBe(1);
    });
  });

  describe("N validation is fail-closed", () => {
    it.each(["0", "-3", "abc", "3.5"])("rejects --keep %s before issuing a single docker call", (bad) => {
      const result = run(`x8_gc --keep ${bad}`, { STUB_GC_PS_IMAGES: "" });
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("gc --keep must be a positive integer");
      expect(stubLogLines()).toEqual([]);
    });
  });

  describe("absolute prohibitions (§4.2) -- never seen in any invocation, ever", () => {
    it("never issues `docker rmi -f`, `docker image prune -a`, or `docker system prune`, across a full apply round with dangling cleanup on", () => {
      const result = run("x8_gc --keep 1 --apply", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_DANGLING: "sha256:onedangling",
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      const allCalls = stubLogLines();
      expect(allCalls.length).toBeGreaterThan(0);
      const rmiCalls = allCalls.filter((line) => / rmi /.test(line));
      const pruneCalls = allCalls.filter((line) => line.includes("image prune") || line.includes("system prune"));
      expect(rmiCalls.length).toBeGreaterThan(0);
      expect(pruneCalls.length).toBeGreaterThan(0);
      for (const line of rmiCalls) {
        // `docker ps -a` (used elsewhere in this same round, for category 4)
        // legitimately contains " -a" -- the prohibition below is scoped to
        // ONLY `rmi`/`prune` lines, never to every logged call indiscriminately.
        expect(line).not.toMatch(/-f\b/);
      }
      for (const line of pruneCalls) {
        expect(line).not.toMatch(/-a\b/);
        expect(line).not.toContain("-af");
        expect(line).not.toContain("system prune");
      }
      // And the prune call that DID happen was exactly `image prune -f`.
      expect(readFileSync(pruneLog, "utf8").trim().split("\n")).toEqual(["PRUNED"]);
    });
  });

  describe("scope: only cps-novel:0.1.0-* tags are ever candidates", () => {
    it("never lets a non-matching tag the stub might return leak into the delete set (bash-side filter, not just --filter)", () => {
      // The stub deliberately ignores --filter and returns whatever
      // STUB_GC_IMAGES says -- this proves x8_gc() applies its OWN
      // `cps-novel:0.1.0-*` shape check on top, not just the docker flag.
      const result = run("x8_gc --keep 1", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_IMAGES: [
          imagesLine("2026-09-09 06:00:00 +0000 UTC", TAGS.newest),
          imagesLine("2026-09-09 05:00:00 +0000 UTC", "cps-admin:8.3.6-rollback"),
          imagesLine("2026-09-09 04:00:00 +0000 UTC", "postgres:16.14"),
          imagesLine("2026-09-09 03:00:00 +0000 UTC", "nginx:1.28.0-alpine"),
        ].join("\n"),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("cps-admin");
      expect(result.stdout).not.toContain("postgres:16.14");
      expect(result.stdout).not.toContain("nginx:1.28.0-alpine");
      expect(result.stdout).toContain("X8_GC_CANDIDATES=1");
    });
  });

  describe("no candidates", () => {
    it("is a clean no-op when no cps-novel:0.1.0-* tags exist at all", () => {
      const result = run("x8_gc --apply", { STUB_GC_PS_IMAGES: "", STUB_GC_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("X8_GC_CANDIDATES=0");
      expect(stubLogLines().some((line) => line.includes(" rmi "))).toBe(false);
    });

    it("still emits the --json summary on the zero-candidate path, so a parser never sees a silent round", () => {
      const result = run("x8_gc --apply --json", { STUB_GC_PS_IMAGES: "", STUB_GC_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      const jsonLine = result.stdout.split("\n").find((line) => line.startsWith("X8_GC_SUMMARY_JSON="));
      expect(jsonLine, `no summary line in:\n${result.stdout}`).toBeTruthy();
      expect(JSON.parse(jsonLine!.slice("X8_GC_SUMMARY_JSON=".length))).toEqual({
        keepCount: 0,
        deleteList: [],
        reclaimableBytes: 0,
        danglingCount: null,
      });
    });
  });

  describe("standalone gc never touches git-derived state or secrets", () => {
    it("does not call prepare_x8_environment() -- no secret directory or build-date file is created", () => {
      const result = run("x8_gc --keep 2", { STUB_GC_PS_IMAGES: "" });
      expect(result.status, result.stderr).toBe(0);
      // prepare_p1_12_local_environment() would create runtimeDir/secrets
      // and a build-date-<commit>.txt file -- neither should exist.
      const entries = readdirSync(runtimeDir);
      expect(entries).not.toContain("secrets");
      expect(entries.some((entry) => entry.startsWith("build-date-"))).toBe(false);
    });
  });

  describe("--json emits a machine-readable summary alongside the human log", () => {
    it("includes a compact JSON line with the delete list and reclaimable bytes", () => {
      // --keep 3 keeps newest/second/third -- delete candidates are exactly
      // fourth/fifth/sixth/oldestInUse (PS is overridden empty, so the
      // in-use category does not additionally protect oldestInUse here).
      const result = run("x8_gc --keep 3 --json", {
        STUB_GC_PS_IMAGES: "",
        STUB_GC_IMAGE_SIZES: `${TAGS.fourth}=1000\n${TAGS.fifth}=2000\n${TAGS.sixth}=3000\n${TAGS.oldestInUse}=4000`,
      });
      expect(result.status, result.stderr).toBe(0);
      const jsonLine = result.stdout.split("\n").find((line) => line.startsWith("X8_GC_SUMMARY_JSON="));
      expect(jsonLine).toBeTruthy();
      const parsed = JSON.parse(jsonLine!.slice("X8_GC_SUMMARY_JSON=".length));
      expect(parsed.reclaimableBytes).toBe(10000);
      expect(parsed.deleteList.sort()).toEqual(
        [TAGS.fourth, TAGS.fifth, TAGS.sixth, TAGS.oldestInUse].sort(),
      );
    });
  });

  describe("ships valid shell (sourcing this file must never itself dispatch a subcommand)", () => {
    it("sourcing scripts/x8-production-like.sh with x8_gc defined does not run anything", () => {
      const result = spawnSync("bash", ["-c", `set -euo pipefail; source "${launcher}"; echo "SOURCED_OK=1"`], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, X8_RUNTIME_DIR: runtimeDir },
      });
      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("SOURCED_OK=1");
    });
  });
});
