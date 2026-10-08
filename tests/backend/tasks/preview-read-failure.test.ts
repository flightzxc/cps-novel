/**
 * B-36 — 试读上游读取失败时，条目 error 里要有"可诊断的类别"，并且不带任何正文。
 *
 * 背景：2026-10-07 有 34 本书试读抓取确定性失败，getbydataid / getchapterinfo 都是
 * HTTP 200，说明是我方 adapter 的校验拒收；但 handler 用裸 `catch {}` 把异常吞了，
 * 条目上只剩泛化的 `upstream_preview_read_failed`，查不出是哪条校验。
 *
 * 分三段：
 *   1. 各阶段 / 各校验抛出的错误 → 条目 error.detail 带对应类别（真走 adapter 的解析器）；
 *   2. 脱敏：错误信息里带了正文片段，也绝不出现在条目 error 或日志里；
 *   3. 兼容：顶层 code / message / 状态不变，后台任务页的展示不变。
 *
 * 真实库那一条（经 worker_app 角色落库）在
 * `tests/integration/tasks/preview-account-hold-postgres.test.ts`。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOBOREADER_PARSE_FAILURE_KINDS,
  MoboreaderAdapterError,
  MoboreaderRateLimitedError,
  parsePreviewChaptersResponse,
  type MoboreaderFailureDiagnostic,
} from "@/lib/adapters";
import { sanitizePersistedTaskError } from "@/lib/tasks/errors";
import { MOBOREADER_TASK_TYPES } from "@/lib/tasks/moboreader";
import { projectSafeTaskFailure, safeTaskFailureText } from "@/server/task-admin/safe-task-error";

import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";
import { createMoboreaderPreviewHandler } from "../../../worker/handlers/moboreader";
import {
  buildPreviewReadFailureLogEvent,
  describePreviewReadFailure,
  PREVIEW_READ_FAILURE_KINDS,
  type PreviewReadFailureContext,
  type PreviewReadFailureLogEvent,
} from "../../../worker/observability/preview-read-failure";
import { logPreviewReadFailure } from "../../../worker/observability/preview-read-failure-log";

/** 代表章节正文 / 上游文本：无论出现在哪条错误信息里，都不许进入条目 error 或日志。 */
const BODY = "CHAPTER-PROSE-THE-QUICK-BROWN-FOX-0xC0FFEE";

const ACCOUNT_A = "30000000-0000-4000-8000-00000000000a";
const APP_ID = "20000000-0000-4000-8000-000000000001";
const SOURCE_ID = "10000000-0000-4000-8000-000000000001";
const NOVEL_ID = "40000000-0000-4000-8000-000000000001";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

const GATES = Object.freeze({
  NODE_ENV: "test",
  FEATURE_NOVEL_CATALOG_SYNC: "true",
  NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
  MOBOREADER_PREVIEW_SOURCE_APP_CODES: "moboreader",
});

