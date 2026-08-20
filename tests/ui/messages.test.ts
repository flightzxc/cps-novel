import { describe, expect, it } from "vitest";

import {
  loadMessages,
  MissingMessagesError,
  t,
} from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";

describe("loadMessages", () => {
  it("loads the complete English catalog", () => {
    expect(loadMessages("en")).toBe(en);
    expect(t(loadMessages("en"), "nav.home")).toBe("Home");
  });

  it("interpolates dotted keys", () => {
    expect(t(loadMessages("en"), "novel.coverAlt", { title: "Lantern" })).toBe("Cover of Lantern");
    expect(t(loadMessages("en"), "home.slideStatus", { n: 2, count: 4, title: "Lantern" })).toBe(
      "Work 2 of 4: Lantern",
    );
  });

  it("throws on a missing key instead of returning the key", () => {
    expect(() => t(loadMessages("en"), "nav.missing" as never)).toThrow(MissingMessagesError);
  });

  it("throws for an incomplete placeholder locale and does not merge onto en", () => {
    expect(() => loadMessages("es")).toThrow(MissingMessagesError);
    try {
      loadMessages("es");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingMessagesError);
      expect((error as MissingMessagesError).locale).toBe("es");
      expect((error as MissingMessagesError).message).not.toContain("Home");
    }
  });
});
