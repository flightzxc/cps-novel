/**
 * Ported from CPS `src/lib/channel-account/jwt.ts`'s `normalizeJwtInput`
 * (identical semantics, renamed for this codebase's credential module):
 * strips an operator's copy-pasted `Authorization: Bearer <token>` header or
 * bare `Bearer <token>` prefix before the value is validated, fingerprinted,
 * or encrypted, so a pasted-with-prefix credential does not silently become
 * a different (invalid) token than the one the operator intended to store.
 * Case-insensitive; trims both the outer value and the captured group.
 */
export function normalizeCredentialJwtInput(value: string): string {
  const trimmed = value.trim();
  const authorizationMatch = /^Authorization\s*:\s*Bearer\s+(.+)$/i.exec(trimmed);
  if (authorizationMatch) {
    return authorizationMatch[1].trim();
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  return trimmed;
}

export type LocalCredentialValidation =
  | { status: "active"; expiresAt: Date }
  | { status: "expired"; expiresAt: Date }
  | { status: "invalid"; expiresAt: null };

export function validateCredentialJwtLocally(token: string, now = new Date()): LocalCredentialValidation {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return { status: "invalid", expiresAt: null };
  try {
    const padded = parts[1].padEnd(parts[1].length + ((4 - parts[1].length % 4) % 4), "=");
    const payload = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return { status: "invalid", expiresAt: null };
    const milliseconds = payload.exp >= 1_000_000_000_000 ? payload.exp : payload.exp * 1000;
    const expiresAt = new Date(milliseconds);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getUTCFullYear() > 9999) return { status: "invalid", expiresAt: null };
    return expiresAt > now ? { status: "active", expiresAt } : { status: "expired", expiresAt };
  } catch {
    return { status: "invalid", expiresAt: null };
  }
}

/**
 * 凭证口径：这条凭证是不是「达人（Star）」口径。
 *
 * 背景（CPS 7 月“87 倍事故”的教训）：畅读上游有两类登录态——
 *   - 达人凭证：JWT payload 里带 `StarId`（海阅当前 active 凭证实测：`StarId=335788`、`RoleType=Star`、
 *     `UserId` 为 32 位十六进制）。用它查收益，得到的是这个达人名下的数字；
 *   - 聚合账号凭证：没有 `StarId`、有 `Url`、`UserId` 为纯数字。用它查收益，会把整个主体的收益
 *     混进来，数字比真实值大几十倍，而且看起来“一切正常”。
 * 所以收益同步在发任何上游请求之前先过这道闸：必须存在 key 以 `StarId` 结尾（大小写不敏感，
 * 兼容 `http://…/claims/StarId` 这类带命名空间的写法）的 claim，值非空、不等于 `-1`，且形状合理
 * （1–32 位字母数字 / 下划线 / 连字符，会原样落进 `revenue_sync_batch.upstream_star_id`）。
 *
 * 只解码 payload，不验签、不看过期（过期由 `validateCredentialJwtLocally` 负责）。
 * **不返回、不记录 token 或除 StarId 以外的任何 claim 值**；失败时只有一个稳定原因码。
 */
export type StarScopeResult =
  | { ok: true; starId: string }
  | { ok: false; reason: "credential_not_star_scope" };

const STAR_SCOPE_FAILURE: StarScopeResult = Object.freeze({ ok: false, reason: "credential_not_star_scope" } as const);
const STAR_ID_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

function decodeJwtPayloadObject(token: string): Record<string, unknown> | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=");
    const payload: unknown = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readStarScope(token: string): StarScopeResult {
  const payload = decodeJwtPayloadObject(token);
  if (!payload) return STAR_SCOPE_FAILURE;
  for (const [key, value] of Object.entries(payload)) {
    if (!/starid$/i.test(key)) continue;
    const text =
      typeof value === "string" ? value.trim()
        : typeof value === "number" && Number.isFinite(value) ? String(value)
          : "";
    if (!text || text === "-1" || !STAR_ID_SHAPE.test(text)) continue;
    return { ok: true, starId: text };
  }
  return STAR_SCOPE_FAILURE;
}
