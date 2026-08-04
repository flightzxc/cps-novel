import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const TONES: Readonly<Record<BadgeTone, string>> = Object.freeze({
  neutral: "border-gray-200 bg-gray-50 text-gray-600",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-red-200 bg-red-50 text-red-700",
  info: "border-blue-200 bg-blue-50 text-blue-700",
});

export function StatusBadge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
