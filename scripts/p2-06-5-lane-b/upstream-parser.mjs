import { createHash } from "node:crypto";

import { exactBookIdentity, extractSeriesTypeTokens, rawLanguageIdentity } from "./raw.mjs";

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function externalIdentity(row) {
  const value = row.id ?? row.seriesId;
  if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) return value;
  throw new Error("getlistpc row requires exact id or seriesId");
}

function rawLanguageName(row) {
  if (!Object.hasOwn(row, "languageName")) return { present: false, value: undefined };
  if (row.languageName !== null && typeof row.languageName !== "string") {
    throw new Error("getlistpc languageName must be string, null, or missing");
  }
  return { present: true, value: row.languageName };
}

export function parseLaneBPage({ payload, pageIndex, fetchedAt, channelAppId }) {
  record(payload, "getlistpc envelope");
  const data = record(payload.data, "getlistpc data");
  if (!Number.isSafeInteger(data.totalCount) || data.totalCount < 0) throw new Error("getlistpc totalCount invalid");
  if (!Array.isArray(data.list)) throw new Error("getlistpc data.list must be an array");
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) throw new Error("pageIndex invalid");
  if (typeof fetchedAt !== "string" || !fetchedAt) throw new Error("fetchedAt required");
  if (typeof channelAppId !== "string" || !channelAppId) throw new Error("channelAppId required");

  const books = [];
  const observations = [];
  const anomalies = [];
  for (let rowIndex = 0; rowIndex < data.list.length; rowIndex += 1) {
    const rawRow = record(data.list[rowIndex], `getlistpc data.list[${rowIndex}]`);
    if (!Object.hasOwn(rawRow, "language")) throw new Error(`getlistpc data.list[${rowIndex}] missing language`);
    if (typeof rawRow.language === "number" && !Number.isSafeInteger(rawRow.language)) {
      throw new Error(`getlistpc data.list[${rowIndex}] language numeric value is not exact`);
    }
    const languageName = rawLanguageName(rawRow);
    const rawLanguageScope = languageName.present
      ? rawLanguageIdentity(rawRow.language, languageName.value)
      : rawLanguageIdentity(rawRow.language);
    const externalBookIdRaw = externalIdentity(rawRow);
    const sampleBookKey = languageName.present
      ? exactBookIdentity(channelAppId, externalBookIdRaw, rawRow.language, languageName.value)
      : exactBookIdentity(channelAppId, externalBookIdRaw, rawRow.language);
    const seriesTypeListPresent = Object.hasOwn(rawRow, "seriesTypeList");
    const extracted = extractSeriesTypeTokens(rawRow.seriesTypeList);
    if (typeof rawRow.seriesName !== "string") throw new Error("getlistpc seriesName must be a string");
    const titleRaw = rawRow.seriesName;
    const descriptionPresent = Object.hasOwn(rawRow, "description");
    const descriptionRaw = descriptionPresent ? rawRow.description : null;
    const descriptionJsonValueJson = descriptionPresent ? JSON.stringify(descriptionRaw) : null;
    if (descriptionPresent && descriptionJsonValueJson === undefined) {
      throw new Error("getlistpc description must be a JSON value");
    }
    const rawRowJson = JSON.stringify(rawRow);
    const base = {
      schemaVersion: 1,
      sourceScope: channelAppId,
      channelAppId,
      sampleBookKey,
      externalBookIdRaw,
      titleRaw,
      descriptionRaw,
      descriptionPresent,
      descriptionJsonValueJson,
      languageJsonValue: rawRow.language,
      languageNamePresent: languageName.present,
      sourceLanguageNameRaw: languageName.present ? languageName.value : undefined,
      rawLanguageScope,
      siteLocale: null,
      seriesTypeListPresent,
      seriesTypeListRaw: seriesTypeListPresent ? rawRow.seriesTypeList : null,
      rawRowUtf8Sha256: createHash("sha256").update(rawRowJson, "utf8").digest("hex"),
      pageIndex,
      rowIndex,
      fetchedAt,
    };
    books.push(base);
    for (const token of extracted.tokens) {
      observations.push({
        schemaVersion: 1,
        sampleBookKey,
        sourceScope: channelAppId,
        rawLanguageScope,
        pageIndex,
        rowIndex,
        fetchedAt,
        listIndex: token.listIndex,
        rawItemJson: token.rawItemJson,
        exactRawToken: token.exactRawToken,
        extractionPath: token.extractionPath,
        sourceKind: token.sourceKind,
      });
    }
    for (const anomaly of extracted.anomalies) {
      anomalies.push({
        schemaVersion: 1,
        sampleBookKey,
        sourceScope: channelAppId,
        rawLanguageScope,
        pageIndex,
        rowIndex,
        fetchedAt,
        ...anomaly,
      });
    }
  }
  return { totalCount: data.totalCount, books, observations, anomalies };
}

export function deduplicateLaneBBooks(books, firstSeen = new Map()) {
  const accepted = [];
  const duplicates = [];
  for (const book of books) {
    const key = book.sampleBookKey;
    if (firstSeen.has(key)) {
      duplicates.push({
        sampleBookKey: key,
        firstSeen: firstSeen.get(key),
        duplicatePageIndex: book.pageIndex,
        duplicateRowIndex: book.rowIndex,
        observedAt: book.fetchedAt,
      });
      continue;
    }
    const seen = { pageIndex: book.pageIndex, rowIndex: book.rowIndex, fetchedAt: book.fetchedAt };
    firstSeen.set(key, seen);
    accepted.push(book);
  }
  return { accepted, duplicates, firstSeen };
}
