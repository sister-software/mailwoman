/**
 * @file Clean fixture for `docs/.vale-code.ini` + `Mailwoman/AmbiguousShorthandCode.yml`. Zero alerts, of any severity.
 *   Every name below is in the rule's exceptions list because it is a real artifact — a package, a command, or a
 *   tracked filename — and prose that means one of them spells it in full. That is the "name the artifact by its
 *   filename" remedy, not an escape from it. promotion-eval.ts refuses a candidate carrying a known regression and
 *   prints the ledger command on a pass. @mailwoman/locale-gate derives the hint the pipeline reads. v1-parse-eval,
 *   boundary-stress-eval and fr-admin-split-eval each grade a different board. mwdev_gate answers from the warm engine.
 *   The prose remedies read naturally: the promotion eval REFUSES a regression, the parser is RESTRICTED to one locale,
 *   a release is PUBLISHED, a branch comes FROM origin/main, and the boundary between two packages is the PlaceLookup
 *   interface.
 */

/**
 * Anchors the fixture as a module. The assertion is that the comments above produce no alerts.
 */
export const clean = 1
