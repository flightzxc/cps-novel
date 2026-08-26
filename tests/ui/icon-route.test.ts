import { describe, expect, it } from "vitest";

import * as icon from "@/app/icon";

describe("favicon route", () => {
  it("exports a 32x32 icon module", () => {
    expect(icon.size).toEqual({ width: 32, height: 32 });
    expect(icon.contentType).toBe("image/png");
    expect(typeof icon.default).toBe("function");
  });
});
