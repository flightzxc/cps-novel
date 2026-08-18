import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { listPublishableLocales } from "@/lib/locale/locale-canonical";
import { getStaticSitemapRoot } from "@/lib/seo/static-sitemap-cache";
import {
  renderSitemapIndexXml,
  renderUrlSetXml,
  SITEMAP_TYPES,
  type BuildSitemapFamily,
  type SitemapFamilySpec,
  type SitemapFile,
  type SitemapType,
} from "@/lib/seo/sitemap";

export interface StaticSitemapManifest {
  runId: string;
  releaseName: string;
  rootDir: string;
  releaseDir: string;
  generatedAt: string;
  promotedAt: string | null;
  durationMs: number;
  fileCount: number;
  urlCount: number;
  sitemapFiles: string[];
  version?: string;
  initiatedBy?: string;
  reason?: string;
}

export interface GenerateStaticSitemapsOptions {
  buildFamily: BuildSitemapFamily;
  rootDir?: string;
  releaseDate?: Date;
  releasePid?: number;
  runId?: string;
  initiatedBy?: string;
  reason?: string;
  version?: string;
  types?: readonly SitemapType[];
  routeLocales?: readonly SitemapFamilySpec["locale"][];
}

export interface GenerateStaticSitemapsResult {
  rootDir: string;
  releaseName: string;
  releaseDir: string;
  fileCount: number;
  urlCount: number;
  manifest: StaticSitemapManifest;
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function makeReleaseName(date: Date, pid: number): string {
  return `release-${timestampForPath(date)}-${pid}`;
}

function extractXmlLocValues(xml: string): string[] {
  return Array.from(xml.matchAll(/<(?:image:)?loc>([^<]*)<\/(?:image:)?loc>/g)).map(
    (match) => match[1]!,
  );
}

function hasPlaceholderUrlValue(value: string): boolean {
  try {
    const url = new URL(value);
    if (/^(undefined|null)$/i.test(url.hostname)) return true;
    if (url.pathname.split("/").some((segment) => /^(undefined|null)$/i.test(segment))) {
      return true;
    }
    return Array.from(url.searchParams.values()).some((paramValue) =>
      /^(undefined|null)$/i.test(paramValue));
  } catch {
    return /\b(undefined|null)\b/i.test(value);
  }
}

function validateXml(fileName: string, xml: string): void {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    throw new Error(`${fileName} is missing the XML declaration`);
  }
  if (!xml.includes("<sitemapindex") && !xml.includes("<urlset")) {
    throw new Error(`${fileName} is not a sitemap XML document`);
  }
  if (extractXmlLocValues(xml).some(hasPlaceholderUrlValue)) {
    throw new Error(`${fileName} contains an invalid placeholder URL value`);
  }
  if (/https?:\/\/(?:\/|\s|<)/i.test(xml)) {
    throw new Error(`${fileName} contains an invalid URL host`);
  }
}

async function writeXml(filePath: string, xml: string): Promise<void> {
  validateXml(path.basename(filePath), xml);
  await fs.writeFile(filePath, xml, "utf-8");
}

