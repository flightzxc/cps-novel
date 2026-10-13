/**
 * 登记畅读 PlotNovel 剧场（v0.6.0，口令码模式）——幂等、默认只读预演。
 *
 * 这是运维人员手动跑的登记工具（照 `scripts/register-moboreader-foundation.ts` 的形状）：不建凭据、
 * 不访问上游。`--apply` 在一个 PostgreSQL 事务里持咨询锁、校验所有已存在的行、只补缺失的行、
 * 每一类实际改动各追加一条 `operation_audit`。绝不会把任何能力记录创建为 / 提升为 `enabled`——
 * 能力由 Codex 发版时按顺序用 `scripts/set-channel-capability-status.ts` 逐条打开。
 *
 * 它做四件事（缺哪件补哪件，已经到位的件什么也不写）：
 *
 *   1. 给 MoboReader 剧场的 `channel_app.config` 补上 `promoMode: "link"`、`agencyIds: ["3366"]`
 *      （不存在 `promoMode` 的旧记录本来就按 link 处理，这一步只是把事实写明、给目录分流用）；
 *   2. 新建 `source_app`（code `plotnovel`）和同一渠道下的 `channel_app`
 *      （`externalAppId = plotnovel`，`projectType` 与 MoboReader 相同，`config.promoMode = "code"`）。
 *      新剧场的初始状态是 `registered_disabled`（CPS 同款"新建默认停用"）：目录扫描只把书落到
 *      **active** 的剧场下，所以登记之后、改挂完成之前，目录扫描的行为与改动前完全一致；
 *   3. 建 4 条能力记录（目录、领取、两项试读），状态一律 `registered_disabled`；
 *   4. 商店链接：`--app-store-url` / `--google-play-url`（`none` = 清空）。每次实际改动写一条审计。
 *
 * `--set-app-status active|registered_disabled`：改新剧场自己的状态（"打开 / 关闭"这个剧场），审计一条。
 * 运维手册规定它只在**改挂完成之后**才打开（见 `docs/operations/PLOTNOVEL_THEATER_OPENING_*.md`）。
 *
 * 用法：
 *   PLOTNOVEL_THEATER_OPERATOR=<operator> npx tsx scripts/register-plotnovel-theater.ts \
 *     --request-id <稳定编号> --reason "<原因>" \
 *     [--app-store-url <https 地址|none>] [--google-play-url <https 地址|none>] \
 *     [--set-app-status active|registered_disabled] [--apply]
 *
 * 必须在 Worker 层执行（`DATABASE_URL` 用 `worker_app` 那一条）：写 `channel_app` / `channel_capability` /
 * `source_app` 需要它的写权限，Web 层的授权不覆盖这几张表的 INSERT 之外的路径。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  THEATER_CONFIG_KEYS,
  normalizeStoreUrl,
} from "../src/server/publication/theater-promo-mode";
import { MOBOREADER_FOUNDATION } from "./register-moboreader-foundation";

export class PlotnovelTheaterError extends Error {
  constructor(
    readonly code:
      | "invalid_arguments"
      | "foundation_missing"
      | "metadata_drift"
      | "request_replay_conflict",
    message: string,
  ) {
    super(message);
    this.name = "PlotnovelTheaterError";
  }
}

/** 登记内容的唯一定义点；测试、手册、ADR 都引用这里，不各写一份。 */
export const PLOTNOVEL_THEATER = Object.freeze({
  sourceApp: Object.freeze({ code: "plotnovel", name: "PlotNovel", status: "active" }),
  channelApp: Object.freeze({
    externalAppId: "plotnovel",
    /** 新建默认停用：目录扫描不会把书落到它名下，直到手册规定的"改挂完成"那一步才打开。 */
    initialStatus: "registered_disabled",
  }),
  config: Object.freeze({
    promoMode: "code",
    agencyIds: Object.freeze(["1351"]),
    appDisplayName: "PlotNovel",
    codeModeLocales: Object.freeze(["en"]),
  }),
  moboreaderConfigPatch: Object.freeze({
    promoMode: "link",
    agencyIds: Object.freeze(["3366"]),
  }),
});

