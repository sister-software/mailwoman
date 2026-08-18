/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1684 — the conditional-scope gate: a locale-INFERRED country filter yields when the model's own locale head
 *   confidently reads the text as a DIFFERENT country's addressing.
 *
 *   The measured basis (2026-08-19, the graded scope compare + witness traces):
 *
 *   - `Nanjing Road, Huangpu, Shanghai` under the inferred en-US scope answered a zero-prominence West Virginia
 *     namesake 11,899 km off; the head read GB 1.00 (emphatically not-US — the head cannot say CN).
 *   - `12 Rue du Chat-qui-Pêche, Paris` answered Paris Township, Michigan; the head read FR 1.00.
 *   - `75008` reads US 1.00 — the gate NEVER fires, keeping the Dallas ZIP the locale prior exists to protect.
 *   - `Sacremento` reads FR 0.53 — under the head's action threshold, the gate never fires, and the fuzzy tier keeps
 *     answering Sacramento CA.
 *
 *   Two commitments, both measured rather than chosen: the gate only ever DROPS the scope (the head's country is
 *   evidence the text is foreign-shaped, never a resolved country — re-pointing to GB for a Chinese address would
 *   trade one wrong filter for another), and it never fires on an EXPLICIT caller scope (that contract belongs to
 *   #1735's pre-scope). Abstention-filling was measured out separately: unscoping empty results won 2 of 28 fills on
 *   the graded run, so absence stays honest — this gate changes which candidates RACE, not whether silence becomes an
 *   answer.
 */

import type { AddressTree } from "@mailwoman/core/decoder"

/**
 * Whether a locale-inferred `defaultCountry` should be withheld from the resolve — true only when the scope is inferred
 * AND the parse carries a confident locale-head verdict for a different country. An absent verdict (under threshold, or
 * the head never ran) keeps the scope: unknown is not foreign.
 */
export function shouldDropInferredScope(
	tree: AddressTree,
	defaultCountry: string,
	defaultCountryIsInferred: boolean
): boolean {
	if (!defaultCountryIsInferred) return false
	const verdict = tree.localeCountry

	if (!verdict) return false

	return verdict.country.toUpperCase() !== defaultCountry.toUpperCase()
}
