"use client";

import { useState } from "react";

import { buttonClassName } from "./button";

/**
 * Copies whatever string the caller hands it (CPS `copy-value-button.tsx` parity).
 *
 * This button does not classify sensitivity and does not mask. The caller is
 * responsible for feeding it only values that are already meant to be copied:
 * a fingerprint prefix, a public short code, or a one-time 2FA recovery code
 * shown on the setup done step (that page is the only place the codes appear).
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
