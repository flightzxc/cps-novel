import type { ErrorEnvelope } from "@/contracts";

export type AdminFetchResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

function isEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    Boolean(value)
    && typeof value === "object"
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { code?: unknown }).code === "string"
  );
}

/**
 * Every admin mutation carries a fresh `x-request-id`.
 *
 * Fresh per call, not per form: the id is the idempotency key, and reusing it
 * across two different submissions is exactly what the backend rejects with
 * `idempotency_conflict`. A retry of the *same* submission should reuse it, so
 * callers that implement retry pass `requestId` explicitly.
 */
export async function adminFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; requestId?: string } = {},
): Promise<AdminFetchResult<T>> {
  const method = init.method ?? "GET";
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (mutation) headers["x-request-id"] = init.requestId ?? crypto.randomUUID();

  let payload: unknown;
  try {
    const response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    payload = await response.json();
  } catch {
    // A transport failure has no envelope; synthesise the closest stable code
    // rather than surfacing a fetch exception string to the operator.
    return {
      ok: false,
      envelope: { ok: false, status: 403, code: "admin_service_authorization_required" },
    };
  }

  if (isEnvelope(payload)) return { ok: false, envelope: payload };
  const data = (payload as { ok?: unknown; data?: unknown })?.data;
  if ((payload as { ok?: unknown })?.ok === true) return { ok: true, data: data as T };
  return {
    ok: false,
    envelope: { ok: false, status: 403, code: "admin_service_authorization_required" },
  };
}
