import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// B-40：运行镜像只带生产依赖。本文件锁住四件事：
// Dockerfile 的阶段结构、package.json / package-lock.json 的依赖归属、
// verify-brand-image.sh 里的接线，以及门禁脚本本身的行为。
const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const dockerfile = read("Dockerfile");
const brandImageScript = read("scripts/preproduction/verify-brand-image.sh");
const gateScript = read("scripts/preproduction/verify-runtime-image-deps.mjs");
const pkg = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const lock = JSON.parse(read("package-lock.json")) as {
  packages: Record<string, Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
};

// 每个以 FROM 开头的行起一个阶段，阶段边界 = 下一个 `FROM `。
const stages = dockerfile.split(/^(?=FROM )/m).filter((chunk) => chunk.startsWith("FROM "));
const stageOf = (name: string) => stages.find((stage) => new RegExp(`^FROM \\S+ AS ${name}$`, "m").test(stage));

describe("B-40 Dockerfile 阶段结构", () => {
  it("有独立的 production-dependencies 阶段：npm ci --omit=dev 之后才 prisma generate", () => {
    const stage = stageOf("production-dependencies");
    expect(stage, "missing production-dependencies stage").toBeDefined();
    expect(stage).toMatch(/^FROM \$\{NODE_BASE_IMAGE\} AS production-dependencies$/m);
    const install = stage!.indexOf("RUN npm ci --omit=dev");
    const copyPrisma = stage!.indexOf("COPY prisma ./prisma");
    const generate = stage!.indexOf("RUN npx --no-install prisma generate");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(copyPrisma).toBeGreaterThan(install);
    expect(generate).toBeGreaterThan(copyPrisma);
  });

  it("production-dependencies 阶段位于 dependencies 之后、builder 之前，且自身是独立 FROM", () => {
    const order = stages.map((stage) => /^FROM \S+(?: AS (\S+))?$/m.exec(stage)?.[1]);
    expect(order).toEqual(["dependencies", "production-dependencies", "builder", "runner"]);
    expect(stageOf("builder")).toMatch(/^FROM dependencies AS builder$/m);
  });

  it("runner 阶段（最后一个 FROM 之后）从 production-dependencies 复制 node_modules", () => {
    const runner = stages.at(-1)!;
    expect(runner).toMatch(/^FROM \$\{NODE_BASE_IMAGE\} AS runner$/m);
    expect(runner).toContain(
      "COPY --from=production-dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules",
    );
    expect(runner.match(/\/app\/node_modules/g) ?? []).toHaveLength(1);
  });

  it("整个 Dockerfile 没有任何从 builder 或 dependencies 阶段复制 node_modules 的行", () => {
    expect(dockerfile).not.toMatch(/COPY\s+--from=(builder|dependencies)\b[^\n]*\/app\/node_modules/);
  });

  it("builder 在 npm run build 之后删掉 standalone 自带的 node_modules，runner 仍复制 standalone", () => {
    const builder = stageOf("builder");
    expect(builder, "missing builder stage").toBeDefined();
    const build = builder!.indexOf("RUN npm run build");
    const remove = builder!.indexOf("RUN rm -rf .next/standalone/node_modules");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(remove, "builder 必须删除 .next/standalone/node_modules").toBeGreaterThan(build);
    // standalone 的追踪副本会带出开发依赖 semver@6 的孤立 package.json，必须在被复制进 runner 之前删掉。
    expect(stages.at(-1)).toContain(
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./",
    );
  });

  it("dependencies 阶段仍是全量 npm ci（builder 构建要开发依赖）", () => {
    const stage = stageOf("dependencies");
    expect(stage, "missing dependencies stage").toBeDefined();
    expect(stage).toMatch(/^RUN npm ci$/m);
    expect(stage).not.toMatch(/--omit=dev|--production/);
  });
});