async function assertFileExists(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${filePath} is empty or not a file`);
  }
}

async function assertCurrentCanBePromoted(rootDir: string): Promise<void> {
  const currentLink = path.join(rootDir, "current");
  try {
    const stat = await fs.lstat(currentLink);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(
        "Sitemap current is a real directory; refusing to replace it automatically. Convert current to a symlink before manual refresh.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function replaceCurrentSymlink(rootDir: string, releaseName: string): Promise<void> {
  const tmpLink = path.join(rootDir, "current.tmp");
  const currentLink = path.join(rootDir, "current");
  await assertCurrentCanBePromoted(rootDir);
  await fs.rm(tmpLink, { force: true, recursive: true });
  await fs.symlink(path.join("releases", releaseName), tmpLink, "dir");
  await fs.rename(tmpLink, currentLink);
}

function extractIndexedSitemapFileNames(indexXml: string): string[] {
  return Array.from(indexXml.matchAll(/<loc>[^<]*\/sitemap\/([^/<]+\.xml)<\/loc>/g)).map(
    (match) => match[1]!,
  );
}

async function validateReleaseDirectory(
  releaseDir: string,
  indexFiles: SitemapFile[],
  urlCount: number,
): Promise<void> {
  if (indexFiles.length === 0) throw new Error("No sitemap child files were generated");
  if (urlCount <= 0) throw new Error("Generated sitemap contains no public URLs");

  const indexPath = path.join(releaseDir, "sitemap.xml");
  await assertFileExists(indexPath);
  const indexXml = await fs.readFile(indexPath, "utf-8");
  validateXml("sitemap.xml", indexXml);

  const expectedFileNames = new Set(indexFiles.map((file) => file.name));
  const indexedFileNames = extractIndexedSitemapFileNames(indexXml);
  for (const fileName of expectedFileNames) {
    if (!indexedFileNames.includes(fileName)) {
      throw new Error(`sitemap.xml does not reference ${fileName}`);
    }
  }
  for (const fileName of indexedFileNames) {
    if (!expectedFileNames.has(fileName)) {
      throw new Error(`sitemap.xml references unexpected child sitemap ${fileName}`);
    }
    const childPath = path.join(releaseDir, "sitemap", fileName);
    await assertFileExists(childPath);
    validateXml(fileName, await fs.readFile(childPath, "utf-8"));
  }
}

async function writeManifest(releaseDir: string, manifest: StaticSitemapManifest): Promise<void> {
  await fs.writeFile(
    path.join(releaseDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

export async function generateStaticSitemaps(
  options: GenerateStaticSitemapsOptions,
): Promise<GenerateStaticSitemapsResult> {
  const startedAt = Date.now();
  const releaseDate = options.releaseDate ?? new Date();
  const releasePid = options.releasePid ?? process.pid;
  const rootDir = path.resolve(options.rootDir ?? getStaticSitemapRoot());
  const releaseName = options.runId ?? makeReleaseName(releaseDate, releasePid);
  const releaseDir = path.join(rootDir, "releases", releaseName);
  const sitemapDir = path.join(releaseDir, "sitemap");
  const indexFiles: SitemapFile[] = [];
  const types = options.types ?? SITEMAP_TYPES;
  const routeLocales = options.routeLocales ?? listPublishableLocales();
  let urlCount = 0;

  await fs.mkdir(sitemapDir, { recursive: true });
  for (const type of types) {
    for (const locale of routeLocales) {
      const family = await options.buildFamily({ type, locale });
      for (const file of family) {
        await writeXml(path.join(sitemapDir, file.name), renderUrlSetXml(file.entries));
        urlCount += file.entries.length;
        indexFiles.push({ ...file, entries: [] });
      }
    }
  }

  await writeXml(path.join(releaseDir, "sitemap.xml"), renderSitemapIndexXml(indexFiles));
  await validateReleaseDirectory(releaseDir, indexFiles, urlCount);

  const manifestBase: StaticSitemapManifest = {
    runId: releaseName,
    releaseName,
    rootDir,
    releaseDir,
    generatedAt: new Date().toISOString(),
    promotedAt: null,
    durationMs: Date.now() - startedAt,
    fileCount: indexFiles.length + 1,
    urlCount,
    sitemapFiles: indexFiles.map((file) => `sitemap/${file.name}`),
    version: options.version,
    initiatedBy: options.initiatedBy,
    reason: options.reason,
  };
  await writeManifest(releaseDir, manifestBase);
  await replaceCurrentSymlink(rootDir, releaseName);

  const manifest: StaticSitemapManifest = {
    ...manifestBase,
    promotedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
  await writeManifest(releaseDir, manifest);
  return {
    rootDir,
    releaseName,
    releaseDir,
    fileCount: manifest.fileCount,
    urlCount,
    manifest,
  };
}
