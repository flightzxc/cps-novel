import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * 对抗性归档夹具。
 *
 * 🔴 这里**刻意**自带一个最小 ustar 读写器，而不是复用生产解析器：
 *   1. 用被测对象去制造它自己的反例是循环论证；
 *   2. macOS 的 bsdtar 与 Linux 的 GNU tar 在 pax 扩展头、xattr 上行为不同，
 *      借系统 tar 重打包会让"归档长什么样"随运行平台漂移，
 *      而本轮测的恰恰是"归档内容"这件事。
 * 只支持普通文件 + ustar，够造反例用；生产解析器遇到别的布局本来就该拒绝。
 */

const BLOCK = 512;

export type TarEntry = { name: string; body: Buffer };

export function readTarZst(archivePath: string): TarEntry[] {
  const out = spawnSync("zstd", ["-dc", archivePath], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (out.status !== 0) throw new Error(`zstd -dc failed for ${archivePath}`);
  const buf = out.stdout;
  const entries: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const head = buf.subarray(off, off + BLOCK);
    if (head.every((b) => b === 0)) break;
    const name = head.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = head.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const size = parseInt(head.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const typeflag = String.fromCharCode(head[156]);
    off += BLOCK;
    const body = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ name: prefix ? `${prefix}/${name}` : name, body: Buffer.from(body) });
    }
  }
  return entries;
}

function header(name: string, size: number, typeflag = "0"): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100, "ascii");           // mode
  h.write("0000000\0", 108, "ascii");           // uid
  h.write("0000000\0", 116, "ascii");           // gid
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  h.write(`${(0).toString(8).padStart(11, "0")}\0`, 136, "ascii"); // mtime=0，保证可复现
  h.write("        ", 148, "ascii");            // checksum 占位（先填空格）
  h.write(typeflag, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

export function writeTarZst(archivePath: string, entries: TarEntry[]): void {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e.name, e.body.length));
    parts.push(e.body);
    const pad = (BLOCK - (e.body.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // 结束标记
  const tarPath = `${archivePath}.rawtar`;
  writeFileSync(tarPath, Buffer.concat(parts));
  const z = spawnSync("zstd", ["-q", "-1", "-f", "-o", archivePath, tarPath], { encoding: "utf8" });
  if (z.status !== 0) throw new Error(`zstd compress failed: ${z.stderr}`);
  spawnSync("rm", ["-f", tarPath]);
}

/** 读出 index.json，交给回调改写，再原样重打包。 */
export function craftArchive(
  src: string,
  dest: string,
  mutate: (entries: TarEntry[], index: Record<string, unknown>) => void,
): void {
  const entries = readTarZst(src);
  const idxEntry = entries.find((e) => e.name === "index.json");
  if (!idxEntry) throw new Error("fixture source has no index.json");
  const index = JSON.parse(idxEntry.body.toString("utf8")) as Record<string, unknown>;
  mutate(entries, index);
  idxEntry.body = Buffer.from(`${JSON.stringify(index)}\n`, "utf8");
  writeTarZst(dest, entries);
}

export function readJson<T = Record<string, unknown>>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export function writeJson(p: string, value: unknown): void {
  writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}
