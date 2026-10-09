// B-40 运行镜像依赖门禁：运行镜像里不允许出现开发依赖。
//
// 为什么存在：v0.5.11 起运行镜像整份复制了 builder 阶段的 node_modules，
// vitest / tinypool / @vitest/mocker 等开发依赖随之进入生产镜像（tinypool 有两条
// critical 漏洞）。Dockerfile 现在由独立的 production-dependencies 阶段
// （npm ci --omit=dev）提供 node_modules，本脚本负责在发版前证明这一点。
//
// 怎么运行：由 verify-brand-image.sh 在 docker build 之后，通过 stdin 送进容器：
//   docker run --rm -i --network none "$image" node --input-type=module - \
//     < scripts/preproduction/verify-runtime-image-deps.mjs
// 脚本取自本次检出而不是镜像内的副本，镜像只需提供 node。因为走 stdin，
// 这里不能依赖 import.meta.url、__dirname、process.argv，也不能 import 任何 npm 包；
// 根目录只读环境变量 RUNTIME_IMAGE_ROOT（默认 /app，测试里指向临时目录）。
//
// 为什么 devOptional 不算 dev：npm 给“既是开发依赖、又是某个生产依赖的可选 peer”的
// 包（例如 prisma 的可选 peer typescript）打 devOptional，`npm ci --omit=dev`
// 会保留它们。只有 dev === true 的条目才是 --omit=dev 一定会剔除的，才能拿来断言“不存在”。
//
// 为什么还有哨兵：第 2 步完全依赖 lockfile，若有人把 vitest 挪进 dependencies，
// lockfile 里它不再是 dev，第 2 步会放行。哨兵不看 lockfile，直接按包名拦
// vitest / tinypool / @vitest/*；门禁自身无法证明任何东西时（没有 dev 条目、
// 必需文件缺失）一律 fail-closed。
//
// 输出一行便于 grep；通过退出码 0，失败退出码 65。四类检查都会执行完再判，
// 多个原因同时出现时按 1 -> 4 的顺序报第一个。

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const root = process.env.RUNTIME_IMAGE_ROOT || "/app";

const REQUIRED = [
  "node_modules/prisma/package.json",
  "node_modules/.bin/prisma",
  "node_modules/@prisma/client/package.json",
  "node_modules/.prisma/client/index.js",
  "node_modules/next/package.json",
];
const FORBIDDEN_LABEL = "vitest,tinypool,@vitest/*";
const FORBIDDEN_NAMES = new Set(["vitest", "tinypool"]);

function failure(reason, violations) {
  const first = violations.slice(0, 5).join(",");
  return `RUNTIME_IMAGE_DEPS=FAIL reason=${reason} count=${violations.length} first=${first}`;
}

// 路径存在判断：符号链接（含悬空链接）也算存在。
function present(relative) {
  try {
    lstatSync(join(root, relative));
    return true;
  } catch {
    return false;
  }
}

function isForbiddenPackage(name) {
  return FORBIDDEN_NAMES.has(name) || name.startsWith("@vitest/");
}

// 只走包目录层级：<dir>/<name> 与 <dir>/@scope/<name>，再进入各包自己的 node_modules。
function walkNodeModules(dir, relative, visited, found) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return; // 符号链接环
  visited.add(real);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const packages = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // .bin / .cache / .prisma 等不是包
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith("@")) {
      let scoped = [];
      try {
        scoped = readdirSync(join(dir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) {
        if (inner.name.startsWith(".")) continue;
        packages.push({ name: `${entry.name}/${inner.name}`, path: join(dir, entry.name, inner.name) });
      }
    } else {
      packages.push({ name: entry.name, path: join(dir, entry.name) });
    }
  }
  for (const pkg of packages) {
    const pkgRelative = `${relative}/${pkg.name}`;
    if (isForbiddenPackage(pkg.name)) found.push(pkgRelative);
    walkNodeModules(join(pkg.path, "node_modules"), `${pkgRelative}/node_modules`, visited, found);
  }
}

// 1. lockfile 必须可读
let lockPackages = null;
try {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  if (lock && typeof lock === "object" && lock.packages && typeof lock.packages === "object") {
    lockPackages = lock.packages;
  }
} catch {
  lockPackages = null;
}

// 2. lockfile 里 dev === true 的条目一个都不能在镜像里
let devEntries = [];
const devPresent = [];
if (lockPackages) {
  devEntries = Object.keys(lockPackages).filter((key) => key !== "" && lockPackages[key]?.dev === true);
  for (const key of devEntries) {
    if (present(key)) devPresent.push(key);
  }
}

// 3. 哨兵：不看 lockfile，按包名拦
const forbiddenFound = [];
walkNodeModules(join(root, "node_modules"), "node_modules", new Set(), forbiddenFound);

// 4. 必需文件
const requiredMissing = REQUIRED.filter((relative) => !existsSync(join(root, relative)));

let line;
if (!lockPackages) line = failure("lockfile_unreadable", []);
else if (devEntries.length === 0) line = failure("lockfile_no_dev_entries", []);
else if (devPresent.length > 0) line = failure("dev_package_present", devPresent);
else if (forbiddenFound.length > 0) line = failure("forbidden_package_present", forbiddenFound);
else if (requiredMissing.length > 0) line = failure("required_missing", requiredMissing);
else {
  line = `RUNTIME_IMAGE_DEPS=PASS dev_entries_absent=${devEntries.length} forbidden=${FORBIDDEN_LABEL} required=${REQUIRED.join(",")}`;
}

// 不用 process.exit()：stdout 是管道时它可能截断未刷出的输出。
console.log(line);
process.exitCode = line.startsWith("RUNTIME_IMAGE_DEPS=PASS") ? 0 : 65;
