"use client";

import { useState } from "react";

import { buttonClassName } from "./button";

/**
 * Copies a non-sensitive value (CPS `copy-value-button.tsx` parity).
 *
 * `value` must already be the redacted form the server chose to expose — this
 * component never receives a secret, so there is nothing here to mask. Feed it a
 * fingerprint prefix or a public code, never a credential.
 */
export function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={buttonClassName("ghost", "px-2 py-1 text-xs")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "已复制" : label}
    </button>
  );
}