function keyring(): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-preview-read-failure-keys-"));
  const v1 = path.join(directory, "v1");
  const fingerprint = path.join(directory, "fingerprint");
  writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
  return {
    env: {
      NODE_ENV: "test",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** 最小的 `loadMoboreaderPreviewScope` 依赖面，凭据可用，能一路走到上游读取那一步。 */
function scopeDb(credential: { id: string; encryptedSecret: Uint8Array }) {
  return {
    channelSyncTaskItem: {
      findUnique: async () => ({
        taskId: TASK_ID,
        novelSourceItemId: SOURCE_ID,
        task: { taskType: MOBOREADER_TASK_TYPES.previewRefresh, channelAccountId: ACCOUNT_A, channelAppId: APP_ID },
        novelSourceItem: {
          id: SOURCE_ID,
          novelId: NOVEL_ID,
          channelAppId: APP_ID,
          externalAgencyId: "7",
          sourceLanguageCode: "1",
          rawPayload: { agencyId: "7", seriesId: "series-1", language: "1", projectType: 1, materialType: "3" },
          deletedAt: null,
        },
      }),
    },
    channelApp: {
      findFirst: async () => ({
        channelId: "channel-1",
        projectType: 1,
        sourceApp: { code: "moboreader" },
        capabilities: [{ capabilityKey: "getbydataid" }, { capabilityKey: "getchapterinfo" }],
      }),
    },
    channelAccount: {
      findFirst: async () => ({ id: ACCOUNT_A, credentials: [{ ...credential, keyVersion: 1 }] }),
    },
    channelSyncTask: { findUnique: async () => ({ channelAccountId: ACCOUNT_A }) },
  };
}

function lease(mode: "apply" | "dry_run" = "apply") {
  return {
    family: "channel_sync" as const,
    taskType: MOBOREADER_TASK_TYPES.previewRefresh,
    targetType: "novel_source_item",
    mode,
    itemId: ITEM_ID,
    taskId: TASK_ID,
    workerId: "worker-1",
    executionToken: "33333333-3333-4333-8333-333333333333",
    leaseEpoch: 1n,
    attemptCount: 1,
    lockedUntil: new Date(),
    payload: { trigger: "auto", actorId: "actor-1", requestId: "req-1" },
  };
}

function chapterRow(overrides: Record<string, unknown> = {}) {
  return { i: 1, chapterID: "c-1", chapterName: BODY, chapterShowName: BODY, chapterContent: `${BODY} once upon a time`, ...overrides };
}

function chapterBody(chapterList: unknown) {
  return { data: { bookId: "b-1", currentLanguage: 2, chapterList } };
}

type Adapter = {
  listBooks: ReturnType<typeof vi.fn>;
  fetchBookMaterial: ReturnType<typeof vi.fn>;
  fetchPreviewChapters: ReturnType<typeof vi.fn>;
};

let keys: ReturnType<typeof keyring>;
let credential: { id: string; encryptedSecret: Uint8Array };

beforeEach(() => {
  vi.unstubAllEnvs();
  keys = keyring();
  for (const [key, value] of Object.entries(keys.env)) {
    if (typeof value === "string") vi.stubEnv(key, value);
  }
  const id = randomUUID();
  credential = { id, encryptedSecret: new Uint8Array(encryptCredentialSecretForWorker("jwt", ACCOUNT_A, id, 1, keys.env)) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  keys.cleanup();
});

async function run(
  patch: Partial<Adapter>,
  options: { mode?: "apply" | "dry_run"; sink?: ((event: PreviewReadFailureLogEvent) => void) | null } = {},
) {
  const events: PreviewReadFailureLogEvent[] = [];
  const adapter: Adapter = {
    listBooks: vi.fn(),
    fetchBookMaterial: vi.fn(async () => ({})),
    fetchPreviewChapters: vi.fn(async () => ({ chapterList: [] as unknown[] })),
    ...patch,
  };
  const sink = options.sink === undefined ? (event: PreviewReadFailureLogEvent) => { events.push(event); } : options.sink;
  const handler = createMoboreaderPreviewHandler(scopeDb(credential) as never, {
    adapter: adapter as never,
    env: { ...GATES, ...keys.env },
    ...(sink ? { onPreviewReadFailure: sink } : {}),
  });
  const mode = options.mode ?? "apply";
  const outcome = await handler({ lease: lease(mode), mode, signal: new AbortController().signal, heartbeat: async () => true });
  return { outcome, adapter, events };
}

function detailOf(outcome: { error?: unknown }): Record<string, unknown> {
  return (outcome.error as { detail: Record<string, unknown> }).detail;
}

/** 条目 error 列最终落库的样子：handler 返回 → sanitizePersistedTaskError。 */
function persisted(outcome: { error?: unknown }) {
  return sanitizePersistedTaskError(outcome.error);
}

// ---------------------------------------------------------------------------
// 1. 类别：各阶段、各校验
// ---------------------------------------------------------------------------

describe("试读读取失败：条目 error.detail 带类别（B-36）", () => {
  it("getchapterinfo 解析失败（第 1 章正文为空串）：类别 + 位置，顶层 code/message 不变", async () => {
    const { outcome, adapter, events } = await run({
      fetchPreviewChapters: vi.fn(async () => parsePreviewChaptersResponse(chapterBody([
        chapterRow({ chapterContent: "" }),
        chapterRow({ i: 2, chapterID: "c-2" }),
        chapterRow({ i: 3, chapterID: "c-3" }),
      ]))),
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatchObject({
      code: "upstream_preview_read_failed",
      message: "MoboReader Preview read failed",
    });
    expect(detailOf(outcome)).toEqual({
      kind: "chapter_content_invalid",
      stage: "getchapterinfo",
      errorClass: "MoboreaderAdapterError",
      adapterCode: "malformed_payload",
      receivedType: "empty_string",
      chapterIndex: 0,
      chapterOrdinal: 1,
      chapterCount: 3,
    });
    // 失败状态流转不变：没有 protectedWrite，没有重试，两次上游读取各一次。
    expect(outcome.protectedWrite).toBeUndefined();
    expect(adapter.fetchBookMaterial).toHaveBeenCalledTimes(1);
    expect(adapter.fetchPreviewChapters).toHaveBeenCalledTimes(1);

    // 经过真正落库前的 sanitizePersistedTaskError 之后一个键都没丢。
    expect(persisted(outcome)).toEqual({
      code: "upstream_preview_read_failed",
      message: "MoboReader Preview read failed",
      detail: detailOf(outcome),
    });

    // 同一件事的结构化日志：多出长度 / 章节编号 / 书的业务编号，仍无正文。
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcomeCode: "upstream_preview_read_failed",
      kind: "chapter_content_invalid",
      stage: "getchapterinfo",
      retryable: false,
      valueLength: 0,
      chapterId: "c-1",
      taskId: TASK_ID,
      itemId: ITEM_ID,
      novelId: NOVEL_ID,
      novelSourceItemId: SOURCE_ID,
      seriesId: "series-1",
      dataId: "series-1",
      agencyId: "7",
      language: "1",
      mode: "apply",
      attempt: 1,
    });
  });

  it("getbydataid 阶段失败：stage 与 code 对应素材读取，且不再去读 getchapterinfo", async () => {
    const diagnostic: MoboreaderFailureDiagnostic = { kind: "data_not_object", receivedType: "null" };
    const { outcome, adapter } = await run({
      fetchBookMaterial: vi.fn(async () => { throw new MoboreaderAdapterError("malformed_payload", false, null, null, diagnostic); }),
    });
    expect(outcome.error).toMatchObject({ code: "upstream_material_read_failed", message: "MoboReader material read failed" });
    expect(detailOf(outcome)).toEqual({
      kind: "data_not_object",
      stage: "getbydataid",
      errorClass: "MoboreaderAdapterError",
      adapterCode: "malformed_payload",
      receivedType: "null",
    });
    expect(adapter.fetchPreviewChapters).not.toHaveBeenCalled();
  });

  it("dry_run 同样记录类别，仍不带 protectedWrite", async () => {
    const { outcome } = await run({
      fetchPreviewChapters: vi.fn(async () => parsePreviewChaptersResponse(chapterBody("nope"))),
    }, { mode: "dry_run" });
    expect(outcome.status).toBe("failed");
    expect(detailOf(outcome)).toMatchObject({ kind: "chapter_list_not_array", receivedType: "string" });
    expect(outcome.protectedWrite).toBeUndefined();
  });

  /** 每一条 adapter 校验都能从条目 error 上读出来（真走解析器，不手写 diagnostic）。 */
  it.each([
    ["envelope 不是对象", null, { kind: "envelope_not_object", receivedType: "null" }],
    ["data 缺失", {}, { kind: "data_not_object", receivedType: "undefined" }],
    ["chapterList 缺失", { data: { bookId: "b", currentLanguage: 1 } }, { kind: "chapter_list_not_array", receivedType: "undefined" }],
    ["行不是对象", chapterBody([chapterRow(), 5]), { kind: "chapter_row_not_object", receivedType: "integer", chapterIndex: 1, chapterCount: 2 }],
    ["i 不是整数", chapterBody([chapterRow({ i: "1" })]), { kind: "chapter_ordinal_invalid", receivedType: "string", chapterIndex: 0 }],
    ["i 为 0", chapterBody([chapterRow({ i: 0 })]), { kind: "chapter_ordinal_below_one", chapterOrdinal: 0 }],
    ["chapterID 为 null", chapterBody([chapterRow({ chapterID: null })]), { kind: "chapter_id_invalid", receivedType: "null", chapterOrdinal: 1 }],
    ["正文缺失", chapterBody([chapterRow({ chapterContent: undefined })]), { kind: "chapter_content_invalid", receivedType: "undefined" }],
    ["正文为 null", chapterBody([chapterRow({ chapterContent: null })]), { kind: "chapter_content_invalid", receivedType: "null" }],
    ["正文只有空白", chapterBody([chapterRow({ chapterContent: "  \n " })]), { kind: "chapter_content_invalid", receivedType: "blank_string" }],
    ["章节身份重复", chapterBody([chapterRow(), chapterRow()]), { kind: "chapter_identity_duplicate", chapterIndex: 1, chapterOrdinal: 1 }],
    ["bookId 为 null", { data: { bookId: null, currentLanguage: 1, chapterList: [chapterRow()] } }, { kind: "book_id_invalid", receivedType: "null" }],
    ["currentLanguage 缺失", { data: { bookId: "b", chapterList: [chapterRow()] } }, { kind: "current_language_invalid", receivedType: "undefined" }],
  ] as Array<[string, unknown, Record<string, unknown>]>)("getchapterinfo 校验：%s", async (_label, payload, expected) => {
    const { outcome } = await run({ fetchPreviewChapters: vi.fn(async () => parsePreviewChaptersResponse(payload)) });
    expect(outcome.error).toMatchObject({ code: "upstream_preview_read_failed" });
    expect(detailOf(outcome)).toMatchObject({ stage: "getchapterinfo", errorClass: "MoboreaderAdapterError", adapterCode: "malformed_payload", ...expected });
  });

  it.each([
    ["传输失败", () => new MoboreaderAdapterError("transport_error", true), { kind: "transport_error", adapterCode: "transport_error" }],
    ["请求超时", () => new MoboreaderAdapterError("request_timeout", true), { kind: "request_timeout", adapterCode: "request_timeout" }],
    ["HTTP 503", () => new MoboreaderAdapterError("upstream_http_error", true, 503), { kind: "http_status", adapterCode: "upstream_http_error", httpStatus: 503 }],
    ["HTTP 401", () => new MoboreaderAdapterError("upstream_http_error", false, 401), { kind: "http_status", httpStatus: 401 }],
    ["200 但不是 JSON", () => new MoboreaderAdapterError("malformed_payload", false, 200, null, { kind: "body_not_json" }), { kind: "body_not_json", httpStatus: 200 }],
    ["没有 diagnostic 的 malformed_payload", () => new MoboreaderAdapterError("malformed_payload", false), { kind: "malformed_unspecified", adapterCode: "malformed_payload" }],
    ["限流用尽", () => new MoboreaderRateLimitedError({ status: 429, retryAfterMs: 1000, pageIndex: null, endpoint: "/api/v1/res/getchapterinfo", attempts: 4, elapsedMs: 31_000, reason: "max_attempts" }), { kind: "rate_limited", errorClass: "MoboreaderRateLimitedError", httpStatus: 429, attempts: 4, limitReason: "max_attempts" }],
    ["非 adapter 异常（TypeError）", () => new TypeError("boom"), { kind: "unclassified_error", errorClass: "TypeError" }],
    ["带 errno 的异常", () => Object.assign(new Error("reset"), { code: "ECONNRESET" }), { kind: "unclassified_error", errorClass: "Error", errorCode: "ECONNRESET" }],
  ] as Array<[string, () => unknown, Record<string, unknown>]>)("传输 / 其它：%s", async (_label, make, expected) => {
    const { outcome } = await run({ fetchPreviewChapters: vi.fn(async () => { throw make(); }) });
    expect(outcome.error).toMatchObject({ code: "upstream_preview_read_failed" });
    expect(detailOf(outcome)).toMatchObject({ stage: "getchapterinfo", ...expected });
  });

  it("词表自洽：每个 kind 在字段全满的最坏情形下 detail 仍不超过 8 个键，落库时一个都不丢", () => {
    const full: MoboreaderFailureDiagnostic = {
      kind: "chapter_content_invalid",
      receivedType: "integer",
      valueLength: 3,
      chapterIndex: 4,
      chapterOrdinal: 5,
      chapterId: "c-5",
      chapterCount: 9,
    };
    const errors: unknown[] = [
      ...MOBOREADER_PARSE_FAILURE_KINDS.map((kind) => new MoboreaderAdapterError("malformed_payload", false, 200, null, { ...full, kind })),
      new MoboreaderAdapterError("malformed_payload", false),
      new MoboreaderAdapterError("transport_error", true),
      new MoboreaderAdapterError("request_timeout", true),
      new MoboreaderAdapterError("upstream_http_error", true, 503),
      new MoboreaderRateLimitedError({ status: 503, retryAfterMs: 9, pageIndex: null, endpoint: "x", attempts: 4, elapsedMs: 9, reason: "budget_exhausted" }),
      Object.assign(new TypeError("t"), { code: "ERR_X" }),
      "a thrown string",
    ];
    const seen = new Set<string>();
    for (const error of errors) {
      const report = describePreviewReadFailure(error, "getchapterinfo");
      seen.add(report.kind);
      expect(Object.keys(report.detail).length).toBeLessThanOrEqual(8);
      const stored = sanitizePersistedTaskError({ code: "upstream_preview_read_failed", message: "m", detail: report.detail });
      expect(stored.detail).toEqual(report.detail);
    }
    // 词表里的每个 kind 都至少被上面这组错误产出过一次（没有死 kind）。
    expect([...PREVIEW_READ_FAILURE_KINDS].filter((kind) => !seen.has(kind))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 脱敏：错误信息里带了正文，记录下来的内容也不含它
// ---------------------------------------------------------------------------

describe("试读读取失败：记录内容不含正文（B-36 脱敏）", () => {
  /** 条目 error（含落库投影）与全部日志事件合在一起，整体不许出现正文。 */
  function everythingRecorded(outcome: { error?: unknown }, events: unknown[]): string {
    return JSON.stringify([outcome.error, persisted(outcome), events]);
  }

  it("adapter 错误的 message / detail 文本里带了正文：类别照记，正文一个字都不进去", async () => {
    const error = new MoboreaderAdapterError(
      "malformed_payload",
      false,
      null,
      `chapterContent: expected non-empty, got "${BODY}"`,
      { kind: "chapter_content_invalid", receivedType: "blank_string", chapterIndex: 0, chapterOrdinal: 1, chapterCount: 1 },
    );
    expect(error.message).toContain(BODY); // 前提：错误对象本身确实带着正文
    const { outcome, events } = await run({ fetchPreviewChapters: vi.fn(async () => { throw error; }) });

    expect(detailOf(outcome)).toMatchObject({ kind: "chapter_content_invalid", receivedType: "blank_string" });
    expect(everythingRecorded(outcome, events)).not.toContain(BODY);
    expect(everythingRecorded(outcome, events)).not.toContain("expected non-empty");
  });

  it("JSON.parse 风格的 SyntaxError（消息里引用了响应正文）：只记类名，不记消息", async () => {
    const error = new SyntaxError(`Unexpected token 'C', "${BODY}" is not valid JSON`);
    const { outcome, events } = await run({ fetchPreviewChapters: vi.fn(async () => { throw error; }) });
    expect(detailOf(outcome)).toEqual({ kind: "unclassified_error", stage: "getchapterinfo", errorClass: "SyntaxError" });
    expect(everythingRecorded(outcome, events)).not.toContain(BODY);
  });

  it("直接 throw 一个字符串（正文）：不是 Error，记为 NonError", async () => {
    const { outcome, events } = await run({ fetchPreviewChapters: vi.fn(async () => { throw BODY; }) });
    expect(detailOf(outcome)).toEqual({ kind: "unclassified_error", stage: "getchapterinfo", errorClass: "NonError" });
    expect(everythingRecorded(outcome, events)).not.toContain(BODY);
  });

  it("伪造的 diagnostic 字段（词表外的 kind、非整数位置、带空格的 chapterId）：全部丢弃，不转义不截断", async () => {
    const forged = {
      kind: `${BODY} as a kind`,
      receivedType: BODY,
      valueLength: BODY,
      chapterIndex: BODY,
      chapterOrdinal: -1,
      chapterId: `${BODY} with spaces`,
      chapterCount: 1.5,
    } as unknown as MoboreaderFailureDiagnostic;
    const { outcome, events } = await run({
      fetchPreviewChapters: vi.fn(async () => { throw new MoboreaderAdapterError("malformed_payload", false, null, null, forged); }),
    });
    expect(detailOf(outcome)).toEqual({
      kind: "malformed_unspecified",
      stage: "getchapterinfo",
      errorClass: "MoboreaderAdapterError",
      adapterCode: "malformed_payload",
    });
    expect(everythingRecorded(outcome, events)).not.toContain(BODY);
    expect(events[0]).not.toHaveProperty("chapterId");
  });

  it("非 malformed_payload 的错误即使挂了 diagnostic 也不采信", () => {
    const error = new MoboreaderAdapterError("transport_error", true, null, null, { kind: "chapter_content_invalid", chapterIndex: 3 });
    const report = describePreviewReadFailure(error, "getchapterinfo");
    expect(report.detail).toEqual({ kind: "transport_error", stage: "getchapterinfo", errorClass: "MoboreaderAdapterError", adapterCode: "transport_error" });
  });

  it("类名 / errno code 里夹带文本：回落到 Error 且不记 errorCode", () => {
    class Hostile extends Error {}
    Object.defineProperty(Hostile, "name", { value: `${BODY} class` });
    const error = Object.assign(new Hostile("x"), { code: `${BODY} code` });
    error.name = `${BODY} name`;
    const report = describePreviewReadFailure(error, "getchapterinfo");
    expect(report.detail).toEqual({ kind: "unclassified_error", stage: "getchapterinfo", errorClass: "Error" });
    expect(JSON.stringify(report)).not.toContain(BODY);
  });

  it("书的业务编号只在合乎标识符形状时才进日志", () => {
    const report = describePreviewReadFailure(new TypeError("t"), "getchapterinfo");
    const context: PreviewReadFailureContext = {
      taskId: TASK_ID,
      itemId: `${BODY} item`,
      mode: "apply",
      attempt: 1,
      novelId: NOVEL_ID,
      novelSourceItemId: SOURCE_ID,
      seriesId: `${BODY} series`,
      dataId: 123456,
      agencyId: "7",
      language: "x".repeat(200),
    };
    const event = buildPreviewReadFailureLogEvent(report, "upstream_preview_read_failed", context);
    expect(event).toMatchObject({ taskId: TASK_ID, novelId: NOVEL_ID, dataId: "123456", agencyId: "7", mode: "apply", attempt: 1 });
    expect(event.itemId).toBeUndefined();
    expect(event.seriesId).toBeUndefined();
    expect(event.language).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(BODY);
  });

  it("真实解析器报的错：位置信息是数字，章节 id 是 id，正文只在上游响应里、不在任何记录里", async () => {
    const { outcome, events } = await run({
      fetchPreviewChapters: vi.fn(async () => parsePreviewChaptersResponse(chapterBody([chapterRow({ chapterContent: "   " })]))),
    });
    expect(detailOf(outcome)).toMatchObject({ kind: "chapter_content_invalid", receivedType: "blank_string", chapterIndex: 0, chapterOrdinal: 1 });
    expect(events[0]).toMatchObject({ valueLength: 3, chapterId: "c-1" });
    expect(everythingRecorded(outcome, events)).not.toContain(BODY);
  });
});

// ---------------------------------------------------------------------------
// 3. 兼容
// ---------------------------------------------------------------------------

describe("试读读取失败：对外兼容（B-36）", () => {
  it("后台任务页的展示不变：detail 不会被投影出来，文案与没有 detail 时逐字相同", async () => {
    const { outcome } = await run({
      fetchPreviewChapters: vi.fn(async () => parsePreviewChaptersResponse(chapterBody([chapterRow({ chapterContent: "" })]))),
    });
    const withDetail = projectSafeTaskFailure(persisted(outcome));
    const legacyShape = projectSafeTaskFailure({ code: "upstream_preview_read_failed", message: "MoboReader Preview read failed" });
    expect(withDetail).toEqual(legacyShape);
    expect(safeTaskFailureText(withDetail)).toBe("上游预览读取失败（upstream_preview_read_failed）");
    expect(JSON.stringify(withDetail)).not.toContain("chapter_content_invalid");

    const material = projectSafeTaskFailure({ code: "upstream_material_read_failed", message: "m", detail: { kind: "data_not_object", stage: "getbydataid" } });
    expect(safeTaskFailureText(material)).toBe("上游素材读取失败（upstream_material_read_failed）");
  });

  it("日志 sink 抛错不改变条目结果", async () => {
    const throwing = () => { throw new Error("log pipe closed"); };
    const { outcome } = await run({
      fetchPreviewChapters: vi.fn(async () => { throw new MoboreaderAdapterError("transport_error", true); }),
    }, { sink: throwing });
    expect(outcome.status).toBe("failed");
    expect(detailOf(outcome)).toMatchObject({ kind: "transport_error" });
  });

  it("未注入 sink 时走生产默认：stderr 一行 JSON（schemaVersion/event/kind），可被 JSON.parse", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => { lines.push(String(line)); });
    await run({
      fetchPreviewChapters: vi.fn(async () => parsePreviewChaptersResponse(chapterBody([chapterRow({ chapterContent: "" })]))),
    }, { sink: null });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ schemaVersion: 1, event: "preview_read_failed", kind: "chapter_content_invalid", stage: "getchapterinfo", seriesId: "series-1" });
    expect(lines[0]).not.toContain(BODY);
  });

  it("logPreviewReadFailure 自己永不抛错（console 坏了也一样）", () => {
    vi.spyOn(console, "error").mockImplementation(() => { throw new Error("stderr closed"); });
    expect(() => logPreviewReadFailure({ kind: "transport_error", stage: "getchapterinfo", errorClass: "X", outcomeCode: "upstream_preview_read_failed" })).not.toThrow();
  });

  it("成功路径与空试读路径不受影响：不调用 sink", async () => {
    const calls: unknown[] = [];
    const empty = await run({}, { sink: (event) => { calls.push(event); } });
    expect(empty.outcome).toMatchObject({ status: "skipped", result: { reason: "upstream_empty_preview" } });
    expect(calls).toHaveLength(0);
  });
});
