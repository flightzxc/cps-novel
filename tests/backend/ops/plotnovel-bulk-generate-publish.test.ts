import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { BASELINE, FINAL, OPERATION, runCommand, type Api, chunksFor, generationFailurePolicy, loadManifest, parseArgs, sha256, validateManifest, type Manifest } from "../../../scripts/ops/plotnovel-bulk-generate-publish";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const actor = "71f0e655-0640-4f07-bcbb-041f027fa7cb";
const id = (n: number) => `06000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const manifest = (n: number): Manifest => ({ schema: 1, operation: OPERATION, baseline: BASELINE, createdAt: new Date().toISOString(), actorId: actor, appId: id(9999), locale: "en", manualReviewBaseline: 635, publishedBaseline: 50, existingPreviewNovelIds: [], eligibleCount: n, blockedReasons: {}, waves: chunksFor(Array.from({ length: n }, (_, i) => id(i))) });
describe("PlotNovel bulk CLI file and argument guards", () => {
  it("1989 unique IDs produce frozen 500/500/500/489 waves and <=200 blocks", () => {
    const m = manifest(1989); validateManifest(m);
    expect(m.waves.map(w => w.chunks.map(c => c.novelIds.length))).toEqual([[200, 200, 100], [200, 200, 100], [200, 200, 100], [200, 200, 89]]);
    const changed = structuredClone(m); changed.waves[1].chunks[0].novelIds[0] = m.waves[0].chunks[0].novelIds[0];
    expect(() => validateManifest(changed)).toThrow("manifest_ids_invalid");
  });
  it("pins full file bytes using an external digest, not an embedded checksum", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plot-bulk-unit-"));
    try { const file = path.join(dir, "manifest.json"), bytes = JSON.stringify(manifest(1)); writeFileSync(file, bytes);
      expect(loadManifest(file, sha256(bytes)).eligibleCount).toBe(1);
      writeFileSync(file, bytes + "\n"); expect(() => loadManifest(file, sha256(bytes))).toThrow("manifest_sha256_mismatch");
      expect(() => loadManifest(file, sha256(bytes).slice(0, 8))).toThrow("manifest_sha256_mismatch");
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("rejects wrong confirmations, duplicate arguments and fractional wave numbers", () => {
    const base = ["generate", "--actor-id", actor, "--manifest", "m.json", "--manifest-sha256", "a".repeat(64), "--wave", "1"];
    expect(() => parseArgs(base)).toThrow("command_arguments_invalid");
    expect(() => parseArgs([...base, "--confirm", "YES"])).toThrow("confirmation_refused");
    expect(parseArgs([...base, "--confirm", "PLOTNOVEL_BULK_GENERATE"]).command).toBe("generate");
    expect(() => parseArgs([...base, "--wave", "2"])).toThrow("usage_invalid_argument");
    expect(() => parseArgs(base.map(x => x === "1" ? "1.5" : x))).toThrow("manifest_digest_wave_required");
  });
  it("rejects reordered blocks and an altered operation date", () => {
    const m = manifest(201); m.waves[0].chunks.reverse(); expect(() => validateManifest(m)).toThrow("manifest_partition_invalid");
    const other = { ...manifest(1), operation: "plotnovel-bulk-20261016" } as unknown as Manifest; expect(() => validateManifest(other)).toThrow("manifest_identity_invalid");
  });
});

describe("PlotNovel bulk generation failure policy", () => {
  const known = { code: "finalize_failed", message: "Item finalize failed: TemplateRenderError" };
  const failures = (n: number) => Array.from({ length: n }, () => known);
  it("rejects every template failure, including a single failure among the 58 target books", () => {
    expect(generationFailurePolicy(failures(1), 58).allowed).toBe(false);
    expect(generationFailurePolicy(failures(12), 500)).toEqual({ knownTemplateFailures: 12, otherFailures: 0, allowed: false });
    expect(generationFailurePolicy(failures(25), 500).allowed).toBe(false);
    expect(generationFailurePolicy(failures(26), 500).allowed).toBe(false);
    expect(generationFailurePolicy(failures(24), 485).allowed).toBe(false);
    expect(generationFailurePolicy(failures(25), 485).allowed).toBe(false);
  });
  it.each([
    null, {}, { code: "finalize_failed" },
    { code: "finalize_failed", message: "Item finalize failed: Error" },
    { code: "finalize_failed", message: "Item finalize failed: 42501" },
    { code: "other_failure", message: known.message },
    { ...known, message: known.message + " extra" },
    { ...known, message: "prefix " + known.message },
    { code: "finalize_failed", detail: { errorName: "TemplateRenderError" } },
  ])("stops on any unknown/missing/non-exact failure even below the old 2%% threshold: %j", error => {
    expect(generationFailurePolicy([error], 500)).toEqual({ knownTemplateFailures: 0, otherFailures: 1, allowed: false });
    expect(generationFailurePolicy([...failures(12), error], 500).allowed).toBe(false);
  });
  it("allows no failures and fails closed on an invalid denominator", () => {
    expect(generationFailurePolicy([], 500).allowed).toBe(true);
    for (const expected of [0, -1, 1.5, NaN, Infinity]) expect(generationFailurePolicy([], expected).allowed).toBe(false);
  });
});


describe("PlotNovel production identity remains fail closed through the command entrypoint", () => {
  const read = vi.mocked(fs.readFileSync);
  let restoreCwd: (() => void) | undefined;
  afterEach(() => {
    read.mockReset().mockImplementation(actualFs.readFileSync);
    restoreCwd?.();
    restoreCwd = undefined;
  });
  it.each([
    { cwd: "/app", commit: FINAL, version: "0.6.1", expected: "owner_admin_refused" },
    { cwd: "/app", commit: FINAL, version: "0.6.0", expected: "production_identity_mismatch" },
    { cwd: "/app", commit: "0".repeat(40), version: "0.6.1", expected: "production_identity_mismatch" },
    { cwd: "/tmp", commit: FINAL, version: "0.6.1", expected: "production_identity_mismatch" },
  ])("checks production identity before business access: %j", async (identity) => {
    const execute = vi.fn().mockResolvedValue(0);
    const query = vi.fn().mockResolvedValue([{ role: "web_app", db: "cps_novel", readonly: "on" }]);
    const businessAccess = vi.fn().mockResolvedValue(null);
    const tx = { $executeRawUnsafe: execute, $queryRaw: query, adminIdentity: { findUnique: businessAccess } };
    const db = { $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
    read.mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === "/app/.build-metadata.json") return JSON.stringify({ commit: identity.commit, version: identity.version });
      return actualFs.readFileSync(...args);
    }) as typeof fs.readFileSync);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(identity.cwd);
    restoreCwd = () => cwd.mockRestore();
    await expect(runCommand(parseArgs(["plan", "--actor-id", actor, "--output", "unused-manifest.json"]), db, {} as Api, () => {})).rejects.toThrow(identity.expected);
    expect(read).toHaveBeenCalledWith("/app/.build-metadata.json", "utf8");
    expect(execute).toHaveBeenCalledExactlyOnceWith("SET TRANSACTION READ ONLY");
    expect(businessAccess).toHaveBeenCalledTimes(identity.expected === "owner_admin_refused" ? 1 : 0);
  });
});
