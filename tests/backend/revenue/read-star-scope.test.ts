import { describe, expect, it } from "vitest";

import { readStarScope } from "@/lib/credentials/jwt";

import { fakeAggregateJwt, fakeJwt, fakeStarJwt } from "./support";

/**
 * 凭证口径校验（CPS 7 月“87 倍事故”的教训）：达人凭证带 StarId；聚合账号凭证没有 StarId、有 Url、
 * UserId 为纯数字——用后者查收益会把整个主体的收益混进来。变异目标③：去掉这道校验，本文件必须变红。
 */
describe("readStarScope", () => {
  it("达人凭证（StarId=335788、RoleType=Star、UserId 为 32 位十六进制）通过，返回 StarId", () => {
    expect(readStarScope(fakeStarJwt())).toEqual({ ok: true, starId: "335788" });
  });

  it("StarId 是数字也行", () => {
    expect(readStarScope(fakeStarJwt({ StarId: 335788 }))).toEqual({ ok: true, starId: "335788" });
  });

  it("聚合账号凭证（无 StarId、有 Url、UserId 纯数字）拒绝：credential_not_star_scope", () => {
    expect(readStarScope(fakeAggregateJwt())).toEqual({ ok: false, reason: "credential_not_star_scope" });
  });

  it.each([
    ["-1", "-1"],
    ["数字 -1", -1],
    ["空串", ""],
    ["全空白", "   "],
    ["null", null],
    ["布尔", true],
    ["对象", { id: 1 }],
    ["非法形状（带空格）", "33 5788"],
    ["非法形状（HTML）", "<script>1</script>"],
    ["非法形状（33 位，超出列宽）", "1".repeat(33)],
  ])("StarId 为 %s → 拒绝", (_name, value) => {
    expect(readStarScope(fakeStarJwt({ StarId: value }))).toEqual({ ok: false, reason: "credential_not_star_scope" });
  });

  it("key 以 StarId 结尾即可（大小写不敏感，兼容带命名空间的 claim 名）", () => {
    const aggregate = { UserId: "1017855", Url: "https://example.invalid", exp: 4_102_444_800 };
    expect(readStarScope(fakeJwt({ ...aggregate, "http://schemas.example.invalid/claims/StarId": "42" }))).toEqual({ ok: true, starId: "42" });
    expect(readStarScope(fakeJwt({ ...aggregate, starid: "7" }))).toEqual({ ok: true, starId: "7" });
    expect(readStarScope(fakeJwt({ ...aggregate, STARID: "8" }))).toEqual({ ok: true, starId: "8" });
  });

  it("只匹配“以 StarId 结尾”的 key：StarIdentity / MyStarIdx 之类不算", () => {
    expect(readStarScope(fakeJwt({ StarIdentity: "1", StarIdx: "2", Star: "3", exp: 1 }))).toEqual({
      ok: false,
      reason: "credential_not_star_scope",
    });
  });

  it("有多个 StarId 类 claim 时取第一个有效的（跳过 -1）", () => {
    expect(readStarScope(fakeJwt({ StarId: "-1", "x/StarId": "99" }))).toEqual({ ok: true, starId: "99" });
  });

  it("损坏的 token 一律拒绝，不抛", () => {
    for (const token of ["", "   ", "abc", "a.b", "a.b.c.d", "a..c", "a.%%%.c", `x.${Buffer.from("[1,2]").toString("base64url")}.y`, `x.${Buffer.from("not json").toString("base64url")}.y`]) {
      expect(readStarScope(token), JSON.stringify(token)).toEqual({ ok: false, reason: "credential_not_star_scope" });
    }
  });

  it("返回值里没有 token，也没有除 StarId 以外的任何 claim 值", () => {
    const token = fakeStarJwt({ Secret: "super-secret-claim-value", Email: "someone@example.invalid" });
    const serialized = JSON.stringify(readStarScope(token));
    expect(serialized).toBe('{"ok":true,"starId":"335788"}');
    expect(serialized).not.toContain("0123456789abcdef");
    expect(serialized).not.toContain("super-secret-claim-value");
    expect(serialized).not.toContain(token);

    const failed = JSON.stringify(readStarScope(fakeAggregateJwt()));
    expect(failed).toBe('{"ok":false,"reason":"credential_not_star_scope"}');
    expect(failed).not.toContain("1017855");
    expect(failed).not.toContain("aggregate-principal");
  });

  it("不验签、不看过期：过期的达人凭证在这一步仍然是“达人口径”（过期由 validateCredentialJwtLocally 负责）", () => {
    expect(readStarScope(fakeStarJwt({}, 1))).toEqual({ ok: true, starId: "335788" });
  });
});
