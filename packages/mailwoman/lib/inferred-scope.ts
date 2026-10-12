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

import { addressSystemKey, layoutForCountry } from "@mailwoman/codex/address/layouts"
import type { AddressTree } from "@mailwoman/core/decoder"
import type { DefaultCountry } from "@mailwoman/core/resolver"
import { LOCALE_COUNTRIES } from "@mailwoman/neural/labels"

/**
 * The countries the locale head has a class for.
 */
const LOCALE_HEAD_COUNTRIES: ReadonlySet<string> = new Set(LOCALE_COUNTRIES)

/**
 * Returns the codex address-system key of a country's default layout, or null
 * when codex has no layout for it.
 */
function addressSystemOf(country: string): string | null {
	const layout = layoutForCountry(country)

	return layout ? addressSystemKey(layout) : null
}

/**
 * Returns whether the locale head's country is evidence against the inferred country.
 *
 * A head with a class for the inferred country would have read that class,
 * so any other country contradicts it.
 * A head without that class reads the text as the nearest class it has.
 *
 * Its verdict then contradicts the inferred country only when the codex address systems of the two differ.
 * The head reads a New Zealand address as GB, and codex gives NZ and GB the same component order.
 */
function verdictContradicts(verdict: string, inferred: string): boolean {
	if (verdict === inferred) return false

	if (LOCALE_HEAD_COUNTRIES.has(inferred)) return true

	const verdictSystem = addressSystemOf(verdict)

	return verdictSystem === null || verdictSystem !== addressSystemOf(inferred)
}

/**
 * Whether a locale-inferred `defaultCountry` should be withheld from the resolve:
 * true only when the scope is inferred and the address's own evidence points away
 * from it, on either of two independent signals.
 *
 * The locale head reads the text as a different country's addressing, or the postcode's
 * format implies a country set that excludes the inferred country.
 * The head's verdict counts only under the rule in {@link verdictContradicts}.
 *
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

	if (verdict && verdictContradicts(verdict.country.toUpperCase(), inferred)) return true

	return formatCountries.length > 0 && !formatCountries.some((country) => country.toUpperCase() === inferred)
}
