/**
 * @file Clean fixture for `config/vale/.vale-code.ini` + `AmbiguousShorthandCode.yml`. Zero alerts, of any severity.
 *   Every name below is in the rule's exceptions list because it is a real artifact — a package, a command, or a
 *   tracked filename — and prose that means one of them spells it in full. That is the "name the artifact by its
 *   filename" rule. This documents an artifact name. promotion-eval.ts refuses a candidate carrying a known regression
 *   and prints the ledger command on a pass. @mailwoman/locale-hint derives the hint the pipeline reads. v1-parse-eval,
 *   boundary-stress-eval and fr-admin-split-eval each grade a different board. mwdev_promotion_eval answers from the
 *   warm engine. The prose examples read naturally: the promotion eval refuses a regression, the parser is restricted
 *   to one locale, a release is published, a branch comes from origin/main, and the boundary between two packages is
 *   the PlaceLookup interface. Acronyms beside each other stay capitalised: the WOF FTS5 index, a BIO label, the ONNX
 *   graph, a USPS suffix. So do a SQL run such as NOT NULL, and a country list such as BE, NL, LU. A SQL fragment
 *   quoted in a comment stays quiet even though Vale reads the comment as plain text: SELECT id FROM t WHERE x = ? AND
 *   y = ?, spr.id IN (SELECT id FROM ancestors), a.pre <= d.pre AND d.post <= a.post, valid_from <= asOf AND (valid_to
 *   IS NULL OR valid_to > asOf), placetype='postalcode' AND country_id = ?. A code sense of a two-letter word stays
 *   quiet too: Portland, OR 97215, Whitby ON (128,377), Berlin (BE) and Saxony (SN), a weight of 1.0 with BE: on the
 *   next line.
 */

/**
 * Anchors the fixture as a module.
 *
 * The assertion is that the comments above produce no alerts.
 */
export const clean = 1

// The provenance grade of a zoning row is either `authoritative` or `inferred`.
// Each row has exactly one provenance grade.
// The grades never merge.
// Each artifact contains rows of one provenance grade only.
