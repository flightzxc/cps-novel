import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Readonly<Record<ButtonVariant, string>> = Object.freeze({
  primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:text-gray-400",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
  ghost: "text-gray-600 hover:bg-gray-100 disabled:text-gray-400",
});

export function buttonClassName(variant: ButtonVariant = "primary", extra = ""): string {
  return [
    "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium",
    "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600",
    "disabled:cursor-not-allowed",
    VARIANTS[variant],
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button {...props} className={buttonClassName(variant, className)} />;
}
