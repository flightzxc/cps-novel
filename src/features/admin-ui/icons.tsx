/**
 * Inline stroke icons.
 *
 * CPS uses `lucide-react`, but that package is not in this project's
 * dependencies and P1-09 is not authorised to add one. These are hand-drawn
 * equivalents on the same 24px / 1.5 stroke grid so the sidebar reads the same;
 * swapping to lucide later is a dependency request, not a redesign.
 */
export type AdminIconName =
  | "dashboard"
  | "book"
  | "sync"
  | "link"
  | "preview"
  | "carousel"
  | "template"
  | "article"
  | "category"
  | "tag"
  | "task"
  | "revenue"
  | "settings"
  | "shield"
  | "key"
  | "chevron";

const PATHS: Readonly<Record<AdminIconName, readonly string[]>> = Object.freeze({
  dashboard: ["M3 3h7v9H3z", "M14 3h7v5h-7z", "M14 12h7v9h-7z", "M3 16h7v5H3z"],
  book: ["M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z", "M19 3v18"],
  sync: ["M4 12a8 8 0 0 1 13.7-5.7L20 8", "M20 4v4h-4", "M20 12a8 8 0 0 1-13.7 5.7L4 16", "M4 20v-4h4"],
  link: ["M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1", "M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"],
  preview: ["M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  carousel: ["M7 5h10v14H7z", "M4 8v8", "M20 8v8"],
  template: ["M3 4h18v4H3z", "M3 11h8v9H3z", "M14 11h7v9h-7z"],
  article: ["M5 3h11l4 4v14H5z", "M15 3v5h5", "M9 12h7", "M9 16h7"],
  category: ["M4 6h16", "M4 12h16", "M4 18h10"],
  tag: ["M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z", "M8 8h.01"],
  task: ["M4 5h16v16H4z", "M8 3v4", "M16 3v4", "M8 13l2.5 2.5L16 10"],
  revenue: ["M4 20V10", "M10 20V4", "M16 20v-7", "M22 20H2"],
  settings: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  shield: ["M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6z", "M9 12l2 2 4-4"],
  key: ["M15 7a4 4 0 1 1-3.5 5.9L4 20H2v-2l7.1-7.5A4 4 0 0 1 15 7z", "M16.5 7.5h.01"],
  chevron: ["M9 6l6 6-6 6"],
});

export function AdminIcon({
  name,
  className = "h-4 w-4",
}: {
  name: AdminIconName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
