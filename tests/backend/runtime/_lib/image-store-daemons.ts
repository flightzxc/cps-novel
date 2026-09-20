import { spawnSync } from "node:child_process";

/**
 * 两种 image store 的隔离测试 daemon。
 *
 * 🔴 CPU 架构与 image store 后端是两件事。"Mac 上绿 + amd64 CI 上绿"证明的是
 * 架构维度，而 2026-09-20 目标机验证失败的是 **store 维度**：
 *   经典 graphdriver   image inspect .Id = config digest，无 .Descriptor
 *   containerd store   image inspect .Id = manifest digest，有 .Descriptor
 * 所以两种后端都要有真实 daemon 实跑，不能用 mock 的字段冒充。
 *
 * 🔴 两种都用 dind 起，不复用宿主 daemon，也**不切换**宿主或 VPS 的存储后端：
 *   - 宿主是哪种后端不影响结论；
 *   - Docker 29 的 dind **默认就是 containerd snapshotter**（实测），
 *     所以经典后端必须显式 `--feature=containerd-snapshotter=false`，
 *     不能靠"不传 flag"来得到它。
 */

export type Store = "classic" | "containerd";

export const STORE_SPECS: Record<Store, { port: number; container: string; snapshotter: "true" | "false" }> = {
  classic: { port: 24375, container: "cps-novel-imgstore-classic", snapshotter: "false" },
  containerd: { port: 24376, container: "cps-novel-imgstore-containerd", snapshotter: "true" },
};

export const DIND_IMAGE = process.env.PREPROD_TEST_DIND_IMAGE ?? "docker:29-dind";

export function dockerHostFor(store: Store): string {
  const override = process.env[
    store === "classic"
      ? "PREPROD_TEST_CLASSIC_DOCKER_HOST"
      : "PREPROD_TEST_CONTAINERD_DOCKER_HOST"
  ];
  return override ?? `tcp://127.0.0.1:${STORE_SPECS[store].port}`;
}

export function hostDockerAvailable(): boolean {
  return spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
}

function daemonProbe(host: string): { ok: boolean; detail: string } {
  const r = spawnSync("docker", ["info", "--format", "{{.Driver}}"], {
    env: { ...process.env, DOCKER_HOST: host },
    encoding: "utf8",
  });
  // 🔴 判据是"真的报出了 driver"，不是"退出码为 0"。只看退出码的话，
  // daemon 起来过又立刻死掉这种情况会被判成就绪，整组测试带着不可用的
  // daemon 继续跑，产出一堆互不相关的单条失败，真正的死因反而看不见。
  const driver = (r.stdout ?? "").trim();
  return {
    ok: r.status === 0 && driver !== "",
    detail: `status=${r.status} stdout=${JSON.stringify(driver)} stderr=${JSON.stringify((r.stderr ?? "").trim().slice(0, 200))}`,
  };
}

function daemonReady(host: string): boolean {
  return daemonProbe(host).ok;
}

/** 起不来时把容器自己的状态与日志抓出来——否则只能看到"连不上"这句空话。 */
function diagnose(container: string): string {
  const state = spawnSync("docker", [
    "inspect", "-f", "status={{.State.Status}} exit={{.State.ExitCode}} err={{.State.Error}}", container,
  ], { encoding: "utf8" });
  const logs = spawnSync("docker", ["logs", "--tail", "40", container], { encoding: "utf8" });
  return [
    `  container state: ${(state.stdout ?? state.stderr ?? "").trim()}`,
    `  container logs (tail 40):`,
    `${(logs.stdout ?? "") + (logs.stderr ?? "")}`.split("\n").map((l) => `    ${l}`).join("\n"),
  ].join("\n");
}

/** 返回该 daemon 实际报告的 store 证据，用于在报告里留痕（而不是我们声称它是什么）。 */
export function daemonEvidence(host: string): { serverVersion: string; driver: string; driverType: string } {
  const run = (fmt: string) =>
    spawnSync("docker", ["info", "--format", fmt], {
      env: { ...process.env, DOCKER_HOST: host },
      encoding: "utf8",
    }).stdout.trim();
  return {
    serverVersion: run("{{.ServerVersion}}"),
    driver: run("{{.Driver}}"),
    driverType: run("{{json .DriverStatus}}"),
  };
}

export function startDaemon(store: Store, timeoutMs = 180_000): string {
  const host = dockerHostFor(store);
  // 外部已经提供好 daemon（CI 里可能用 service container）就直接用。
  if (daemonReady(host)) return host;

  const spec = STORE_SPECS[store];
  spawnSync("docker", ["rm", "-f", spec.container], { encoding: "utf8" });
  const started = spawnSync(
    "docker",
    [
      "run", "-d", "--privileged", "--name", spec.container,
      "-e", "DOCKER_TLS_CERTDIR=",
      // 只绑回环地址：这是本机测试用的 daemon，不对外暴露。
      "-p", `127.0.0.1:${spec.port}:2375`,
      DIND_IMAGE,
      "--host=tcp://0.0.0.0:2375",
      `--feature=containerd-snapshotter=${spec.snapshotter}`,
    ],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    throw new Error(`failed to start ${store} test daemon: ${started.stderr || started.stdout}`);
  }
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const probe = daemonProbe(host);
    if (probe.ok) return host;
    last = probe.detail;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(
    `${store} test daemon did not become ready within ${timeoutMs}ms\n`
    + `  host: ${host}\n  last probe: ${last}\n${diagnose(spec.container)}`,
  );
}

export function stopDaemon(store: Store): void {
  // 外部提供的 daemon 不归我们关。
  if (process.env.PREPROD_TEST_CLASSIC_DOCKER_HOST && store === "classic") return;
  if (process.env.PREPROD_TEST_CONTAINERD_DOCKER_HOST && store === "containerd") return;
  spawnSync("docker", ["rm", "-f", STORE_SPECS[store].container], { encoding: "utf8" });
}
