/**
 * P0-S6: an audited maintenance entry point for `ChannelCapability.status`.
 *
 * Background (see `docs/governance/database-governance.md` §3.1 and the
 * machine dictionary entry for `channel_capability:status`): every capability
 * defaults to `registered_disabled`, and the claim/sync SQL that pulls
 * credentials hard-requires `status = 'enabled'`. Before this module, no code
 * path anywhere in the repo could ever move a row out of
 * `registered_disabled` — there was no seed, no UI, no script. That made the
 * claim chain permanently un-runnable, independent of any other bug.
 *
 * This module intentionally does exactly one narrow thing: flip an
 * *already-registered* capability between `registered_disabled` and
 * `enabled`. It does not create capabilities and does not touch
 * `evidence_level`/`reason_code`/`enabled_gate`/`config` — registering a new
 * capability key (with real evidence about the external contract) is a
 * separate, not-yet-built process
 * ("登记动作属于有证据时的另一个流程" — Owner decision, P0 batch 1 S6 task).
 * `evidence_level` in particular is a controlled classification of the
 * capability's *contract* evidence tier (e.g.
 * `READ_ONLY_PRODUCTION_READ_PROVEN`), not a free-text pointer to a specific
 * enable event — reusing it here would conflate two different kinds of
 * "evidence" under one column. The free-text evidence reference this module
 * requires for `enabled` lives in `OperationAudit.afterSnapshot` instead
 * (see `setChannelCapabilityStatus` below) — it is about *this specific
 * status change*, not the capability's registration.
 *
 * Two callers, one audit trail:
 *  - `scripts/set-channel-capability-status.ts` — the only caller today.
 *    Runs as `actor.type === "system"`, bypassing the admin session/2FA
 *    check (there is no browser session for a terminal script) but not the
 *    `reason`/`evidenceRef` validation or the `OperationAudit` write below.
 *  - A future admin UI screen — not built yet ("受审计脚本先行，管理界面
 *    后补" — Owner decision). When it ships, its Server Action must build a
 *    real `AdminAuthContext` via `src/server/auth/guards.ts` (full session +
 *    `credential:manage` capability + mandatory 2FA, exactly like
 *    `src/server/credentials/service.ts`'s mutations) and call this function
 *    with `actor.type === "admin"`. Nothing about this module's write path
 *    changes for that caller — only `enforceActor` takes a different branch.
 */
import type { PrismaClient } from "@prisma/client";

import { requireHighRiskAdminCapability } from "@/lib/auth/capabilities";
import type { AdminAuthContext } from "@/lib/auth/types";
import { withDbRetry } from "@/lib/db/db-retry";

/** The only two statuses this module will ever move a row between. `registered_partial` is a valid DB status (see `channel_capability_status_check`) but is out of this narrow toggle's scope — registering a partial-evidence capability is part of the not-yet-built registration flow, not a status flip. */
export const CHANNEL_CAPABILITY_TOGGLE_STATUSES = ["registered_disabled", "enabled"] as const;
export type ChannelCapabilityToggleStatus = (typeof CHANNEL_CAPABILITY_TOGGLE_STATUSES)[number];

function isToggleStatus(value: string): value is ChannelCapabilityToggleStatus {
  return (CHANNEL_CAPABILITY_TOGGLE_STATUSES as readonly string[]).includes(value);
}

/**
 * Who is asking.
 *
 * - `"admin"` carries a real, guard-validated `AdminAuthContext` — the
 *   future UI path. Enforced via `requireHighRiskAdminCapability` at the
 *   `credential:manage` level, same bar as credential rotation (session +
 *   role/allowlist + mandatory 2FA).
 * - `"system"` is the audited CLI break-glass path. It carries only an
 *   operator id (read from the environment by the CLI, which refuses to run
 *   at all if that id is missing — see the script). There is no session to
 *   validate, so `enforceActor` only checks the id is non-blank; it is the
 *   CLI's job, not this function's, to make sure a human operator identity
 *   is actually behind that id. This branch must never be constructed from
 *   a network-facing handler — only from the CLI entrypoint.
 */
export type ChannelCapabilityStatusActor =
  | { readonly type: "admin"; readonly context: AdminAuthContext }
  | { readonly type: "system"; readonly actorId: string };

export type ChannelCapabilityStatusErrorCode =
  | "system_actor_id_required"
  | "capability_not_found"
  | "invalid_target_status"
  | "current_status_not_eligible"
  | "reason_required"
  | "evidence_required";

export class ChannelCapabilityStatusError extends Error {
  readonly code: ChannelCapabilityStatusErrorCode;

