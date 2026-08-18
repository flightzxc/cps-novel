import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { getStaticSitemapRoot } from "@/lib/seo/static-sitemap-cache";
import {
  generateStaticSitemaps,
  type GenerateStaticSitemapsOptions,
  type GenerateStaticSitemapsResult,
  type StaticSitemapManifest,
} from "@/lib/seo/static-sitemap-generator";
import type { BuildSitemapFamily } from "@/lib/seo/sitemap";

export const SITEMAP_LOCK_FILE = "sitemap-generation.lock";
export const SITEMAP_STATUS_FILE = "status.json";

export type SitemapTaskStatus = "idle" | "running" | "success" | "failed";

export interface SitemapGenerationLock {
  runId: string;
  status: "running";
  startedAt: string;
  initiatedBy: string;
  reason: string;
  pid: number;
}

export interface SitemapGenerationStatus {
  status: SitemapTaskStatus;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  initiatedBy?: string;
  reason?: string;
  errorSummary?: string;
  manifest?: StaticSitemapManifest;
}

export interface SitemapCurrentInfo {
  kind: "missing" | "symlink" | "directory" | "file" | "other";
  target?: string;
}

export interface SitemapRefreshState {
  rootDir: string;
  lockPath: string;
  statusPath: string;
  current: SitemapCurrentInfo;
  active: StaticSitemapManifest | null;
  task: SitemapGenerationStatus;
}

export interface RefreshStaticSitemapOptions {
  buildFamily: BuildSitemapFamily;
  rootDir?: string;
  runId?: string;
  initiatedBy: string;
  reason?: string;
  version?: string;
  startedAt?: Date;
  releasePid?: number;
  generate?: (options: GenerateStaticSitemapsOptions) => Promise<GenerateStaticSitemapsResult>;
}

export interface RefreshStaticSitemapResult {
  ok: boolean;
  status: "success" | "failed" | "running";
  message: string;
  state: SitemapRefreshState;
}

function resolveRootDir(rootDir?: string): string {
  return path.resolve(rootDir ?? getStaticSitemapRoot());
}

function getLockPath(rootDir: string): string {
  return path.join(rootDir, SITEMAP_LOCK_FILE);
}

