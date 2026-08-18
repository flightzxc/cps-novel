import { describe, expect, it } from "vitest";

import { getHomeCarouselItems } from "@/lib/site/home-carousel-service";

describe("getHomeCarouselItems", () => {
  it("returns an empty list and does not invent hero images", async () => {
    await expect(getHomeCarouselItems("en")).resolves.toEqual([]);
  });
});
