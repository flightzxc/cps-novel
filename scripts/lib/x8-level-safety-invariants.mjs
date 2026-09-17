/**
 * Single source of truth for the P2-06.5 auto-classification ADR guard: the
 * level table's own auto-write flags must be frozen at these exact values,
 * independent of whatever scripts/lib/x8-levels.json (or a release identity
 * bound to it) actually contains, until Owner explicitly authorizes
 * auto-write. Two call sites assert against this SAME list -- via this one
 * module -- so a change to one can never silently diverge from the other:
 *
 *   - scripts/acceptance/x8-validate-compose.mjs: the table-level check
 *     (levelEntry.flags) run as part of the compose compliance validator;
 *   - scripts/lib/x8-production-like-env.sh's x8_assert_level_safety_invariants():
 *     the gate command's own check, run on the level config it resolves
 *     from the release identity's recorded levels-file path, immediately
 *     after verifying that file's content digest and strictly before
 *     touching any container. That digest check only proves the table has
 *     not changed since 'up' produced the identity -- it says nothing about
 *     whether the table's CONTENT was ever safe, which is exactly what this
 *     invariant list exists to police independently of it.
 */
export const LEVEL_SAFETY_INVARIANTS = Object.freeze([
  Object.freeze({ key: "FEATURE_NOVEL_TAG_AUTO", expected: "false" }),
  Object.freeze({ key: "AUTO_WRITE_AUTHORIZED", expected: "NO" }),
]);

/**
 * Checks `flags` (a level's resolved flag map, or a rendered service's
 * environment) against every invariant above. Returns the list of
 * violations, in the SAME order as LEVEL_SAFETY_INVARIANTS (empty when
 * everything matches), rather than throwing -- so each caller can format
 * its own fail-closed error text instead of sharing message wording.
 */
export function findLevelSafetyInvariantViolations(flags) {
  const violations = [];
  for (const { key, expected } of LEVEL_SAFETY_INVARIANTS) {
    const actual = flags == null ? undefined : flags[key];
    if (actual !== expected) violations.push({ key, expected, actual });
  }
  return violations;
}