export const PLOTNOVEL_APP_STATUSES = ["active", "registered_disabled"] as const;
export type PlotnovelAppStatus = (typeof PLOTNOVEL_APP_STATUSES)[number];

const ADVISORY_LOCK_KEY = "cps-novel:plotnovel-theater:v1";
const ALLOWED_CAPABILITY_STATUSES = new Set(["registered_disabled", "enabled"]);

export const PLOTNOVEL_AUDIT_ACTIONS = Object.freeze({
  register: "plotnovel.theater.register",
  moboreaderConfig: "plotnovel.theater.moboreader_config.patch",
  storeLinks: "plotnovel.theater.store_links.update",
  appStatus: "plotnovel.theater.status.set",
} as const);

type ChannelRow = { id: string; code: string; name: string; status: string };
type SourceAppRow = { id: string; code: string; name: string; status: string };
type ChannelAppRow = {
  id: string;
  channelId: string;
  sourceAppId: string;
  externalAppId: string;
  projectType: number;
  status: string;
  config: unknown;
};
type CapabilityRow = {
  id: string;
  channelAppId: string;
  capabilityKey: string;
  status: string;
  sideEffecting: boolean;
  evidenceLevel: string;
  reasonCode: string | null;
  enabledGate: string | null;
  qpsLimit: { toString(): string } | string | number | null;
  timeoutMs: number | null;
  config: unknown;
};

export type TheaterSnapshot = {
  channel: ChannelRow | null;
  moboreaderSourceApp: SourceAppRow | null;
  moboreaderApp: ChannelAppRow | null;
  plotnovelSourceApp: SourceAppRow | null;
  plotnovelApp: ChannelAppRow | null;
  plotnovelCapabilities: readonly CapabilityRow[];
};

/** `undefined` = 本次不动这一项；`null` = 清空；字符串 = 已规范化的 https 地址。 */
export type StoreLinkRequest = {
  readonly appStoreUrl?: string | null;
  readonly googlePlayUrl?: string | null;
};

