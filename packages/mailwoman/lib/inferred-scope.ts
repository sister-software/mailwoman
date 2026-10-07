/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The conditional-scope check: a locale-inferred country filter yields when the model's own locale head
 * confidently reads the text as a different country's addressing. It only ever drops the scope. The head's
 * country is evidence the text is foreign-shaped, never a resolved country — and it never fires on an explicit
 * caller scope. Caller scope belongs to the pre-scope.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import type { DefaultCountry } from "@mailwoman/core/resolver"

/**
 * Whether a locale-inferred `defaultCountry` should be withheld from the resolve:
 * true only when the scope is inferred and the address's own evidence points away
 * from it, on either of two independent signals.
 *
 * The locale head reads the text as a different country's addressing, or the postcode's
 * format implies a country set that excludes the inferred country.
 * The format signal speaks only on distinctive shapes, so an ambiguous bare 5-digit
 * postcode yields the empty set and keeps the scope.
 *
 * An absent verdict on both signals keeps the scope: unknown is not foreign.
 */
export function shouldDropInferredScope(
	tree: AddressTree,
	defaultCountry: DefaultCountry,
	formatCountries: readonly string[] = []
): boolean {
	if (defaultCountry.source !== "inferred") return false
	const inferred = defaultCountry.country.toUpperCase()
	const verdict = tree.localeCountry

	if (verdict && verdict.country.toUpperCase() !== inferred) return true

	return formatCountries.length > 0 && !formatCountries.some((country) => country.toUpperCase() === inferred)
}
