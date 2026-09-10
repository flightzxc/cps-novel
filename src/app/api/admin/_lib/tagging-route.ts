import { TaggingAdminError } from "@/domain/tagging-admin";
import type {
  AdminCanonicalTagGetInput,
  AdminCanonicalTagKeyword,
  AdminCanonicalTagMutation,
  AdminNovelTagMutation,
  AdminSourceLabelMappingGetInput,
  AdminSourceLabelMappingMutation,
} from "@/domain/tagging-admin";

function invalid(): never {
  throw new TaggingAdminError("invalid_tag_request", 400);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) invalid();
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
}

function string(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) invalid();
  return [...value] as string[];
}

function action(value: Record<string, unknown>): string {
  return string(value.action);
}

function assertRequestId(body: Record<string, unknown>, guardedRequestId: string): string {
  const requestId = string(body.requestId);
  if (requestId !== guardedRequestId) invalid();
  return requestId;
}

function optionalParam(params: URLSearchParams, key: string): string | undefined {
  return params.has(key) ? (params.get(key) ?? "") : undefined;
}

export function canonicalTagGetInput(url: URL): AdminCanonicalTagGetInput {
  return {
    id: optionalParam(url.searchParams, "id"),
    page: optionalParam(url.searchParams, "page"),
    pageSize: optionalParam(url.searchParams, "pageSize"),
    search: optionalParam(url.searchParams, "search"),
    active: optionalParam(url.searchParams, "active"),
  };
}

export function sourceLabelMappingGetInput(url: URL): AdminSourceLabelMappingGetInput {
  return {
    id: optionalParam(url.searchParams, "id"),
    page: optionalParam(url.searchParams, "page"),
    pageSize: optionalParam(url.searchParams, "pageSize"),
    search: optionalParam(url.searchParams, "search"),
    active: optionalParam(url.searchParams, "active"),
    channelAppId: optionalParam(url.searchParams, "channelAppId"),
    canonicalTagId: optionalParam(url.searchParams, "canonicalTagId"),
    // Exact identity fields intentionally bypass trimming and normalization.
    rawLanguageScope: optionalParam(url.searchParams, "rawLanguageScope"),
    rawToken: optionalParam(url.searchParams, "rawToken"),
  };
}

export function novelTagGetInput(url: URL): { novelId: unknown; locale?: unknown } {
  return {
    novelId: optionalParam(url.searchParams, "novelId"),
    locale: optionalParam(url.searchParams, "locale"),
  };
}

function translations(value: unknown): Array<{ locale: string; displayName: string }> {
  if (!Array.isArray(value)) invalid();
  return value.map((entry) => {
    const item = record(entry);
    exactKeys(item, ["locale", "displayName"]);
    return { locale: string(item.locale), displayName: string(item.displayName) };
  });
}

function keywords(value: unknown): AdminCanonicalTagKeyword[] {
  if (!Array.isArray(value)) invalid();
  return value.map((entry) => {
    const item = record(entry);
    exactKeys(item, [
      "keywordId",
      "value",
      "scriptBuckets",
      "matchMode",
      "riskFlags",
      "active",
      "lexiconVersion",
    ]);
    if (typeof item.active !== "boolean") invalid();
    return {
      keywordId: string(item.keywordId),
      value: string(item.value),
      scriptBuckets: stringArray(item.scriptBuckets),
      matchMode: string(item.matchMode),
      riskFlags: stringArray(item.riskFlags),
      active: item.active,
      lexiconVersion: string(item.lexiconVersion),
    };
  });
}

export function canonicalTagMutation(
  input: unknown,
  guardedRequestId: string,
): AdminCanonicalTagMutation {
  const body = record(input);
  const requestId = assertRequestId(body, guardedRequestId);
  const selectedAction = action(body);
  const base = {
    requestId,
    canonicalTagId: string(body.canonicalTagId),
    expectedUpdatedAt: string(body.expectedUpdatedAt),
  };
  if (selectedAction === "set_status") {
    exactKeys(body, ["action", "requestId", "canonicalTagId", "expectedUpdatedAt", "status"]);
    if (body.status !== "active" && body.status !== "inactive") invalid();
    return { action: selectedAction, ...base, status: body.status };
  }
  if (selectedAction === "replace_translations") {
    exactKeys(body, ["action", "requestId", "canonicalTagId", "expectedUpdatedAt", "translations"]);
    return { action: selectedAction, ...base, translations: translations(body.translations) };
  }
  if (selectedAction === "replace_aliases") {
    exactKeys(body, ["action", "requestId", "canonicalTagId", "expectedUpdatedAt", "aliases"]);
    return { action: selectedAction, ...base, aliases: stringArray(body.aliases) };
  }
  if (selectedAction === "replace_keywords") {
    exactKeys(body, ["action", "requestId", "canonicalTagId", "expectedUpdatedAt", "keywords"]);
    return { action: selectedAction, ...base, keywords: keywords(body.keywords) };
  }
  return invalid();
}

export function sourceLabelMappingMutation(
  input: unknown,
  guardedRequestId: string,
): AdminSourceLabelMappingMutation {
  const body = record(input);
  const requestId = assertRequestId(body, guardedRequestId);
  const selectedAction = action(body);
  if (selectedAction === "approve_edge") {
    exactKeys(body, [
      "action",
      "requestId",
      "channelAppId",
      "rawLanguageScope",
      "rawToken",
      "canonicalTagId",
      "mappingVersion",
      "expectedUpdatedAt",
    ]);
    if (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== "string") invalid();
    return {
      action: selectedAction,
      requestId,
      channelAppId: string(body.channelAppId),
      rawLanguageScope: string(body.rawLanguageScope),
      rawToken: string(body.rawToken),
      canonicalTagId: string(body.canonicalTagId),
      mappingVersion: string(body.mappingVersion),
      expectedUpdatedAt: body.expectedUpdatedAt,
    };
  }
  if (selectedAction === "deactivate_edge") {
    exactKeys(body, ["action", "requestId", "mappingId", "expectedUpdatedAt"]);
    return {
      action: selectedAction,
      requestId,
      mappingId: string(body.mappingId),
      expectedUpdatedAt: string(body.expectedUpdatedAt),
    };
  }
  return invalid();
}

export function novelTagMutation(input: unknown, guardedRequestId: string): AdminNovelTagMutation {
  const body = record(input);
  const requestId = assertRequestId(body, guardedRequestId);
  const selectedAction = action(body);
  const base = {
    requestId,
    novelId: string(body.novelId),
    expectedRevision: string(body.expectedRevision),
  };
  if (selectedAction === "replace_manual") {
    exactKeys(body, ["action", "requestId", "novelId", "expectedRevision", "canonicalTagIds"]);
    return { action: selectedAction, ...base, canonicalTagIds: stringArray(body.canonicalTagIds) };
  }
  if (selectedAction === "exit_manual") {
    exactKeys(body, ["action", "requestId", "novelId", "expectedRevision"]);
    return { action: selectedAction, ...base };
  }
  return invalid();
}
