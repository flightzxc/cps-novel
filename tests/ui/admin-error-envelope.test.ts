import { describe, expect, it } from "vitest";

import type { AdminErrorCode } from "@/contracts";
import { AdminContentNotFoundError, toErrorEnvelope } from "@/app/api/admin/_lib/respond";
import { handleTaskAdmin } from "@/app/api/admin/_lib/task-admin-route";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { AdminAccessError } from "@/lib/auth/errors";
import { CredentialLifecycleError } from "@/lib/credentials/lifecycle";
import { AdminContentQueryError } from "@/server/admin-content";
import {
  CredentialReplacementIdempotencyConflictError,
  CredentialTaskNotFoundError,
} from "@/server/credentials/service";
import {
  SiteSettingMutationConflictError,
  SiteSettingNotSeededError,
  SiteSettingValidationError,
} from "@/server/site-settings/service";
import { TaskAdminError, type TaskAdminErrorCode } from "@/server/task-admin";

/**
 * PR-C6a — closes two custodian-review gaps in the error boundary:
 *
 * 1. `toErrorEnvelope`'s catch-all used to coerce every unrecognised error to
 *    `admin_capability_denied` / 403 — a permission-denial code for a failure
 *    that has nothing to do with permissions. It now projects
 *    `admin_internal_error` / 500 instead.
 * 2. `task-admin-route.ts` hand-rolled `Response.json({ ok: false, ... })`
 *    rather than going through `projectErrorEnvelope`, and its eight
 *    `task_admin_*` codes were not part of `AdminErrorCode`, so the frontend
 *    had no copy for them and they were invisible to the shared contract.
 *
 * This file covers both fixes plus non-regression for every error category
 * `toErrorEnvelope` already handled before this PR.
 */

describe("toErrorEnvelope — unrecognised errors no longer read as a permission denial", () => {
  it("projects an unknown Error as admin_internal_error / 500", () => {
    const envelope = toErrorEnvelope(new Error("driver exploded"));
    expect(envelope).toEqual({ ok: false, status: 500, code: "admin_internal_error" });
  });

  it("does not leak the original message onto the envelope", () => {
    const envelope = toErrorEnvelope(new TypeError("Cannot read properties of undefined"));
    expect(envelope.code).toBe("admin_internal_error");
    expect(JSON.stringify(envelope)).not.toContain("Cannot read properties");
  });

  it("also collapses a non-Error throw the same way", () => {
    expect(toErrorEnvelope("boom")).toEqual({ ok: false, status: 500, code: "admin_internal_error" });
  });
});

describe("toErrorEnvelope — every existing category is unaffected", () => {
  it("AdminAccessError passes its own code/status/details through", () => {
    const error = new AdminAccessError("admin_capability_denied", 403, "denied", {
      capability: "credential:manage",
    });
    expect(toErrorEnvelope(error)).toEqual({
      ok: false,
      status: 403,
      code: "admin_capability_denied",
      details: { capability: "credential:manage" },
    });
  });

  it("projects the 2FA setup requirement as its own 403 without a server message", () => {
    const envelope = toErrorEnvelope(
      new AdminAccessError(
        "admin_two_factor_setup_required",
        403,
        "server-only setup detail",
      ),
    );
    expect(envelope).toEqual({
      ok: false,
      status: 403,
      code: "admin_two_factor_setup_required",
    });
    expect(JSON.stringify(envelope)).not.toContain("server-only setup detail");
    expect(errorEnvelopeCopy(envelope)).toBe("请先完成双重验证设置，再继续操作");
  });

  it("AdminContentNotFoundError keeps its 404", () => {
    expect(toErrorEnvelope(new AdminContentNotFoundError("novel"))).toEqual({
      ok: false,
      status: 404,
      code: "admin_content_not_found",
    });
  });

  it("AdminContentQueryError keeps its 400, except invalid_read_context which becomes 403", () => {
    expect(toErrorEnvelope(new AdminContentQueryError("invalid_page", "bad page"))).toEqual({
      ok: false,
      status: 400,
      code: "invalid_page",
    });
    expect(
      toErrorEnvelope(new AdminContentQueryError("invalid_read_context", "wired wrong")),
    ).toEqual({
      ok: false,
      status: 403,
      code: "admin_service_authorization_required",
    });
  });

  it("CredentialTaskNotFoundError keeps its 404", () => {
    expect(toErrorEnvelope(new CredentialTaskNotFoundError())).toEqual({
      ok: false,
      status: 404,
      code: "credential_task_not_found",
    });
  });

  it("CredentialReplacementIdempotencyConflictError keeps its 409 + reason detail", () => {
    expect(toErrorEnvelope(new CredentialReplacementIdempotencyConflictError())).toEqual({
      ok: false,
      status: 409,
      code: "admin_mutation_request_id_invalid",
      details: { reason: "idempotency_conflict" },
    });
  });

  it("SiteSetting errors keep their statuses", () => {
    expect(toErrorEnvelope(new SiteSettingValidationError("bad"))).toEqual({
      ok: false,
      status: 400,
      code: "site_setting_invalid",
    });
    expect(toErrorEnvelope(new SiteSettingNotSeededError())).toEqual({
      ok: false,
      status: 500,
      code: "site_setting_not_seeded",
    });
    expect(toErrorEnvelope(new SiteSettingMutationConflictError(true))).toEqual({
      ok: false,
      status: 409,
      code: "site_setting_conflict",
      details: { reason: "idempotency_conflict" },
    });
    expect(toErrorEnvelope(new SiteSettingMutationConflictError(false))).toEqual({
      ok: false,
      status: 409,
      code: "site_setting_conflict",
    });
  });

  it("CredentialLifecycleError still maps through the fixed code→status table", () => {
    expect(toErrorEnvelope(new CredentialLifecycleError("account_inactive", "inactive"))).toEqual({
      ok: false,
      status: 409,
      code: "account_inactive",
    });
    expect(
      toErrorEnvelope(new CredentialLifecycleError("credential_missing", "missing")),
    ).toEqual({
      ok: false,
      status: 404,
      code: "credential_missing",
    });
  });
});

