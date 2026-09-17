import { describe, expect, it, vi } from "vitest";
import {
  confirmSideEffectIntentByReadbackInTransaction,
  isAllowedSideEffectTransition,
  isReadbackConfirmableStatus,
} from "@/lib/tasks";

function fakeTx(row: { id: string; effectKey: string; status: string; responseShape: unknown }) {
  const findUnique = vi.fn(async () => ({ ...row }));
  const updateMany = vi.fn(async (args: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
    if (args.where.id !== row.id || args.where.status !== row.status) return { count: 0 };
    Object.assign(row, args.data);
    return { count: 1 };
  });
  return {
    tx: {
      sideEffectIntent: {
        findUnique,
        updateMany,
        findUniqueOrThrow: vi.fn(async () => ({ ...row })),
      },
    } as never,
    findUnique,
    updateMany,
  };
}

describe("P1-07 side-effect intent state boundary", () => {
  it("generic worker graph: prepared may reach confirmed, failed or claim_retry_blocked", () => {
    expect(isAllowedSideEffectTransition("prepared", "confirmed")).toBe(true);
    expect(isAllowedSideEffectTransition("prepared", "failed")).toBe(true);
    expect(isAllowedSideEffectTransition("prepared", "claim_retry_blocked")).toBe(true);
  });

  it("generic worker graph: an unknown outcome can only be handed to manual review", () => {
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "manual_review_required")).toBe(true);
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "confirmed")).toBe(false);
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "failed")).toBe(false);
    expect(isAllowedSideEffectTransition("claim_retry_blocked", "claim_retry_blocked")).toBe(false);
  });

  it("generic worker graph: manual_review_required, confirmed and failed are terminal", () => {
    const nexts = ["confirmed", "failed", "claim_retry_blocked", "manual_review_required"] as const;
    for (const current of ["manual_review_required", "confirmed", "failed"] as const) {
      for (const next of nexts) {
        expect(isAllowedSideEffectTransition(current, next)).toBe(false);
      }
    }
  });

  it("readback boundary: only prepared and claim_retry_blocked are readback-confirmable", () => {
    expect(isReadbackConfirmableStatus("prepared")).toBe(true);
    expect(isReadbackConfirmableStatus("claim_retry_blocked")).toBe(true);
    expect(isReadbackConfirmableStatus("manual_review_required")).toBe(false);
    expect(isReadbackConfirmableStatus("confirmed")).toBe(false);
    expect(isReadbackConfirmableStatus("failed")).toBe(false);
    expect(isReadbackConfirmableStatus("")).toBe(false);
  });

  it("readback boundary: confirms a blocked intent, merges the ambiguity evidence and stamps confirmedAt", async () => {
    const row = {
      id: "intent-1",
      effectKey: "a".repeat(64),
      status: "claim_retry_blocked",
      responseShape: { failureCategory: "upstream_timeout", readbackConfirmed: false, readbackStatus: "missing" },
    };
    const { tx, updateMany } = fakeTx(row);
    const result = await confirmSideEffectIntentByReadbackInTransaction(tx, {
      effectKey: row.effectKey,
      evidence: { hasWebUrl: true, hasAppUrl: false },
    });
    expect(result.status).toBe("confirmed");
    expect(result.responseShape).toMatchObject({
      failureCategory: "upstream_timeout",
      readbackStatus: "missing",
      source: "readback",
      confirmedFrom: "claim_retry_blocked",
      hasWebUrl: true,
      hasAppUrl: false,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "intent-1", status: "claim_retry_blocked" });
    expect(updateMany.mock.calls[0][0].data.confirmedAt).toBeInstanceOf(Date);
  });

  it("readback boundary: also confirms a prepared intent and records confirmedFrom=prepared", async () => {
    const row = {
      id: "intent-2",
      effectKey: "b".repeat(64),
      status: "prepared",
      responseShape: null,
    };
    const { tx, updateMany } = fakeTx(row);
    const result = await confirmSideEffectIntentByReadbackInTransaction(tx, {
      effectKey: row.effectKey,
      evidence: { hasWebUrl: true, hasAppUrl: true },
    });
    expect(result.status).toBe("confirmed");
    expect(result.responseShape).toMatchObject({
      source: "readback",
      confirmedFrom: "prepared",
      hasWebUrl: true,
      hasAppUrl: true,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "intent-2", status: "prepared" });
  });

  it.each(["manual_review_required", "confirmed", "failed"] as const)(
    "readback boundary: refuses to leave %s",
    async (status) => {
      const row = { id: "intent-3", effectKey: "c".repeat(64), status, responseShape: null };
      const { tx, updateMany } = fakeTx(row);
      await expect(
        confirmSideEffectIntentByReadbackInTransaction(tx, {
          effectKey: row.effectKey,
          evidence: { hasWebUrl: true, hasAppUrl: true },
        }),
      ).rejects.toThrow(`Illegal side-effect readback confirmation: ${status} -> confirmed`);
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("readback boundary: refuses without well-formed evidence", async () => {
    const row = { id: "intent-4", effectKey: "d".repeat(64), status: "prepared", responseShape: null };
    const badEvidences = [undefined, {}, { hasWebUrl: "yes", hasAppUrl: true }] as const;
    for (const evidence of badEvidences) {
      const { tx, findUnique, updateMany } = fakeTx({ ...row });
      await expect(
        confirmSideEffectIntentByReadbackInTransaction(tx, {
          effectKey: row.effectKey,
          evidence: evidence as never,
        }),
      ).rejects.toThrow("Readback evidence is required");
      expect(findUnique).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("readback boundary: rejects a lost CAS race", async () => {
    const row = { id: "intent-5", effectKey: "e".repeat(64), status: "prepared", responseShape: null };
    const { tx, updateMany } = fakeTx(row);
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      confirmSideEffectIntentByReadbackInTransaction(tx, {
        effectKey: row.effectKey,
        evidence: { hasWebUrl: true, hasAppUrl: true },
      }),
    ).rejects.toThrow("Concurrent side-effect transition rejected: prepared -> confirmed");
  });

  it("readback boundary: unknown effect key", async () => {
    const tx = {
      sideEffectIntent: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(),
        findUniqueOrThrow: vi.fn(),
      },
    } as never;
    await expect(
      confirmSideEffectIntentByReadbackInTransaction(tx, {
        effectKey: "f".repeat(64),
        evidence: { hasWebUrl: true, hasAppUrl: true },
      }),
    ).rejects.toThrow("Side-effect intent not found");
  });
});
