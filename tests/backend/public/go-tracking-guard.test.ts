import { describe, expect, it } from "vitest";

import { isObviousBotUserAgent, shouldRecordGoRedirect } from "@/app/go/_lib/tracking-guard";

// RC-6. `isObviousBotUserAgent` is copied verbatim (same regex, same
// case-insensitive flag, same token list) from CPS `isObviousBotUserAgent`
// (`src/lib/cps-tracking.ts:287-291`, v8.3.6
// `16f2e4cfca51f46af0dede899ecf6242a770bbd0`). Every case below exercises one
// of that pattern's tokens, plus a normal browser UA and an empty string as
// negative controls.
describe("isObviousBotUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", true],
    ["Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)", true],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", true],
    ["SomeSpidering/1.0", true],
    ["Slurp/3.0 (Yahoo)", true],
    ["BingPreview/1.0b", true],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", true],
    ["WhatsApp/2.23.20.0", true],
    ["TelegramBot (like TwitterBot)", true],
    ["curl/8.4.0", true],
    ["Wget/1.21.4", true],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      false,
    ],
    ["", false],
  ])("classifies %s as bot=%s", (userAgent, expected) => {
    expect(isObviousBotUserAgent(userAgent)).toBe(expected);
  });
});

const NORMAL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) NovelTest/1.0";
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1)";

describe("shouldRecordGoRedirect", () => {
  it("defaults to true (writes on) when the env var is unset", () => {
    expect(shouldRecordGoRedirect({ env: { NODE_ENV: "test" }, userAgent: NORMAL_UA })).toBe(true);
  });

  // Accepted "disable" values are CPS `isTruthyEnv`'s set verbatim
  // (`src/lib/cps-tracking.ts:585-587`): trim, then `/^(1|true|yes|on)$/i`.
  // The `on`/`yes`/uppercase/whitespace rows are the point of the exception to
  // this repo's usual `=== "true"` parsing -- an operator reaching for this
  // valve mid-incident carries CPS habits, and a silent no-op there is the
  // worst failure this flag has.
  it.each(["1", "true", "TRUE", "True", "yes", "YES", "on", "ON", " 1 ", "  true  "])(
    "closes the gate (returns false) for PUBLIC_TRACKING_WRITE_DISABLED=%j",
    (value) => {
      expect(
        shouldRecordGoRedirect({
          env: { NODE_ENV: "test", PUBLIC_TRACKING_WRITE_DISABLED: value },
          userAgent: NORMAL_UA,
        }),
      ).toBe(false);
    },
  );

  // Everything else means "not disabled". The safe default for this flag is
  // open: `/go` is the only attribution signal, so a typo must not silently
  // kill it.
  it.each(["0", "false", "FALSE", "off", "no", "", "   ", "enabled", "1;", "truthy"])(
    "stays open (returns true) for the non-truthy value PUBLIC_TRACKING_WRITE_DISABLED=%j",
    (value) => {
      expect(
        shouldRecordGoRedirect({
          env: { NODE_ENV: "test", PUBLIC_TRACKING_WRITE_DISABLED: value },
          userAgent: NORMAL_UA,
        }),
      ).toBe(true);
    },
  );

  it("returns false for an obvious bot user-agent even when the write gate is open", () => {
    expect(shouldRecordGoRedirect({ env: { NODE_ENV: "test" }, userAgent: BOT_UA })).toBe(false);
  });

  it("returns true for a missing (null) user-agent when the write gate is open", () => {
    expect(shouldRecordGoRedirect({ env: { NODE_ENV: "test" }, userAgent: null })).toBe(true);
  });

  it("checks the write gate before the bot filter (write-disabled + bot UA is still just 'false')", () => {
    expect(
      shouldRecordGoRedirect({
        env: { NODE_ENV: "test", PUBLIC_TRACKING_WRITE_DISABLED: "1" },
        userAgent: BOT_UA,
      }),
    ).toBe(false);
  });
});
