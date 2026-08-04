import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";

/**
 * List chrome copied from CPS `dramas-list-client.tsx:200-223`: header row is
 * `border-b border-gray-200 bg-gray-50` with `text-gray-500` column names. Kept
 * verbatim so operators moving between the two backends read the same table.
 */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">{children}</table>
    </div>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-normal text-gray-500">
      {children}
    </thead>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-gray-100">{children}</tbody>;
}

export function TH({ className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} scope="col" className={`px-4 py-3 ${className}`} />;
}

export function TD({ className = "", ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={`px-4 py-3 align-top ${className}`} />;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-10 text-center text-gray-500">
        {children}
      </td>
    </tr>
  );
}
