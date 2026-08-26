import type { ReactNode } from "react";

/** Shared centered-card chrome for the login / 2FA challenge / 2FA setup pages. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
      <h1 className="text-xl font-bold text-gray-900">{title}</h1>
      {description && <p className="mt-1.5 text-sm text-gray-500">{description}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}
