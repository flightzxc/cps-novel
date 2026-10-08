/**
 * B-36 — a structured, content-free reason for a MoboReader response that the
 * adapter refused to accept.
 *
 * Why this exists: before it, every `malformed_payload` thrown while parsing a
 * `getchapterinfo` response carried no information at all beyond its code
 * (`requiredString` / `integer` / the duplicate-chapter check all threw a bare
 * `MoboreaderAdapterError("malformed_payload", false)`), and
 * `worker/handlers/moboreader.ts` then flattened *every* failure of the read to
 * the same generic `upstream_preview_read_failed`. On 2026-10-07 that made 34
 * books fail deterministically (HTTP 200, `outcome=ok` in the upstream-call
 * log) with nothing in the database or the logs saying which validation had
 * tripped.
 *
 * The contract of this file is the opposite of a debug dump:
 *
 *   - Every field is either a member of a CLOSED vocabulary defined here, or a
 *     non-negative integer, or (`chapterId`) an upstream *identifier* that the
 *     consumer re-validates against a strict pattern before it goes anywhere.
 *   - Nothing here is ever derived from a chapter body, a title, a URL, a
 *     header or the credential. A field NAME and a received TYPE/LENGTH tell an
 *     operator "chapterContent was an empty string on chapter #1"; they never
 *     contain the content itself.
 *
 * The persistence/log projection lives in
 * `worker/observability/preview-read-failure.ts`; this file only defines the shared
 * vocabulary and the helpers the parsers use to fill it in.
 */

/**
 * The validation that rejected a response. One value per distinct throw site in
 * `parseBookMaterialResponse` / `parsePreviewChaptersResponse` / the shared
 * `responseData`, plus `body_not_json` for the transport layer's "2xx but the
 * body was not JSON" case. A `kind` implies its field, so there is no separate
 * free-text field name to leak anything through.
 */
export const MOBOREADER_PARSE_FAILURE_KINDS = [
  "body_not_json",
  "envelope_not_object",
  "data_not_object",
  // getbydataid
  "material_item_not_object",
  // getchapterinfo — response level
  "chapter_list_not_array",
  "book_id_invalid",
  "current_language_invalid",
  // getchapterinfo — per chapter row
  "chapter_row_not_object",
  "chapter_ordinal_invalid",
  "chapter_ordinal_below_one",
  "chapter_id_invalid",
  "chapter_content_invalid",
  "chapter_identity_duplicate",
] as const;

export type MoboreaderParseFailureKind = (typeof MOBOREADER_PARSE_FAILURE_KINDS)[number];

/**
 * What the offending value actually was — a TYPE (and, for strings, "empty" vs
 * "only whitespace"), never the value. This is the field that separates "the
 * upstream omitted `chapterContent`" from "sent null" from "sent an empty
 * string", which is exactly the distinction a paid-chapter hypothesis needs.
 */
export const MOBOREADER_RECEIVED_KINDS = [
  "undefined",
  "null",
  "empty_string",
  "blank_string",
  "string",
  "integer",
  "negative_integer",
  "unsafe_integer",
  "fractional_number",
  "non_finite_number",
  "boolean",
  "array",
  "object",
  "other",
] as const;

export type MoboreaderReceivedKind = (typeof MOBOREADER_RECEIVED_KINDS)[number];

export interface MoboreaderFailureDiagnostic {
  readonly kind: MoboreaderParseFailureKind;
  readonly receivedType?: MoboreaderReceivedKind;
  /** `String.length` of the offending value when it was a string. A number, not the text. */
  readonly valueLength?: number;
  /** 0-based position of the offending row inside `chapterList`. */
  readonly chapterIndex?: number;
  /** The row's own `i` (1-based chapter ordinal) when it had already validated. */
  readonly chapterOrdinal?: number;
  /** The row's upstream `chapterID` when it had already validated. Consumers re-validate the pattern. */
  readonly chapterId?: string;
  /** `chapterList.length`. */
  readonly chapterCount?: number;
}

export function receivedKindOf(value: unknown): MoboreaderReceivedKind {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.length === 0) return "empty_string";
    return value.trim() ? "string" : "blank_string";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "non_finite_number";
    if (!Number.isInteger(value)) return "fractional_number";
    if (!Number.isSafeInteger(value)) return "unsafe_integer";
    return value < 0 ? "negative_integer" : "integer";
  }
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return "other";
}
