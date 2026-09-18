/**
 * @file Dirty fixture for `config/vale/.vale-code.ini` + `AmbiguousShorthandCode.yml`. Every line below must trip the
 *   rule. the `vocab-census` check in `packages/repo-health` also uses this file as its positive control, so it must
 *   keep containing the words permanently — it is excluded from the census COUNT for the same reason, a fixture is not
 *   repository prose. The gate blocks a release when the count grows. A seam between two packages moved. We cut a new
 *   shard before the check runs.
 */

// BACKTICKS DO NOT EXEMPT A CODE COMMENT. This is the negative assertion that matters most:
// Vale's markdown parser skips inline code, its comment scanner does not, so `the gate` below
// MUST still fire. If it ever stops firing, the Code rule has been replaced by the markdown one
// and every contract in the exceptions list is being protected by the wrong mechanism.
// Here it is: `the gate` and `a seam`.

// A dosage is not a metric; describe the measured rows.
// Anchored, not bare.

// `ShellNoun.yml` runs over source comments through the same config, and each
// clause below must trip it: the probe confirmed the guard, the guard holds, we recover the win
// and keep the affix win, the cost was carried entirely by one class, 3-digit is the reduce, and
// we take this to 8k.
// The probe validated the guard, the result stands, the gain held, and the regression was carried by postcode tokens.

// `EmphasisCapitals.yml` refuses an ordinary word set in capitals between lowercase neighbours,
// and each shape below must trip it: the parser is RESTRICTED to one locale, the row is ABSENT.
// NOT a ship. The prior is ON by default, and the run was a PURE WIN. A capital before a dash is the
// same shape: the flag is FIXED — nothing else moved; Default OFF — set it per locale; and a clause
// that opens a comment line, # NEW — added this run, trips it too.

/**
 * Anchors the fixture as a module. The alerts are in the comments above; this value is never read.
 */
export const dirty = 1
