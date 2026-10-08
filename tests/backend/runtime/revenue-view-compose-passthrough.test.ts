import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_CAPABILITY_CONFIG } from "@/lib/auth/capabilities";
import { APPROVED_LIGHT_TASK_TYPES } from "@/lib/tasks/worker-lanes.mjs";

/**
 * `revenue:view`（/revenue 数据看板及其手动同步）能力位的部署透传合同。
 *
 * Owner 2026-10-08 决定：默认开放给所有 super_admin（`defaultRoles: ["super_admin"]`），仍要求 2FA。
 * 此前 `defaultRoles` 为空，且 `docker-compose.yml` 的 web 服务没透传这两个变量——部署之后谁都打不开 /revenue。
 *
 * 期望值一律从 `ADMIN_CAPABILITY_CONFIG["revenue:view"]` 派生（`rolesEnv` / `userIdsEnv` / `defaultRoles`），
 * 不手抄环境变量名与默认值：以后有人改了能力位的环境变量名或默认角色，这里会跟着红，而不是静默地让
 * compose 与代码各说各话（compose 的默认值若退回空，能力位在容器里就和代码默认值不一致，同样会红）。
 * 覆盖三套 compose 渲染（根 compose、预生产 overlay 叠加后、production-like overlay 叠加后）：
 * web 带这两个变量，角色默认值 = 能力位的 `defaultRoles`、身份列表默认为空；worker、worker-light、
 * scheduler（以及 postgres / nginx 等其余服务）都不带。
 */
const root = resolve(import.meta.dirname, "../../..");
const files = ["docker-compose.yml", "infra/preproduction/docker-compose.yml", "infra/production-like/docker-compose.yml"];

const capability = ADMIN_CAPABILITY_CONFIG["revenue:view"];
const { rolesEnv, userIdsEnv } = capability;
/** compose 里 web 的角色默认值：从能力位表派生（= "super_admin"），不手抄。 */
const defaultRolesValue = capability.defaultRoles.join(",");

describe("revenue:view 能力位本身（派生真源）", () => {
  it("默认开放给 super_admin、要求 2FA；环境变量名是 REVENUE_VIEW_ROLES / REVENUE_VIEW_USER_IDS", () => {
    expect(capability.defaultRoles).toEqual(["super_admin"]);
    expect(defaultRolesValue).toBe("super_admin");
    expect(capability.requiresTwoFactor).toBe(true);
    expect(rolesEnv).toBe("REVENUE_VIEW_ROLES");
    expect(userIdsEnv).toBe("REVENUE_VIEW_USER_IDS");
  });
});

describe("根 docker-compose.yml 文本（不依赖 docker 命令）", () => {
  const compose = readFileSync(resolve(root, files[0]!), "utf8");
  const serviceBlock = (name: string): string => {
    const match = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|\\nnetworks:|\\nvolumes:|\\nsecrets:)`));
    expect(match, `missing service ${name}`).not.toBeNull();
    return match?.[1] ?? "";
  };

  it("web 带这两个变量：角色默认值 = 能力位的 defaultRoles（super_admin），身份列表默认为空", () => {
    const web = serviceBlock("web");
    expect(web).toContain(`${rolesEnv}: \${${rolesEnv}:-${defaultRolesValue}}`);
    expect(web).toContain(`${userIdsEnv}: \${${userIdsEnv}:-}`);
  });

  it("worker / worker-light / scheduler / postgres 的服务块里都没有这两个变量名", () => {
    for (const name of ["worker", "worker-light", "scheduler", "postgres"]) {
      const block = serviceBlock(name);
      expect(block, name).not.toContain(rolesEnv);
      expect(block, name).not.toContain(userIdsEnv);
    }
  });
});

const dockerComposeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

// 同 worker-light-compose-contract.test.ts：给三个文件里所有 `${X:?}` 必填变量填占位值，再渲染。
function renderEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
  for (const file of files) {
    for (const match of readFileSync(resolve(root, file), "utf8").matchAll(/\$\{([A-Z0-9_]+):\?/g)) env[match[1]!] = "/tmp/revenue-view-fixture";
  }
  return Object.assign(env, {
    CPS_NOVEL_APP_IMAGE: "cps-novel:revenue-view-test", APP_VERSION: "0.5.10", GIT_COMMIT: "a".repeat(40),
    SITE_URL: "https://example.test", TZ: "Asia/Tokyo", BUILD_DATE: "2026-10-08T00:00:00Z",
    WORKER_ID: "main-test", WORKER_LIGHT_ID: "light-test", WORKER_LANE: "main",
    WORKER_TASK_ALLOWLIST: "catalog_scan,changdu.revenue_sync.v1",
    WORKER_LIGHT_TASK_ALLOWLIST: APPROVED_LIGHT_TASK_TYPES.join(","),
  }, extra);
}

function render(overlay: string | undefined, extra: Record<string, string> = {}) {
  const args = ["compose", "-f", files[0]!, ...(overlay ? ["-f", overlay] : []), "config", "--format", "json"];
  const result = spawnSync("docker", args, { cwd: root, env: renderEnvironment(extra), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).services as Record<string, { environment?: Record<string, string> }>;
}

describe.each([
  ["根 compose", undefined],
  ["预生产 overlay 叠加后", files[1]],
  ["production-like overlay 叠加后", files[2]],
])("渲染后的服务环境：%s", (_name, overlay) => {
  it.skipIf(!dockerComposeAvailable)("web 带这两个变量：角色默认 = 能力位的 defaultRoles，身份列表默认为空", () => {
    const web = render(overlay).web!.environment ?? {};
    expect(rolesEnv in web, rolesEnv).toBe(true);
    expect(userIdsEnv in web, userIdsEnv).toBe(true);
    expect(web[rolesEnv]).toBe(defaultRolesValue);
    expect(web[userIdsEnv]).toBe("");
  });

  it.skipIf(!dockerComposeAvailable)("显式设置时原样透传到 web（可覆盖默认角色集）", () => {
    const web = render(overlay, { [rolesEnv]: "ops_viewer", [userIdsEnv]: "11111111-1111-4111-8111-111111111111" }).web!.environment ?? {};
    expect(web[rolesEnv]).toBe("ops_viewer");
    expect(web[userIdsEnv]).toBe("11111111-1111-4111-8111-111111111111");
  });

  it.skipIf(!dockerComposeAvailable)("除 web 以外的所有服务（worker / worker-light / scheduler / postgres / nginx …）都不带，即使宿主机环境里设置了", () => {
    const services = render(overlay, { [rolesEnv]: "super_admin", [userIdsEnv]: "11111111-1111-4111-8111-111111111111" });
    expect(Object.keys(services)).toEqual(expect.arrayContaining(["web", "worker", "worker-light", "scheduler"]));
    for (const [name, service] of Object.entries(services)) {
      if (name === "web") continue;
      expect(service.environment ?? {}, name).not.toHaveProperty(rolesEnv);
      expect(service.environment ?? {}, name).not.toHaveProperty(userIdsEnv);
    }
  });
});
