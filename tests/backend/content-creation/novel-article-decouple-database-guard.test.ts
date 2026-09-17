import { describe, expect, it } from "vitest";

import { assertRoleClientsShareIsolatedDatabase } from "./novel-article-decouple-database-guard";

describe("novel-article-decouple database guard (R2-05)", () => {
  it("throws when owner is isolated but web/worker point at a different database name", () => {
    expect(() => assertRoleClientsShareIsolatedDatabase({
      ownerDatabase: "cps_novel_article_decouple_review",
      webDatabase: "cps_novel_article_decouple_other",
      workerDatabase: "cps_novel_article_decouple_other",
    })).toThrow(/must share one isolated database/);
  });

  it("accepts three connections on the same isolated name", () => {
    expect(() => assertRoleClientsShareIsolatedDatabase({
      ownerDatabase: "cps_novel_article_decouple_review",
      webDatabase: "cps_novel_article_decouple_review",
      workerDatabase: "cps_novel_article_decouple_review",
    })).not.toThrow();
  });
});
