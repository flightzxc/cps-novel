import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  extractLanguageFields,
  PROBE_DEFAULT_SAMPLE_SIZE,
  probeUnnamedLanguageCodes,
  type ProbeSourceItemDb,
} from "../../../scripts/l10n/probe-unnamed-language-codes";

/**
 * `施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.H:
 * "probe dry-run 零上游调用" — this file only exercises
 * `probeUnnamedLanguageCodes` (the dry-run/DB-only core). It never imports
 * `applyProbeUnnamedLanguageCodes` or anything from `src/lib/adapters` /
 * `worker/credentials`, so there is no way for these tests to reach the
 * network even by accident — the "zero upstream calls" property is
 * structural, not just behavioral, for this test file.
 */

type FakeRow = {
  id: string;
  sourceLanguageCode: string;
  externalBookId: string;
  title: string;
  channelAppId: string;
  rawPayload: Prisma.JsonValue;
};

class FakeProbeDb implements ProbeSourceItemDb {
  readonly rows: FakeRow[] = [];
  private callCount = 0;

  get findManyCallCount() {
    return this.callCount;
  }

  readonly novelSourceItem = {
    findMany: async (args: {
      where: { sourceLanguageCode: string; deletedAt: null };
      take: number;
    }): Promise<Array<Omit<FakeRow, "sourceLanguageCode">>> => {
      this.callCount += 1;
      return this.rows
        .filter((row) => row.sourceLanguageCode === args.where.sourceLanguageCode)
        .slice(0, args.take)
        .map(({ id, externalBookId, title, channelAppId, rawPayload }) => ({ id, externalBookId, title, channelAppId, rawPayload }));
    },
  };
}

function seed(
  db: FakeProbeDb,
  sourceLanguageCode: string,
  id: string,
  externalBookId: string,
  title: string,
  rawPayload: Prisma.JsonValue,
) {
  db.rows.push({ id, sourceLanguageCode, externalBookId, title, channelAppId: "app-1", rawPayload });
}

describe("probeUnnamedLanguageCodes · dry-run", () => {
  it("默认只探 code 19/20，各 ≤20 本，零上游调用", async () => {
    const db = new FakeProbeDb();
    seed(db, "19", "1", "book-19-a", "Book 19 A", { hasMultiLanguage: false });
    seed(db, "20", "2", "book-20-a", "Book 20 A", { hasMultiLanguage: true });
    seed(db, "3", "3", "book-3-a", "Book 3 A (en，不应出现)", { hasMultiLanguage: false });

    const report = await probeUnnamedLanguageCodes(db);

    expect(report.mode).toBe("dry-run");
    expect(report.upstreamCallCount).toBe(0);
    expect(report.sampleSizePerCode).toBe(PROBE_DEFAULT_SAMPLE_SIZE);
    expect(report.results.map((r) => r.code)).toEqual(["19", "20"]);
    expect(report.results[0]!.samples).toEqual([
      { externalBookId: "book-19-a", title: "Book 19 A", hasMultiLanguage: false },
    ]);
    expect(report.results[1]!.samples).toEqual([
      { externalBookId: "book-20-a", title: "Book 20 A", hasMultiLanguage: true },
    ]);
    // code 3 从未被查询——探针只认 19/20。
    expect(db.findManyCallCount).toBe(2);
  });

  it("样本上限钉死在 20，--sample-size 传更大的值也不会突破", async () => {
    const db = new FakeProbeDb();
    for (let i = 0; i < 30; i += 1) {
      seed(db, "19", String(i), `book-19-${i}`, `Book 19 #${i}`, { hasMultiLanguage: false });
    }

    const report = await probeUnnamedLanguageCodes(db, { sampleSize: 999 });
    expect(report.sampleSizePerCode).toBe(20);
    expect(report.results[0]!.samples).toHaveLength(20);
  });

  it("hasMultiLanguage 缺失或非布尔值时读成 null，不发明假值", async () => {
    const db = new FakeProbeDb();
    seed(db, "19", "1", "book-a", "Book A", {}); // 缺字段
    seed(db, "19", "2", "book-b", "Book B", { hasMultiLanguage: "not-a-boolean" });
    seed(db, "19", "3", "book-c", "Book C", null);

    const report = await probeUnnamedLanguageCodes(db);
    const samples = report.results[0]!.samples;
    expect(samples.every((sample) => sample.hasMultiLanguage === null)).toBe(true);
  });

  it("没有样本的码返回空数组，不报错", async () => {
    const db = new FakeProbeDb();
    const report = await probeUnnamedLanguageCodes(db);
    expect(report.results).toEqual([
      { code: "19", sampleSize: 0, samples: [] },
      { code: "20", sampleSize: 0, samples: [] },
    ]);
  });
});

/**
 * `extractLanguageFields` is a pure function with no adapter/credential/
 * network dependency of its own (it only ever reads an already-in-memory
 * JS value) — importing it here does not pull `applyProbeUnnamedLanguageCodes`
 * or anything from `src/lib/adapters`/`worker/credentials` into this file's
 * module graph, so the header comment's "structurally zero upstream calls"
 * property for this file still holds. The full `--apply` catch-branch fix
 * (P5 §4.H: the error path used to discard an already-captured raw body)
 * needs a real credential/fetch round trip and lives in its own file,
 * `probe-unnamed-language-codes-apply.test.ts`, precisely so it does not
 * have to compromise this file's "never touches adapter/credential/network
 * code" guarantee.
 */
describe("extractLanguageFields — X-2 real-run shape (data.chapterList non-array, data.currentLanguage present)", () => {
  it("scans .data's own keys (not the envelope's) for /lang/i-matching scalars", () => {
    const raw = {
      code: 0,
      msg: "success",
      data: { bookId: "b1", chapterList: "not-an-array", currentLanguage: "3" },
    };
    expect(extractLanguageFields(raw)).toEqual({ currentLanguage: "3" });
  });

  it("falls back to the envelope's own keys when there is no .data object", () => {
    expect(extractLanguageFields({ currentLanguage: "7", chapterList: [] })).toEqual({ currentLanguage: "7" });
  });

  it("null/non-object/array input all extract to {}, never throw", () => {
    expect(extractLanguageFields(null)).toEqual({});
    expect(extractLanguageFields(undefined)).toEqual({});
    expect(extractLanguageFields("not-an-object")).toEqual({});
    expect(extractLanguageFields([1, 2, 3])).toEqual({});
  });

  it("drops a lang-named key whose value is itself an object/array (not a scalar/null)", () => {
    expect(extractLanguageFields({ data: { languageList: [1, 2], currentLanguage: "3" } })).toEqual({ currentLanguage: "3" });
  });
});