  constructor(code: ChannelCapabilityStatusErrorCode, message: string) {
    super(message);
    this.name = "ChannelCapabilityStatusError";
    this.code = code;
  }
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function boundedText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export type ValidatedChannelCapabilityStatusRequest = {
  readonly targetStatus: ChannelCapabilityToggleStatus;
  readonly reason: string;
  /** Non-null only when `targetStatus === "enabled"`. */
  readonly evidenceRef: string | null;
};

/**
 * Pure (no I/O) validation of the request shape, shared by the real write
 * path below and the CLI's `--apply`-less dry-run preview so a dry-run
 * reliably tells the operator whether `--apply` would be rejected on these
 * grounds, before anything ever touches the database.
 *
 * Enforces the "证据先于启用" (evidence precedes enablement) discipline
 * from `docs/governance/database-governance.md` §1 in the function
 * signature itself: `evidenceRef` is required and non-blank whenever the
 * target is `enabled`. For any other target, whatever `input.evidenceRef`
 * was passed is silently discarded (`evidenceRef` is returned as `null`,
 * never read or validated) — not rejected/thrown — since an evidence
 * reference for a *disable* has no meaning here and there is no reason to
 * make that case an error.
 */
export function validateChannelCapabilityStatusRequest(input: {
  readonly targetStatus: string;
  readonly reason: string;
  readonly evidenceRef?: string | null;
}): ValidatedChannelCapabilityStatusRequest {
  if (!isToggleStatus(input.targetStatus)) {
    throw new ChannelCapabilityStatusError(
      "invalid_target_status",
      `targetStatus must be one of: ${CHANNEL_CAPABILITY_TOGGLE_STATUSES.join(", ")} (got "${input.targetStatus}")`,
    );
  }
  const reason = boundedText(normalizedText(input.reason), 1000);
  if (!reason) {
    throw new ChannelCapabilityStatusError("reason_required", "A reason is required");
  }

  let evidenceRef: string | null = null;
  if (input.targetStatus === "enabled") {
    evidenceRef = boundedText(normalizedText(input.evidenceRef), 500);
    if (!evidenceRef) {
      throw new ChannelCapabilityStatusError(
        "evidence_required",
        "An evidence reference (e.g. a smoke-test report filename or date) is required to enable a capability — " +
          "证据先于启用, docs/governance/database-governance.md §1",
      );
    }
  }

  return { targetStatus: input.targetStatus, reason, evidenceRef };
}

function auditActorType(actor: ChannelCapabilityStatusActor): "admin" | "system" {
  return actor.type;
}

function auditActorId(actor: ChannelCapabilityStatusActor): string {
  return actor.type === "admin" ? actor.context.identity.id : actor.actorId;
}

/**
 * Capability-check call site. See this module's header and the
 * `ChannelCapabilityStatusActor` doc comment above for the two branches.
 */
function enforceActor(actor: ChannelCapabilityStatusActor, env: NodeJS.ProcessEnv): void {
  if (actor.type === "admin") {
    requireHighRiskAdminCapability(actor.context, "credential:manage", env);
    return;
  }
  if (!normalizedText(actor.actorId)) {
    throw new ChannelCapabilityStatusError(
      "system_actor_id_required",
      "A system actor id is required (the CLI reads this from an operator environment variable and refuses to run without it)",
    );
  }
}

export type SetChannelCapabilityStatusInput = {
  readonly channelAppId: string;
  readonly capabilityKey: string;
  readonly targetStatus: string;
  readonly reason: string;
  readonly evidenceRef?: string | null;
  readonly requestId: string;
  readonly actor: ChannelCapabilityStatusActor;
};

export type ChannelCapabilityStatusResult = {
  readonly capabilityId: string;
  readonly channelAppId: string;
  readonly capabilityKey: string;
  readonly beforeStatus: string;
  readonly afterStatus: string;
  /** `false` only on an idempotent replay of an already-committed `requestId` — see the comment above the `existingAudit` read below. */
  readonly wrote: boolean;
  readonly auditId: string;
};

const CAPABILITY_STATUS_AUDIT_ACTION = "channel_capability.status.set";

/**
 * Flips an already-registered `ChannelCapability` row between
 * `registered_disabled` and `enabled`. Does not create rows, does not
 * register new capability keys, and never touches `evidence_level` /
 * `reason_code` / `enabled_gate` / `config` — see this module's header.
 *
 * Every real write happens in the same transaction as its `OperationAudit`
 * row (`docs/governance/database-governance.md` §1 / Owner 修正 4 — "写了
 * 业务必有审计"), carrying `before`/`after` status snapshots, the mandatory
 * `reason`, and — for an `enabled` target — the evidence reference, all
 * inside `afterSnapshot`.
 */
export async function setChannelCapabilityStatus(
  db: PrismaClient,
  input: SetChannelCapabilityStatusInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelCapabilityStatusResult> {
  enforceActor(input.actor, env);
  const validated = validateChannelCapabilityStatusRequest({
    targetStatus: input.targetStatus,
    reason: input.reason,
    evidenceRef: input.evidenceRef,
  });

  const actorType = auditActorType(input.actor);
  const actorId = auditActorId(input.actor);

  return withDbRetry(
    () =>
      db.$transaction(async (tx) => {
        // Idempotency check-then-insert — sequential-retry-safe only, NOT
        // concurrency-safe: `OperationAudit` carries no unique constraint on
        // (actorType, action, requestId), only a plain index
        // (`operation_audit_request_idx`) — see
        // `docs/governance/database-governance.md` §13 and the identical
        // caveat in `src/server/publish-gate/service.ts` /
        // `src/server/credentials/service.ts`. A retry after a genuine
        // network-timeout-then-retry is a safe no-op replay; two truly
        // concurrent calls with the same requestId are not this module's
        // problem to solve (single-operator CLI today, and the future admin
        // UI issues one `requestId` per guard-checked mutation attempt).
        const existingAudit = await tx.operationAudit.findFirst({
          where: { actorType, action: CAPABILITY_STATUS_AUDIT_ACTION, requestId: input.requestId },
        });
        if (existingAudit) {
          const replayed = await tx.channelCapability.findUnique({ where: { id: existingAudit.entityId } });
          if (!replayed) {
            throw new ChannelCapabilityStatusError(
              "capability_not_found",
              "Replayed requestId refers to a capability that no longer exists",
            );
          }
          const before = existingAudit.beforeSnapshot as { status?: string } | null;
          const after = existingAudit.afterSnapshot as { status?: string } | null;
          return {
            capabilityId: replayed.id,
            channelAppId: replayed.channelAppId,
            capabilityKey: replayed.capabilityKey,
            beforeStatus: before?.status ?? replayed.status,
            afterStatus: after?.status ?? replayed.status,
            wrote: false,
            auditId: existingAudit.id.toString(),
          };
        }

        const capability = await tx.channelCapability.findUnique({
          where: {
            channelAppId_capabilityKey: {
              channelAppId: input.channelAppId,
              capabilityKey: input.capabilityKey,
            },
          },
        });
        if (!capability) {
          throw new ChannelCapabilityStatusError(
            "capability_not_found",
            `No registered capability for channelAppId="${input.channelAppId}" capabilityKey="${input.capabilityKey}" ` +
              "— this function only toggles an already-registered capability; registering a new key is a separate process",
          );
        }
        // Defensive: a row already sitting in `registered_partial` (a valid
        // DB status this module never writes) is out of this narrow toggle's
        // scope — see `CHANNEL_CAPABILITY_TOGGLE_STATUSES`'s doc comment.
        if (!isToggleStatus(capability.status)) {
          throw new ChannelCapabilityStatusError(
            "current_status_not_eligible",
            `Current status "${capability.status}" is outside this toggle's scope ` +
              `(only ${CHANNEL_CAPABILITY_TOGGLE_STATUSES.join(" <-> ")})`,
          );
        }

        const beforeStatus = capability.status;
        // Plain `update` by primary key, not a TOCTOU-conditional
        // `updateMany` — mirrors `setChannelAccountStatus` in
        // `src/server/credentials/service.ts`, the closest existing sibling
        // (single-operator-driven enum status flip on a low-write-concurrency
        // row). If concurrent-write hardening is ever needed here, add the
        // same `updateMany` + `count === 1` precondition
        // `src/server/publish-gate/service.ts`'s `applyPublishTransition`
        // uses for the Article/Novel status race.
        const updated = await tx.channelCapability.update({
          where: { id: capability.id },
          data: { status: validated.targetStatus },
        });

        const audit = await tx.operationAudit.create({
          data: {
            actorType,
            actorId,
            action: CAPABILITY_STATUS_AUDIT_ACTION,
            entityType: "ChannelCapability",
            entityId: updated.id,
            requestId: input.requestId,
            reason: validated.reason,
            beforeSnapshot: { status: beforeStatus },
            afterSnapshot: { status: updated.status, evidenceRef: validated.evidenceRef },
          },
        });

        return {
          capabilityId: updated.id,
          channelAppId: updated.channelAppId,
          capabilityKey: updated.capabilityKey,
          beforeStatus,
          afterStatus: updated.status,
          wrote: true,
          auditId: audit.id.toString(),
        };
      }),
    { op: "channel-capability.setChannelCapabilityStatus", itemId: input.channelAppId, idempotencyKey: input.requestId },
  );
}
