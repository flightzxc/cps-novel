import type { ReactNode } from "react";

/**
 * Byte-exact display for `rawLanguageScope` / `rawToken`.
 *
 * The backend matches these two fields `COLLATE "C"` — byte-exact, no trim,
 * no case fold, no Unicode normalisation (`tagging-route.ts:73-75`). A
 * leading/trailing space, an internal tab, or a stray newline is not
 * cosmetic whitespace here; it is the difference between two mapping
 * identities. A plain text node would collapse all of that into invisible
 * nothing, so every whitespace character gets a visible glyph instead.
 */
const WHITESPACE_GLYPH: Readonly<Record<string, string>> = Object.freeze({
  " ": "·",
  "\t": "⇥",
  "\n": "↵",
  "\r": "␍",
});

function isWhitespaceChar(ch: string): boolean {
  return Object.prototype.hasOwnProperty.call(WHITESPACE_GLYPH, ch);
}

/**
 * Renders one run of characters (already known to be either "inside the
 * highlighted leading/trailing region" or "interior"). Non-whitespace
 * characters are batched into plain text nodes; each whitespace character
 * becomes its own glyph span so it cannot silently blend back into the text.
 */
function renderRun(run: string, keyPrefix: string, highlight: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (buffer) {
      nodes.push(<span key={`${keyPrefix}-t${index++}`}>{buffer}</span>);
      buffer = "";
    }
  };
  for (const ch of run) {
    if (isWhitespaceChar(ch)) {
      flush();
      nodes.push(
        <span
          key={`${keyPrefix}-w${index++}`}
          className={
            highlight
              ? "rounded-sm bg-amber-200 px-0.5 text-amber-900"
              : "text-gray-400"
          }
        >
          {WHITESPACE_GLYPH[ch]}
        </span>,
      );
    } else {
      buffer += ch;
    }
  }
  flush();
  return nodes;
}

/**
 * Splits `value` into a highlighted leading-whitespace run, an interior run
 * (whitespace inside it is still marked, just not highlighted), and a
 * highlighted trailing-whitespace run — then renders all three.
 *
 * When the entire value is whitespace, the "leading" and "trailing" matches
 * overlap; the leading branch is given the whole string and the trailing
 * branch is suppressed, so the value is never rendered (and never
 * double-highlighted) twice.
 */
function renderRawBytes(value: string): ReactNode {
  if (value.length === 0) {
    return <span className="italic text-gray-400">(空字符串)</span>;
  }

  const leadingMatch = value.match(/^\s+/);
  const trailingMatch = value.match(/\s+$/);
  let leadingLength = leadingMatch ? leadingMatch[0].length : 0;
  let trailingLength = trailingMatch ? trailingMatch[0].length : 0;
  if (leadingLength + trailingLength > value.length) {
    leadingLength = value.length;
    trailingLength = 0;
  }
  const leading = value.slice(0, leadingLength);
  const trailing = trailingLength > 0 ? value.slice(value.length - trailingLength) : "";
  const middle = value.slice(leadingLength, value.length - trailingLength);

  return (
    <>
      {leading && renderRun(leading, "lead", true)}
      {middle && renderRun(middle, "mid", false)}
      {trailing && renderRun(trailing, "trail", true)}
    </>
  );
}

/**
 * `title` always carries the untouched original string — nothing here ever
 * trims, lowercases, or Unicode-normalises `value`; this is a *display*
 * transform layered on top (whitespace glyphs), never a value transform.
 * Callers must keep submitting the raw `string` state itself, never this
 * component's rendered `children` — see `mappings-client.tsx`.
 */
export function RawToken({ value, testId }: { value: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      data-raw-value={value}
      title={value}
      className="inline-block max-w-full whitespace-pre-wrap break-all font-mono text-xs text-gray-900"
    >
      {renderRawBytes(value)}
    </span>
  );
}

/**
 * `rawLanguageScope` and `rawToken` rendered adjacent inside one chip.
 *
 * The DB unique key is `(channelAppId, rawLanguageScope, rawToken,
 * canonicalTagId)` — the same raw token under a different scope is a
 * *different* mapping identity. Putting scope and token in separate table
 * columns (or, worse, showing only the token) invites exactly the
 * misreading this component exists to prevent: an operator has to see both
 * at once to tell two rows apart.
 */
export function RawIdentity({
  scope,
  token,
  scopeTestId,
  tokenTestId,
}: {
  scope: string;
  token: string;
  scopeTestId?: string;
  tokenTestId?: string;
}) {
  return (
    <div className="inline-flex max-w-full flex-col gap-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">scope</span>
        <RawToken value={scope} testId={scopeTestId} />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">token</span>
        <RawToken value={token} testId={tokenTestId} />
      </div>
    </div>
  );
}