describe("error copy — new codes are never the generic fallback sentence", () => {
  const FALLBACK = "操作失败，请稍后重试";

  it("gives admin_internal_error copy distinct from admin_capability_denied", () => {
    const internal = errorEnvelopeCopy({ ok: false, status: 500, code: "admin_internal_error" });
    const denied = errorEnvelopeCopy({ ok: false, status: 403, code: "admin_capability_denied" });
    expect(internal).not.toBe(FALLBACK);
    expect(internal).not.toBe(denied);
  });

  it("gives every task_admin_* code its own, non-fallback copy", () => {
    const codes: readonly AdminErrorCode[] = [
      "task_admin_invalid_request",
      "task_admin_not_found",
      "task_admin_state_conflict",
      "task_admin_idempotency_conflict",
      "task_admin_unresolved_intent",
      "task_admin_concurrent_write",
      "task_admin_active_scope_conflict",
      "task_admin_internal_error",
    ];
    const texts = codes.map((code) => errorEnvelopeCopy({ ok: false, status: 500, code }));
    for (const [index, text] of texts.entries()) {
      expect(text, `${codes[index]} needs copy`).not.toBe(FALLBACK);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("gives actionable guidance for an unresolved manual review, not just a status word", () => {
    const text = errorEnvelopeCopy({
      ok: false,
      status: 409,
      code: "task_admin_unresolved_intent",
    });
    expect(text).toContain("人工审查");
  });
});

describe("handleTaskAdmin — routes through the shared envelope projector", () => {
  const CONFLICT_CODES: readonly TaskAdminErrorCode[] = [
    "task_admin_state_conflict",
    "task_admin_idempotency_conflict",
    "task_admin_unresolved_intent",
    "task_admin_concurrent_write",
    "task_admin_active_scope_conflict",
  ];

  it("projects task_admin_invalid_request at 400", async () => {
    const response = await handleTaskAdmin(async () => {
      throw new TaskAdminError("task_admin_invalid_request", 400);
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: 400,
      code: "task_admin_invalid_request",
    });
  });

  it("projects task_admin_not_found at 404", async () => {
    const response = await handleTaskAdmin(async () => {
      throw new TaskAdminError("task_admin_not_found", 404);
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: 404,
      code: "task_admin_not_found",
    });
  });

  it.each(CONFLICT_CODES)("projects %s at 409", async (code) => {
    const response = await handleTaskAdmin(async () => {
      throw new TaskAdminError(code, 409);
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, status: 409, code });
  });

  it("maps an unrecognised error to task_admin_internal_error / 500 — distinct from the generic admin_internal_error boundary", async () => {
    const response = await handleTaskAdmin(async () => {
      throw new Error("db exploded");
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: 500,
      code: "task_admin_internal_error",
    });
  });

  it("still passes an AdminAccessError through unchanged", async () => {
    const response = await handleTaskAdmin(async () => {
      throw new AdminAccessError("admin_two_factor_required", 403, "needs 2fa");
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      status: 403,
      code: "admin_two_factor_required",
    });
  });

  it("keeps the ok:true success shape untouched", async () => {
    const response = await handleTaskAdmin(async () => ({ items: [] as const }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { items: [] } });
  });
});
