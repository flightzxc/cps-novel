import { AdminAccessError } from "@/lib/auth/errors";

export const ADMIN_MUTATION_REQUEST_ID_HEADER = "x-request-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireSameOrigin(originHeader: string | null | undefined, canonicalOrigin: string): void {
  try {
    if (!originHeader || new URL(originHeader).origin !== new URL(canonicalOrigin).origin) {
      throw new Error("mismatch");
    }
  } catch {
    throw new AdminAccessError("admin_origin_denied", 403, "Admin mutation origin denied");
  }
}

export function requireMutationRequestId(requestId: string | null | undefined): string {
  const normalized = requestId?.trim() ?? "";
  if (!UUID_RE.test(normalized)) {
    throw new AdminAccessError(
      "admin_mutation_request_id_invalid",
      403,
      "A UUID mutation request id is required",
    );
  }
  return normalized.toLowerCase();
}
