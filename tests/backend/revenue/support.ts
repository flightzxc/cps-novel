/**
 * 收益看板测试共用夹具：自造 JWT（base64url 拼的假 token，签名段是占位字符，没有任何真实密钥）、
 * 上游信封与行的构造器。这里的值都是测试假数据。
 */

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function fakeJwt(claims: Record<string, unknown>): string {
  return `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url(claims)}.fake-signature-for-tests`;
}

/** 达人凭证口径：带 StarId（海阅当前 active 凭证的实测形状：StarId=335788、RoleType=Star、UserId 为 32 位十六进制）。 */
export function fakeStarJwt(overrides: Record<string, unknown> = {}, expiresAtSeconds = 4_102_444_800): string {
  return fakeJwt({
    UserId: "0123456789abcdef0123456789abcdef",
    StarId: "335788",
    RoleType: "Star",
    exp: expiresAtSeconds,
    ...overrides,
  });
}

/** 聚合账号凭证口径（错误类型）：没有 StarId、有 Url、UserId 为纯数字。 */
export function fakeAggregateJwt(expiresAtSeconds = 4_102_444_800): string {
  return fakeJwt({
    UserId: "1017855",
    UserType: "2",
    Url: "https://example.invalid/aggregate-principal",
    exp: expiresAtSeconds,
  });
}

export function envelope(list: unknown[], extra: Record<string, unknown> = {}) {
  return { status: true, code: 200, message: "操作成功", data: { headers: [], list }, ...extra };
}

export function detailRow(date: string, overrides: Record<string, unknown> = {}) {
  return {
    dimensionKey: date,
    dimensionValue: date,
    isTotal: 0,
    realDevNum: 1,
    newRealDevNum: 1,
    realDevNumRate: "100%",
    realIncome: "0",
    realDistribIncome: "0",
    realProfit: "0",
    ...overrides,
  };
}

export function totalRow(overrides: Record<string, unknown> = {}) {
  return {
    dimensionKey: "总计",
    dimensionValue: "总计",
    isTotal: 1,
    realDevNum: 1,
    newRealDevNum: 1,
    realDevNumRate: "100%",
    realIncome: "0",
    ...overrides,
  };
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
