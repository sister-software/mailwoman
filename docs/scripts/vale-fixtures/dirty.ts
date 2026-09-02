/**
 * @file Dirty fixture for `docs/.vale-code.ini` + `Mailwoman/AmbiguousShorthandCode.yml`. Every line below must trip
 *   the rule. `scripts/vocab-census.ts` also uses this file as its positive control, so it must keep containing the
 *   words permanently — it is excluded from the census COUNT for the same reason, a fixture is not repository prose.
 *   The gate blocks a release when the count grows. A seam between two packages moved. We cut a new shard before the
 *   check runs.
 */

// BACKTICKS DO NOT EXEMPT A CODE COMMENT. This is the negative assertion that matters most:
// Vale's markdown parser skips inline code, its comment scanner does not, so `the gate` below
// MUST still fire. If it ever stops firing, the Code rule has been replaced by the markdown one
// and every contract in the exceptions list is being protected by the wrong mechanism.
// Here it is: `the gate` and `a seam`.

/**
 * Anchors the fixture as a module. The alerts are in the comments above; this value is never read.
 */
export const dirty = 1
