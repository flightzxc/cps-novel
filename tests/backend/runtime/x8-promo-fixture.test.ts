import { describe, expect, it } from "vitest";

import { parseX8PromoFixtureOptions, X8PromoFixtureError } from "../../../scripts/x8-promo-fixture";

const safeEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SITE_URL: "https://novel.test",
  P1_12_COMPOSE_PROJECT: "cps-novel-x8-local",
  FEATURE_PROMO_LINK_CLAIM: "false",
  PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
  X8_ACCEPTANCE_OPERATOR: "codex-x8",
};

const argv = [
  "--source-item",
  "source-1",
  "--channel-account",
  "account-1",
  "--target-url",
  "https://example.test/x8-acceptance",
];

describe("X8 promo acceptance fixture safety", () => {
  it("defaults to dry-run on the isolated project", () => {
    expect(parseX8PromoFixtureOptions(argv, safeEnv)).toEqual({
      sourceItemId: "source-1",
      channelAccountId: "account-1",
      targetUrl: "https://example.test/x8-acceptance",
      apply: false,
      operatorId: "codex-x8",
    });
  });

  it("requires an independent write confirmation for apply", () => {
    expect(() => parseX8PromoFixtureOptions([...argv, "--apply"], safeEnv)).toThrow(
      "apply requires X8_ACCEPTANCE_FIXTURE_ALLOW_WRITE=true",
    );
    expect(
      parseX8PromoFixtureOptions([...argv, "--apply"], {
        ...safeEnv,
        X8_ACCEPTANCE_FIXTURE_ALLOW_WRITE: "true",
      }).apply,
    ).toBe(true);
  });

  it("refuses origin drift, compose drift, open claim gates, and unsafe URLs", () => {
    for (const env of [
      { ...safeEnv, SITE_URL: "https://other.test" },
      { ...safeEnv, P1_12_COMPOSE_PROJECT: "other" },
      { ...safeEnv, FEATURE_PROMO_LINK_CLAIM: "true" },
      { ...safeEnv, PROMO_LINK_CLAIM_ALLOW_WRITE: "true" },
    ]) {
      expect(() => parseX8PromoFixtureOptions(argv, env)).toThrow(X8PromoFixtureError);
    }
    expect(() =>
      parseX8PromoFixtureOptions([...argv.slice(0, -1), "javascript:alert(1)"], safeEnv),
    ).toThrow("must use http or https");
  });
});