function getStatusPath(rootDir: string): string {
  return path.join(rootDir, SITEMAP_STATUS_FILE);
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function versionSuffix(version?: string): string {
  const normalized = version?.trim().replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return normalized ? `-${normalized}` : "";
}

function makeManualRunId(date: Date, pid: number, version?: string): string {
  return `release-${timestampForPath(date)}-${pid}${versionSuffix(version)}`;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function summarizeSitemapError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/((?:TOKEN|SECRET|PASSWORD|KEY|AUTH)[A-Z0-9_]*\s*[=:]\s*)[^\s"'`]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

async function getCurrentInfo(rootDir: string): Promise<SitemapCurrentInfo> {
  const currentPath = path.join(rootDir, "current");
  try {
    const stat = await fs.lstat(currentPath);
    if (stat.isSymbolicLink()) return { kind: "symlink", target: await fs.readlink(currentPath) };
    if (stat.isDirectory()) return { kind: "directory" };
    if (stat.isFile()) return { kind: "file" };
    return { kind: "other" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

async function readActiveManifest(
  rootDir: string,
  current: SitemapCurrentInfo,
): Promise<StaticSitemapManifest | null> {
  let manifestDir: string | null = null;
  if (current.kind === "symlink" && current.target) manifestDir = path.resolve(rootDir, current.target);
  else if (current.kind === "directory") manifestDir = path.join(rootDir, "current");
  if (!manifestDir) return null;

  const normalizedRoot = `${path.resolve(rootDir)}${path.sep}`;
  if (!manifestDir.startsWith(normalizedRoot)) return null;
  return readJsonFile<StaticSitemapManifest>(path.join(manifestDir, "manifest.json"));
}

async function readLock(rootDir: string): Promise<SitemapGenerationLock | null> {
  return readJsonFile<SitemapGenerationLock>(getLockPath(rootDir));
}

async function writeStatus(rootDir: string, status: SitemapGenerationStatus): Promise<void> {
  await writeJsonFile(getStatusPath(rootDir), status);
}

export async function readSitemapRefreshState(rootDirInput?: string): Promise<SitemapRefreshState> {
  const rootDir = resolveRootDir(rootDirInput);
  const current = await getCurrentInfo(rootDir);
  const [active, lock, persistedStatus] = await Promise.all([
    readActiveManifest(rootDir, current),
    readLock(rootDir),
    readJsonFile<SitemapGenerationStatus>(getStatusPath(rootDir)),
  ]);
  const task: SitemapGenerationStatus = lock
    ? {
        status: "running",
        runId: lock.runId,
        startedAt: lock.startedAt,
        initiatedBy: lock.initiatedBy,
        reason: lock.reason,
      }
    : persistedStatus ?? { status: "idle" };
  return {
    rootDir,
    lockPath: getLockPath(rootDir),
    statusPath: getStatusPath(rootDir),
    current,
    active,
    task,
  };
}

export async function acquireSitemapGenerationLock(input: {
  rootDir?: string;
  runId: string;
  initiatedBy: string;
  reason?: string;
  startedAt?: Date;
  pid?: number;
}): Promise<
  | { acquired: true; lock: SitemapGenerationLock }
  | { acquired: false; lock: SitemapGenerationLock | null }
> {
  const rootDir = resolveRootDir(input.rootDir);
  const lockPath = getLockPath(rootDir);
  const lock: SitemapGenerationLock = {
    runId: input.runId,
    status: "running",
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    initiatedBy: input.initiatedBy,
    reason: input.reason?.trim() || "manual refresh from admin settings",
    pid: input.pid ?? process.pid,
  };
  await fs.mkdir(rootDir, { recursive: true });

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf-8");
    return { acquired: true, lock };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { acquired: false, lock: await readLock(rootDir) };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function releaseSitemapGenerationLock(
  rootDirInput: string | undefined,
  runId: string,
): Promise<void> {
  const rootDir = resolveRootDir(rootDirInput);
  const lock = await readLock(rootDir);
  if (!lock || lock.runId !== runId) return;
  await fs.rm(getLockPath(rootDir), { force: true });
}

export async function refreshStaticSitemap(
  options: RefreshStaticSitemapOptions,
): Promise<RefreshStaticSitemapResult> {
  const rootDir = resolveRootDir(options.rootDir);
  const startedAt = options.startedAt ?? new Date();
  const releasePid = options.releasePid ?? process.pid;
  const runId = options.runId ?? makeManualRunId(startedAt, releasePid, options.version);
  const reason = options.reason?.trim() || "manual refresh from admin settings";
  const acquired = await acquireSitemapGenerationLock({
    rootDir,
    runId,
    initiatedBy: options.initiatedBy,
    reason,
    startedAt,
    pid: releasePid,
  });

  if (!acquired.acquired) {
    return {
      ok: false,
      status: "running",
      message: "已有 sitemap 生成任务运行中",
      state: await readSitemapRefreshState(rootDir),
    };
  }

  await writeStatus(rootDir, {
    status: "running",
    runId,
    startedAt: acquired.lock.startedAt,
    initiatedBy: acquired.lock.initiatedBy,
    reason,
  });

  try {
    const result = await (options.generate ?? generateStaticSitemaps)({
      buildFamily: options.buildFamily,
      rootDir,
      runId,
      releaseDate: startedAt,
      releasePid,
      initiatedBy: options.initiatedBy,
      reason,
      version: options.version,
    });
    await writeStatus(rootDir, {
      status: "success",
      runId,
      startedAt: acquired.lock.startedAt,
      finishedAt: new Date().toISOString(),
      initiatedBy: options.initiatedBy,
      reason,
      manifest: result.manifest,
    });
    await releaseSitemapGenerationLock(rootDir, runId);
    return {
      ok: true,
      status: "success",
      message: "Sitemap 已生成并切换。",
      state: await readSitemapRefreshState(rootDir),
    };
  } catch (error) {
    await writeStatus(rootDir, {
      status: "failed",
      runId,
      startedAt: acquired.lock.startedAt,
      finishedAt: new Date().toISOString(),
      initiatedBy: options.initiatedBy,
      reason,
      errorSummary: summarizeSitemapError(error),
    });
    await releaseSitemapGenerationLock(rootDir, runId);
    return {
      ok: false,
      status: "failed",
      message: "Sitemap 生成失败，旧 sitemap 已保留。",
      state: await readSitemapRefreshState(rootDir),
    };
  }
}
