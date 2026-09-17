/** Direct CPS v8.3.6 GA4 identifier contract. */
export const GA4_ID_RE = /^G-[A-Z0-9]{6,12}$/;

export function normalizeGa4MeasurementId(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed && GA4_ID_RE.test(trimmed) ? trimmed : null;
}