describe("B-40 package.json 依赖归属", () => {
  it("prisma 在 dependencies、不在 devDependencies（镜像内 migrate deploy 要用 prisma CLI）", () => {
    expect(pkg.dependencies.prisma).toBeTypeOf("string");
    expect(pkg.devDependencies.prisma).toBeUndefined();
  });

  it("prisma 与 @prisma/client 版本完全相同且为精确版本", () => {
    expect(pkg.dependencies.prisma).toBe(pkg.dependencies["@prisma/client"]);
    expect(pkg.dependencies.prisma).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("vitest 在 devDependencies、不在 dependencies", () => {
    expect(pkg.devDependencies.vitest).toBeTypeOf("string");
    expect(pkg.dependencies.vitest).toBeUndefined();
  });
});

describe("B-40 package-lock.json 与 package.json 一致", () => {
  it("根条目的 dependencies / devDependencies 与 package.json 完全一致（含 prisma 的位置）", () => {
    const rootEntry = lock.packages[""];
    expect(rootEntry.dependencies).toEqual(pkg.dependencies);
    expect(rootEntry.devDependencies).toEqual(pkg.devDependencies);
    expect(rootEntry.dependencies?.prisma).toBe(pkg.dependencies.prisma);
    expect(rootEntry.devDependencies?.prisma).toBeUndefined();
  });

  it("node_modules/prisma 既不是 dev 也不是 devOptional（否则 --omit=dev 会剔除它）", () => {
    const entry = lock.packages["node_modules/prisma"];
    expect(entry).toBeDefined();
    expect(entry.dev).toBeUndefined();
    expect(entry.devOptional).toBeUndefined();
  });

  it("vitest 在锁文件里是 dev；tinypool 若还在则也必须是 dev", () => {
    expect(lock.packages["node_modules/vitest"]?.dev).toBe(true);
    // 写成“存在才断言”：后续升级 vitest 可能让 tinypool 消失。
    const tinypool = lock.packages["node_modules/tinypool"];
    if (tinypool) expect(tinypool.dev).toBe(true);
  });
});

describe("B-40 verify-brand-image.sh 接线", () => {
  const build = brandImageScript.indexOf("docker build");
  const gate = brandImageScript.indexOf("node --input-type=module -");
  const run = brandImageScript.indexOf("docker run -d");

  it("门禁经 stdin 送进容器，失败分支输出 reason=runtime_deps 并 exit 65", () => {
    expect(brandImageScript).toContain("if ! docker run --rm -i --network none \"$image\" node --input-type=module - \\");
    expect(brandImageScript).toContain("< scripts/preproduction/verify-runtime-image-deps.mjs");
    expect(brandImageScript).toContain("echo 'BRAND_IMAGE=FAIL reason=runtime_deps'; exit 65");
  });

  it("门禁出现在 docker build 之后、docker run -d 之前", () => {
    expect(build).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(build);
    expect(run).toBeGreaterThan(gate);
  });

  it("最终 PASS 行格式不变（发版证据会 grep 它）", () => {
    expect(brandImageScript).toContain(
      'echo "BRAND_IMAGE=PASS image=$image status=200 content_type=image/png sha256=$checksum"',
    );
  });
});

describe("B-40 门禁脚本契约", () => {
  it("可经 stdin 运行：不依赖 import.meta / __dirname / process.argv，只 import node: 内置模块", () => {
    // 头部注释里会写到这些词，所以只检查去掉整行注释后的代码。
    const code = gateScript
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/import\.meta|__dirname|__filename|process\.argv/);
    const specifiers = Array.from(code.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms), (match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
    expect(code).not.toMatch(/\brequire\(|import\(/);
  });
});

// ---------------------------------------------------------------------------
// 门禁脚本行为。执行方式与 verify-brand-image.sh 完全一致：
// node --input-type=module - ，脚本文本走 stdin，根目录走 RUNTIME_IMAGE_ROOT。
// ---------------------------------------------------------------------------

const REQUIRED_FILES = [
  "node_modules/prisma/package.json",
  "node_modules/.bin/prisma",
  "node_modules/@prisma/client/package.json",
  "node_modules/.prisma/client/index.js",
  "node_modules/next/package.json",
];

type LockEntry = Record<string, unknown>;
type Fixture = { dir: string; lockPath: string; lockPackages: Record<string, LockEntry> };

function fixtureLockPackages(): Record<string, LockEntry> {
  return {
    "": { name: "fixture", dependencies: { prisma: "6.19.2", next: "16.3.8" } },
    "node_modules/prisma": { version: "6.19.2" },
    "node_modules/next": { version: "16.3.8" },
    "node_modules/typescript": { version: "5.9.3", devOptional: true },
    "node_modules/vitest": { version: "3.2.7", dev: true },
    "node_modules/tinypool": { version: "1.1.1", dev: true },
    "node_modules/eslint": { version: "9.0.0", dev: true },
    "node_modules/foo/node_modules/@vitest/mocker": { version: "3.2.7", dev: true },
  };
}

function put(dir: string, relative: string, content = "{}\n") {
  const target = join(dir, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRoot(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "runtime-image-deps-"));
  const lockPackages = fixtureLockPackages();
  for (const relative of REQUIRED_FILES) put(dir, relative);
  // devOptional 的包允许留在 --omit=dev 的树里，门禁不得把它当违规。
  put(dir, "node_modules/typescript/package.json");
  const lockPath = join(dir, "package-lock.json");
  writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3, packages: lockPackages }));
  return { dir, lockPath, lockPackages };
}

function writeLock(fixture: Fixture) {
  writeFileSync(fixture.lockPath, JSON.stringify({ lockfileVersion: 3, packages: fixture.lockPackages }));
}

function runGate(dir: string) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: gateScript,
    env: { ...process.env, RUNTIME_IMAGE_ROOT: dir },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function withFixture(body: (fixture: Fixture) => void) {
  const fixture = makeRoot();
  try {
    body(fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

describe("B-40 运行镜像依赖门禁行为", () => {
  it("1. 干净生产树通过（含 devOptional 的 node_modules/typescript，用例 10：不算违规）", () => {
    withFixture(({ dir }) => {
      const result = runGate(dir);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // dev 条目 = vitest / tinypool / eslint / foo/node_modules/@vitest/mocker 共 4 个；typescript 是 devOptional 不计入。
      expect(result.stdout).toBe(
        `RUNTIME_IMAGE_DEPS=PASS dev_entries_absent=4 forbidden=vitest,tinypool,@vitest/* required=${REQUIRED_FILES.join(",")}`,
      );
    });
  });

  it("2. 放回 node_modules/vitest：65 / dev_package_present", () => {
    withFixture(({ dir }) => {
      put(dir, "node_modules/vitest/package.json");
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=dev_package_present count=1 first=node_modules/vitest",
      );
    });
  });

  it("3. 嵌套 node_modules/foo/node_modules/@vitest/mocker 存在：65 / dev_package_present", () => {
    withFixture(({ dir }) => {
      put(dir, "node_modules/foo/node_modules/@vitest/mocker/package.json");
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=dev_package_present count=1 first=node_modules/foo/node_modules/@vitest/mocker",
      );
    });
  });

  it("3b. 嵌套 @vitest/mocker 且 lockfile 没有它的条目：哨兵仍拦下，65 / forbidden_package_present", () => {
    withFixture((fixture) => {
      delete fixture.lockPackages["node_modules/foo/node_modules/@vitest/mocker"];
      writeLock(fixture);
      put(fixture.dir, "node_modules/foo/node_modules/@vitest/mocker/package.json");
      const result = runGate(fixture.dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=forbidden_package_present count=1 first=node_modules/foo/node_modules/@vitest/mocker",
      );
    });
  });

  it("4. vitest 在 lockfile 里不再是 dev（模拟挪进 dependencies）且目录存在：65 / forbidden_package_present", () => {
    withFixture((fixture) => {
      fixture.lockPackages["node_modules/vitest"] = { version: "3.2.7" };
      writeLock(fixture);
      put(fixture.dir, "node_modules/vitest/package.json");
      const result = runGate(fixture.dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=forbidden_package_present count=1 first=node_modules/vitest",
      );
    });
  });

  it("5. node_modules/tinypool 存在但 lockfile 没有它的条目：65 / forbidden_package_present", () => {
    withFixture((fixture) => {
      delete fixture.lockPackages["node_modules/tinypool"];
      writeLock(fixture);
      put(fixture.dir, "node_modules/tinypool/package.json");
      const result = runGate(fixture.dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=forbidden_package_present count=1 first=node_modules/tinypool",
      );
    });
  });

  it("6. 缺 node_modules/.bin/prisma：65 / required_missing", () => {
    withFixture(({ dir }) => {
      rmSync(join(dir, "node_modules/.bin/prisma"));
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=required_missing count=1 first=node_modules/.bin/prisma",
      );
    });
  });

  it("7. 缺 node_modules/.prisma/client/index.js（Prisma Client 没生成）：65 / required_missing", () => {
    withFixture(({ dir }) => {
      rmSync(join(dir, "node_modules/.prisma/client/index.js"));
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=required_missing count=1 first=node_modules/.prisma/client/index.js",
      );
    });
  });

  it.each(REQUIRED_FILES)("7b. 逐个缺必需文件 %s：65 / required_missing", (missing) => {
    withFixture(({ dir }) => {
      rmSync(join(dir, missing));
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(`RUNTIME_IMAGE_DEPS=FAIL reason=required_missing count=1 first=${missing}`);
    });
  });

  it("8. 没有 package-lock.json：65 / lockfile_unreadable", () => {
    withFixture(({ dir, lockPath }) => {
      rmSync(lockPath);
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe("RUNTIME_IMAGE_DEPS=FAIL reason=lockfile_unreadable count=0 first=");
    });
  });

  it("8b. package-lock.json 不是合法 JSON 或没有 packages：65 / lockfile_unreadable", () => {
    withFixture(({ dir, lockPath }) => {
      writeFileSync(lockPath, "{ not json");
      const garbage = runGate(dir);
      expect(garbage.status).toBe(65);
      expect(garbage.stdout).toBe("RUNTIME_IMAGE_DEPS=FAIL reason=lockfile_unreadable count=0 first=");

      writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 3 }));
      const noPackages = runGate(dir);
      expect(noPackages.status).toBe(65);
      expect(noPackages.stdout).toBe("RUNTIME_IMAGE_DEPS=FAIL reason=lockfile_unreadable count=0 first=");
    });
  });

  it("9. lockfile 里没有任何 dev 条目：fail-closed，65 / lockfile_no_dev_entries", () => {
    withFixture((fixture) => {
      fixture.lockPackages = {
        "": fixture.lockPackages[""],
        "node_modules/prisma": { version: "6.19.2" },
        "node_modules/next": { version: "16.3.8" },
        "node_modules/typescript": { version: "5.9.3", devOptional: true },
      };
      writeLock(fixture);
      const result = runGate(fixture.dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe("RUNTIME_IMAGE_DEPS=FAIL reason=lockfile_no_dev_entries count=0 first=");
    });
  });

  it("多个原因同时出现时按 1 -> 4 的顺序报第一个（dev_package_present 先于 required_missing）", () => {
    withFixture(({ dir }) => {
      put(dir, "node_modules/vitest/package.json");
      put(dir, "node_modules/tinypool/package.json");
      rmSync(join(dir, "node_modules/.bin/prisma"));
      const result = runGate(dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=dev_package_present count=2 first=node_modules/vitest,node_modules/tinypool",
      );
    });
  });

  it("first 最多列 5 个违规路径，count 仍是总数", () => {
    withFixture((fixture) => {
      for (let i = 0; i < 7; i += 1) {
        fixture.lockPackages[`node_modules/dev-${i}`] = { version: "1.0.0", dev: true };
        put(fixture.dir, `node_modules/dev-${i}/package.json`);
      }
      writeLock(fixture);
      const result = runGate(fixture.dir);
      expect(result.status).toBe(65);
      expect(result.stdout).toBe(
        "RUNTIME_IMAGE_DEPS=FAIL reason=dev_package_present count=7 first=" +
          [0, 1, 2, 3, 4].map((i) => `node_modules/dev-${i}`).join(","),
      );
    });
  });

  it("node_modules 内的符号链接环不会让哨兵死循环，干净树仍然通过", () => {
    withFixture(({ dir }) => {
      mkdirSync(join(dir, "node_modules/a"), { recursive: true });
      // node_modules/a/node_modules -> ..（即 node_modules 自身）
      symlinkSync("..", join(dir, "node_modules/a/node_modules"));
      const result = runGate(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^RUNTIME_IMAGE_DEPS=PASS dev_entries_absent=4 /);
    });
  });

  it("点开头目录不当包：node_modules/.cache/vitest 不触发哨兵", () => {
    withFixture(({ dir }) => {
      put(dir, "node_modules/.cache/vitest/results.json");
      const result = runGate(dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^RUNTIME_IMAGE_DEPS=PASS /);
    });
  });
});
