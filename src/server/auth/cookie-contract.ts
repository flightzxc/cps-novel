import { ADMIN_ABSOLUTE_TIMEOUT_MS } from "@/lib/auth/session";

export const ADMIN_SESSION_COOKIE_NAME = "__Host-cps_admin_session";
export const ADMIN_TWO_FACTOR_COOKIE_NAME = "__Host-cps_admin_2fa";

export const ADMIN_SESSION_COOKIE_CONTRACT = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: ADMIN_ABSOLUTE_TIMEOUT_MS / 1000,
});

export const ADMIN_TWO_FACTOR_COOKIE_CONTRACT = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 5 * 60,
});