export type TheaterPlan = {
  /** 需要新建的实体标签。 */
  readonly create: readonly string[];
  /** MoboReader 的 config 需要补哪些键。 */
  readonly moboreaderConfigPatch: Readonly<Record<string, unknown>> | null;
  /** 新剧场的商店链接需要怎么改（键名 → 新值，`null` = 删除该键）。 */
  readonly storeLinkChanges: Readonly<Record<string, string | null>>;
  readonly appStatusChange: { readonly from: string; readonly to: PlotnovelAppStatus } | null;
  readonly capabilityStatuses: Readonly<Record<string, string | null>>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function drift(entity: string, field: string, expected: unknown, actual: unknown): never {
  throw new PlotnovelTheaterError(
    "metadata_drift",
    `${entity}.${field} metadata drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function expectField(entity: string, field: string, expected: unknown, actual: unknown): void {
  if (stableJson(expected) !== stableJson(actual)) drift(entity, field, expected, actual);
}

function plainConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

const SOURCE_APP_LABEL = `source_app:${PLOTNOVEL_THEATER.sourceApp.code}`;
const CHANNEL_APP_LABEL =
  `channel_app:${MOBOREADER_FOUNDATION.channel.code}`
  + `/${PLOTNOVEL_THEATER.sourceApp.code}`
  + `/${PLOTNOVEL_THEATER.channelApp.externalAppId}`;

/**
 * 纯函数：校验现状 + 算出还要做什么。任何与冻结内容不一致的已有行（哪怕只是 config 里 `agencyIds` 被人改过）
 * 一律抛 `metadata_drift`，绝不悄悄覆盖——登记工具只补缺，不改别人（或上一次的自己）写下的事实。
 */
export function planPlotnovelRegistration(
  snapshot: TheaterSnapshot,
  request: { readonly storeLinks: StoreLinkRequest; readonly setAppStatus?: PlotnovelAppStatus },
): TheaterPlan {
  if (!snapshot.channel || !snapshot.moboreaderSourceApp || !snapshot.moboreaderApp) {
    throw new PlotnovelTheaterError(
      "foundation_missing",
      "MoboReader foundation (channel changdu / source_app moboreader / its channel_app) is not registered; run register-moboreader-foundation first",
    );
  }
  const create: string[] = [];

  // --- 1. MoboReader 的 config：补键，不改已有键 ---
  const moboreaderConfig = plainConfig(snapshot.moboreaderApp.config);
  const patch: Record<string, unknown> = {};
  for (const [key, expected] of Object.entries(PLOTNOVEL_THEATER.moboreaderConfigPatch)) {
    if (moboreaderConfig[key] === undefined) patch[key] = expected;
    else expectField("channel_app:moboreader", `config.${key}`, expected, moboreaderConfig[key]);
  }

  // --- 2. PlotNovel 的 source_app / channel_app ---
  if (!snapshot.plotnovelSourceApp) {
    create.push(SOURCE_APP_LABEL);
  } else {
    expectField(SOURCE_APP_LABEL, "name", PLOTNOVEL_THEATER.sourceApp.name, snapshot.plotnovelSourceApp.name);
    expectField(SOURCE_APP_LABEL, "status", PLOTNOVEL_THEATER.sourceApp.status, snapshot.plotnovelSourceApp.status);
  }

  const storeLinkChanges: Record<string, string | null> = {};
  let appStatusChange: TheaterPlan["appStatusChange"] = null;
  if (!snapshot.plotnovelApp) {
    create.push(CHANNEL_APP_LABEL);
    if (request.storeLinks.appStoreUrl) storeLinkChanges[THEATER_CONFIG_KEYS.appStoreUrl] = request.storeLinks.appStoreUrl;
    if (request.storeLinks.googlePlayUrl) storeLinkChanges[THEATER_CONFIG_KEYS.googlePlayUrl] = request.storeLinks.googlePlayUrl;
    if (request.setAppStatus && request.setAppStatus !== PLOTNOVEL_THEATER.channelApp.initialStatus) {
      appStatusChange = { from: PLOTNOVEL_THEATER.channelApp.initialStatus, to: request.setAppStatus };
    }
  } else {
    const app = snapshot.plotnovelApp;
    if (snapshot.plotnovelSourceApp) expectField("channel_app:plotnovel", "sourceAppId", snapshot.plotnovelSourceApp.id, app.sourceAppId);
    expectField("channel_app:plotnovel", "channelId", snapshot.channel.id, app.channelId);
    expectField("channel_app:plotnovel", "externalAppId", PLOTNOVEL_THEATER.channelApp.externalAppId, app.externalAppId);
    expectField("channel_app:plotnovel", "projectType", snapshot.moboreaderApp.projectType, app.projectType);
    const config = plainConfig(app.config);
    for (const [key, expected] of Object.entries(PLOTNOVEL_THEATER.config)) {
      expectField("channel_app:plotnovel", `config.${key}`, expected, config[key]);
    }
    for (const [key, requested] of [
      [THEATER_CONFIG_KEYS.appStoreUrl, request.storeLinks.appStoreUrl],
      [THEATER_CONFIG_KEYS.googlePlayUrl, request.storeLinks.googlePlayUrl],
    ] as const) {
      if (requested === undefined) continue;
      const current = typeof config[key] === "string" ? (config[key] as string) : null;
      if (current !== requested) storeLinkChanges[key] = requested;
    }
    if (request.setAppStatus && request.setAppStatus !== app.status) {
      appStatusChange = { from: app.status, to: request.setAppStatus };
    }
  }

  // --- 3. 能力记录 ---
  const capabilityStatuses: Record<string, string | null> = {};
  for (const expected of MOBOREADER_FOUNDATION.capabilities) {
    const actual = snapshot.plotnovelCapabilities.find((row) => row.capabilityKey === expected.capabilityKey);
    capabilityStatuses[expected.capabilityKey] = actual?.status ?? null;
    const label = `channel_capability:plotnovel/${expected.capabilityKey}`;
    if (!actual) {
      create.push(label);
      continue;
    }
    if (!ALLOWED_CAPABILITY_STATUSES.has(actual.status)) {
      drift(label, "status", "registered_disabled|enabled", actual.status);
    }
    if (snapshot.plotnovelApp) expectField(label, "channelAppId", snapshot.plotnovelApp.id, actual.channelAppId);
    expectField(label, "sideEffecting", expected.sideEffecting, actual.sideEffecting);
    expectField(label, "evidenceLevel", expected.evidenceLevel, actual.evidenceLevel);
    expectField(label, "reasonCode", expected.reasonCode, actual.reasonCode);
    expectField(label, "enabledGate", expected.enabledGate, actual.enabledGate);
    expectField(label, "qpsLimit", expected.qpsLimit, actual.qpsLimit === null ? null : actual.qpsLimit.toString());
    expectField(label, "timeoutMs", expected.timeoutMs, actual.timeoutMs);
    expectField(label, "config", expected.config, actual.config);
  }

  return Object.freeze({
    create: Object.freeze(create),
    moboreaderConfigPatch: Object.keys(patch).length > 0 ? Object.freeze(patch) : null,
    storeLinkChanges: Object.freeze(storeLinkChanges),
    appStatusChange,
    capabilityStatuses: Object.freeze(capabilityStatuses),
  });
}

export function isPlanEmpty(plan: TheaterPlan): boolean {
  return plan.create.length === 0
    && plan.moboreaderConfigPatch === null
    && Object.keys(plan.storeLinkChanges).length === 0
    && plan.appStatusChange === null;
}

// ---------------------------------------------------------------------------
// 数据库访问（结构化最小接口，便于单测注入假库）
// ---------------------------------------------------------------------------

type TheaterReadClient = {
  channel: { findUnique(args: unknown): Promise<ChannelRow | null> };
  sourceApp: { findUnique(args: unknown): Promise<SourceAppRow | null> };
  channelApp: { findUnique(args: unknown): Promise<ChannelAppRow | null> };
  channelCapability: { findMany(args: unknown): Promise<CapabilityRow[]> };
};

type TheaterWriteClient = TheaterReadClient & {
  sourceApp: TheaterReadClient["sourceApp"] & { create(args: unknown): Promise<SourceAppRow> };
  channelApp: TheaterReadClient["channelApp"] & {
    create(args: unknown): Promise<ChannelAppRow>;
    update(args: unknown): Promise<ChannelAppRow>;
  };
  channelCapability: TheaterReadClient["channelCapability"] & { create(args: unknown): Promise<CapabilityRow> };
  operationAudit: {
    findFirst(args: unknown): Promise<{ id: bigint; actorId: string | null; reason: string | null } | null>;
    create(args: unknown): Promise<{ id: bigint }>;
  };
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
};

type TheaterRootClient = TheaterReadClient & {
  $transaction<T>(callback: (tx: TheaterWriteClient) => Promise<T>): Promise<T>;
};

async function loadSnapshot(db: TheaterReadClient): Promise<TheaterSnapshot> {
  const channel = await db.channel.findUnique({ where: { code: MOBOREADER_FOUNDATION.channel.code } });
  const moboreaderSourceApp = await db.sourceApp.findUnique({ where: { code: MOBOREADER_FOUNDATION.sourceApp.code } });
  const plotnovelSourceApp = await db.sourceApp.findUnique({ where: { code: PLOTNOVEL_THEATER.sourceApp.code } });
  const moboreaderApp = channel && moboreaderSourceApp
    ? await db.channelApp.findUnique({
        where: {
          channelId_sourceAppId_externalAppId: {
            channelId: channel.id,
            sourceAppId: moboreaderSourceApp.id,
            externalAppId: MOBOREADER_FOUNDATION.channelApp.externalAppId,
          },
        },
      })
    : null;
  const plotnovelApp = channel && plotnovelSourceApp
    ? await db.channelApp.findUnique({
        where: {
          channelId_sourceAppId_externalAppId: {
            channelId: channel.id,
            sourceAppId: plotnovelSourceApp.id,
            externalAppId: PLOTNOVEL_THEATER.channelApp.externalAppId,
          },
        },
      })
    : null;
  const plotnovelCapabilities = plotnovelApp
    ? await db.channelCapability.findMany({ where: { channelAppId: plotnovelApp.id } })
    : [];
  return { channel, moboreaderSourceApp, moboreaderApp, plotnovelSourceApp, plotnovelApp, plotnovelCapabilities };
}

export type RegisterTheaterOptions = {
  readonly apply: boolean;
  readonly operatorId: string;
  readonly requestId: string;
  readonly reason: string;
  readonly storeLinks: StoreLinkRequest;
  readonly setAppStatus?: PlotnovelAppStatus;
};

export type RegisterTheaterReport = {
  readonly mode: "dry-run" | "apply";
  readonly wrote: boolean;
  readonly create: readonly string[];
  readonly moboreaderConfigPatch: Readonly<Record<string, unknown>> | null;
  readonly storeLinkChanges: Readonly<Record<string, string | null>>;
  readonly appStatusChange: TheaterPlan["appStatusChange"];
  readonly capabilityStatuses: Readonly<Record<string, string | null>>;
  readonly auditIds: readonly string[];
};

function boundedRequired(name: string, value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new PlotnovelTheaterError("invalid_arguments", `${name} must contain 1-${max} characters`);
  }
  return normalized;
}

export function validateOptions(options: RegisterTheaterOptions): RegisterTheaterOptions {
  if (options.setAppStatus !== undefined && !PLOTNOVEL_APP_STATUSES.includes(options.setAppStatus)) {
    throw new PlotnovelTheaterError("invalid_arguments", `set-app-status must be one of ${PLOTNOVEL_APP_STATUSES.join("|")}`);
  }
  return {
    ...options,
    operatorId: boundedRequired("operator", options.operatorId, 128),
    requestId: boundedRequired("request-id", options.requestId, 160),
    reason: boundedRequired("reason", options.reason, 1000),
  };
}

function nextConfig(
  current: Record<string, unknown>,
  changes: Readonly<Record<string, unknown>>,
): Prisma.InputJsonObject {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged as Prisma.InputJsonObject;
}

function initialPlotnovelConfig(storeLinkChanges: Readonly<Record<string, string | null>>): Prisma.InputJsonObject {
  return nextConfig({
    [THEATER_CONFIG_KEYS.promoMode]: PLOTNOVEL_THEATER.config.promoMode,
    [THEATER_CONFIG_KEYS.agencyIds]: [...PLOTNOVEL_THEATER.config.agencyIds],
    [THEATER_CONFIG_KEYS.appDisplayName]: PLOTNOVEL_THEATER.config.appDisplayName,
    [THEATER_CONFIG_KEYS.codeModeLocales]: [...PLOTNOVEL_THEATER.config.codeModeLocales],
  }, storeLinkChanges);
}

export async function registerPlotnovelTheater(
  db: TheaterRootClient,
  rawOptions: RegisterTheaterOptions,
): Promise<RegisterTheaterReport> {
  const options = validateOptions(rawOptions);
  const request = { storeLinks: options.storeLinks, setAppStatus: options.setAppStatus };

  if (!options.apply) {
    const plan = planPlotnovelRegistration(await loadSnapshot(db), request);
    return {
      mode: "dry-run",
      wrote: false,
      create: plan.create,
      moboreaderConfigPatch: plan.moboreaderConfigPatch,
      storeLinkChanges: plan.storeLinkChanges,
      appStatusChange: plan.appStatusChange,
      capabilityStatuses: plan.capabilityStatuses,
      auditIds: [],
    };
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${ADVISORY_LOCK_KEY}, 0))::text AS lock_result
    `;
    const before = await loadSnapshot(tx);
    const plan = planPlotnovelRegistration(before, request);
    if (isPlanEmpty(plan)) {
      return {
        mode: "apply" as const,
        wrote: false,
        create: plan.create,
        moboreaderConfigPatch: null,
        storeLinkChanges: plan.storeLinkChanges,
        appStatusChange: null,
        capabilityStatuses: plan.capabilityStatuses,
        auditIds: [],
      };
    }

    // 同一个 request-id 对同一类改动只能提交一次：重放且现状仍需要这类改动，说明上一次没有真正完成、
    // 或被人改回去了——让操作者换一个 request-id 并先看清现状，而不是悄悄再写一遍。
    const actionsToWrite = [
      ...(plan.create.length > 0 ? [PLOTNOVEL_AUDIT_ACTIONS.register] : []),
      ...(plan.moboreaderConfigPatch ? [PLOTNOVEL_AUDIT_ACTIONS.moboreaderConfig] : []),
      ...(Object.keys(plan.storeLinkChanges).length > 0 ? [PLOTNOVEL_AUDIT_ACTIONS.storeLinks] : []),
      ...(plan.appStatusChange ? [PLOTNOVEL_AUDIT_ACTIONS.appStatus] : []),
    ];
    for (const action of actionsToWrite) {
      const prior = await tx.operationAudit.findFirst({ where: { actorType: "system", action, requestId: options.requestId } });
      if (prior) {
        throw new PlotnovelTheaterError(
          "request_replay_conflict",
          `request-id was already committed for ${action} but the registration is still incomplete or changed; use a new request-id`,
        );
      }
    }

    const auditIds: string[] = [];
    const audit = async (action: string, entityId: string, beforeSnapshot: unknown, afterSnapshot: unknown) => {
      const row = await tx.operationAudit.create({
        data: {
          actorType: "system",
          actorId: options.operatorId,
          action,
          entityType: "ChannelApp",
          entityId,
          requestId: options.requestId,
          reason: options.reason,
          beforeSnapshot: beforeSnapshot as Prisma.InputJsonValue,
          afterSnapshot: afterSnapshot as Prisma.InputJsonValue,
        },
      });
      auditIds.push(row.id.toString());
    };

    // 1. MoboReader config 补键
    if (plan.moboreaderConfigPatch && before.moboreaderApp) {
      const current = plainConfig(before.moboreaderApp.config);
      const updated = await tx.channelApp.update({
        where: { id: before.moboreaderApp.id },
        data: { config: nextConfig(current, plan.moboreaderConfigPatch) },
      });
      await audit(PLOTNOVEL_AUDIT_ACTIONS.moboreaderConfig, before.moboreaderApp.id, { config: current }, { config: plainConfig(updated.config) });
    }

    // 2. PlotNovel source_app / channel_app / 能力
    let sourceApp = before.plotnovelSourceApp;
    if (!sourceApp) sourceApp = await tx.sourceApp.create({ data: { ...PLOTNOVEL_THEATER.sourceApp } });
    let app = before.plotnovelApp;
    const createdApp = !app;
    if (!app) {
      app = await tx.channelApp.create({
        data: {
          channelId: before.channel!.id,
          sourceAppId: sourceApp.id,
          externalAppId: PLOTNOVEL_THEATER.channelApp.externalAppId,
          projectType: before.moboreaderApp!.projectType,
          status: PLOTNOVEL_THEATER.channelApp.initialStatus,
          config: initialPlotnovelConfig(plan.storeLinkChanges),
        },
      });
    }
    const existingCapabilities = new Set(before.plotnovelCapabilities.map((row) => row.capabilityKey));
    const createdCapabilities: string[] = [];
    for (const capability of MOBOREADER_FOUNDATION.capabilities) {
      if (existingCapabilities.has(capability.capabilityKey)) continue;
      await tx.channelCapability.create({
        data: {
          channelAppId: app.id,
          ...capability,
          status: "registered_disabled",
          config: capability.config as Prisma.InputJsonValue,
        },
      });
      createdCapabilities.push(capability.capabilityKey);
    }
    if (plan.create.length > 0) {
      await audit(PLOTNOVEL_AUDIT_ACTIONS.register, app.id, null, {
        created: plan.create,
        channelAppId: app.id,
        externalAppId: app.externalAppId,
        projectType: app.projectType,
        status: app.status,
        capabilitiesCreated: createdCapabilities,
      });
    }

    // 3. 商店链接（新建时的链接已经写在 config 里，这里只处理"已存在的剧场改链接"）
    if (!createdApp && Object.keys(plan.storeLinkChanges).length > 0) {
      const current = plainConfig(app.config);
      const updated = await tx.channelApp.update({
        where: { id: app.id },
        data: { config: nextConfig(current, plan.storeLinkChanges) },
      });
      app = updated;
      await audit(
        PLOTNOVEL_AUDIT_ACTIONS.storeLinks,
        updated.id,
        { appStoreUrl: current[THEATER_CONFIG_KEYS.appStoreUrl] ?? null, googlePlayUrl: current[THEATER_CONFIG_KEYS.googlePlayUrl] ?? null },
        { appStoreUrl: plainConfig(updated.config)[THEATER_CONFIG_KEYS.appStoreUrl] ?? null, googlePlayUrl: plainConfig(updated.config)[THEATER_CONFIG_KEYS.googlePlayUrl] ?? null },
      );
    } else if (createdApp && Object.keys(plan.storeLinkChanges).length > 0) {
      await audit(
        PLOTNOVEL_AUDIT_ACTIONS.storeLinks,
        app.id,
        { appStoreUrl: null, googlePlayUrl: null },
        { appStoreUrl: plainConfig(app.config)[THEATER_CONFIG_KEYS.appStoreUrl] ?? null, googlePlayUrl: plainConfig(app.config)[THEATER_CONFIG_KEYS.googlePlayUrl] ?? null },
      );
    }

    // 4. 剧场自己的状态（打开 / 关闭）
    if (plan.appStatusChange) {
      const updated = await tx.channelApp.update({ where: { id: app.id }, data: { status: plan.appStatusChange.to } });
      app = updated;
      await audit(PLOTNOVEL_AUDIT_ACTIONS.appStatus, app.id, { status: plan.appStatusChange.from }, { status: plan.appStatusChange.to });
    }

    // 复核：写完之后应当没有任何待办，否则整个事务回滚。
    const after = planPlotnovelRegistration(await loadSnapshot(tx), request);
    if (!isPlanEmpty(after)) {
      throw new PlotnovelTheaterError(
        "metadata_drift",
        `registration remained incomplete after apply: ${JSON.stringify(after)}`,
      );
    }
    return {
      mode: "apply" as const,
      wrote: true,
      create: plan.create,
      moboreaderConfigPatch: plan.moboreaderConfigPatch,
      storeLinkChanges: plan.storeLinkChanges,
      appStatusChange: plan.appStatusChange,
      capabilityStatuses: after.capabilityStatuses,
      auditIds,
    };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function valueAfter(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new PlotnovelTheaterError("invalid_arguments", `${name} requires a value`);
  }
  return value;
}

function parseStoreUrl(name: string, raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "none") return null;
  const normalized = normalizeStoreUrl(raw);
  if (!normalized) {
    throw new PlotnovelTheaterError("invalid_arguments", `${name} must be an absolute https URL (or "none" to clear it)`);
  }
  return normalized;
}

export function parseCliOptions(argv: readonly string[], env: NodeJS.ProcessEnv): RegisterTheaterOptions {
  const setAppStatus = valueAfter(argv, "--set-app-status");
  const storeLinks: { appStoreUrl?: string | null; googlePlayUrl?: string | null } = {};
  const appStoreUrl = parseStoreUrl("--app-store-url", valueAfter(argv, "--app-store-url"));
  const googlePlayUrl = parseStoreUrl("--google-play-url", valueAfter(argv, "--google-play-url"));
  if (appStoreUrl !== undefined) storeLinks.appStoreUrl = appStoreUrl;
  if (googlePlayUrl !== undefined) storeLinks.googlePlayUrl = googlePlayUrl;
  return validateOptions({
    apply: argv.includes("--apply"),
    operatorId: env.PLOTNOVEL_THEATER_OPERATOR ?? "",
    requestId: valueAfter(argv, "--request-id") ?? "",
    reason: valueAfter(argv, "--reason") ?? "",
    storeLinks,
    ...(setAppStatus !== undefined ? { setAppStatus: setAppStatus as PlotnovelAppStatus } : {}),
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2), process.env);
  const prisma = new PrismaClient();
  try {
    const report = await registerPlotnovelTheater(prisma as unknown as TheaterRootClient, options);
    if (report.mode === "dry-run") console.log("[DRY RUN - no changes written; pass --apply to write]");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
