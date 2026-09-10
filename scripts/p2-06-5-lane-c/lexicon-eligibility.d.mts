export interface LaneCEligibilityRule {
  grade: string | null;
  canonicalTagId: string;
  normalizedSeed: string;
  enabled: boolean;
  allowedFields: string[] | null;
  blockedDescriptionNamedScopes: string[];
  reason: string;
  changeReason: string;
}

export interface LaneCEligibilityOverlay {
  version: string;
  namedScopeLabels: Record<string, string>;
  rules: LaneCEligibilityRule[];
  byKey: Map<string, LaneCEligibilityRule>;
}

export const OVERLAY_SHA256_BY_VERSION: Readonly<Record<string, string>>;
export const ELIGIBILITY_VERSION: string;
export const EXPECTED_OVERLAY_SHA256: string;
export function normalizeSeed(value: string): string;
export function overlayRuleKey(canonicalTagId: string, normalizedSeed: string): string;
export function validateLexiconOverride(raw: unknown): LaneCEligibilityOverlay;
export function loadLexiconOverride(path: string, expectedSha256?: string | null): Promise<{
  overlay: LaneCEligibilityOverlay;
  sha256: string;
  path: string;
}>;
