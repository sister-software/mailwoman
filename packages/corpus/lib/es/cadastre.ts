/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The two ways a Spanish cadastre states that it holds no value, which all four of them share.
 *
 * Spain publishes the INSPIRE Addresses theme through four cadastres: the Dirección General del
 * Catastro for 52 provinces, and the Diputación Foral de Bizkaia, the Diputación Foral de Gipuzkoa
 * and the Gobierno de Navarra for their own territories. Each has its own adapter, because each
 * states its own terms and writes its own file layout. They agree on these two conventions, and
 * reading either of them as data rather than as an absence puts a token where a corpus row expects a
 * number or a postcode.
 */

import { designator } from "#inspire/address"

/**
 * The *sin número* tokens the Spanish cadastres write, lower-cased for comparison.
 *
 * `S-N` is the Dirección General del Catastro's spelling, on 856 of Ceuta's 8,126 addresses.
 * `S/N` is the Gobierno de Navarra's and the Diputación Foral de Gipuzkoa's.
 *
 * Both are accepted by each of the four readers.
 * Neither is a number under any jurisdiction's rules, and the files measured are a few municipalities
 * out of the 52 provinces, 112 municipalities and 272 partitions those services publish,
 * so a reader scoped to the one spelling its own sample carried would write the other into a row.
 */
const SIN_NUMERO = new Set(["s-n", "s/n"])

/**
 * Whether a designator value states that the address has no number.
 *
 * The whole value has to be the token.
 * A value that carries more, such as Gipuzkoa's `S/N-A`, `S/N-C` and `S/N-5`,
 * states something further and is kept as the publisher wrote it: what the trailing part
 * designates is not established, dropping it would merge several addresses of one building,
 * and rewriting it would state a number the publisher did not.
 */
export function isSinNumero(value: string): boolean {
	return SIN_NUMERO.has(value.trim().toLowerCase())
}

/**
 * The house number a Spanish cadastre states, or undefined where it states that there is none.
 *
 * @param types The publisher's own designator types, in the caller's order of precedence.
 * The Dirección General del Catastro writes the type as the element text `1`, while Navarra
 * and Gipuzkoa write the `LocatorDesignatorTypeValue/addressIdentifierGeneral` codelist URI.
 */
export function spanishHouseNumber(
	byType: ReadonlyMap<string, readonly string[]>,
	...types: readonly string[]
): string | undefined {
	const value = designator(byType, ...types)

	if (!value || isSinNumero(value)) return undefined

	return value
}

/**
 * Whether a component reference's key states that the publisher holds no value for that component.
 *
 * A Spanish cadastre's feature identifier is a dotted path whose last segment is the value:
 * the Cadastre's postal descriptors in Ceuta are `ES.SDGC.PD.55.101.51001` through
 * `…51005`, and Gipuzkoa's are `ES.GFA.PD.056.20830`.
 * Where the cadastre holds no postcode it writes the same identifier with that segment empty,
 * `ES.SDGC.PD.55.101.` and `ES.GFA.PD.059.`, against no feature of that id.
 *
 * Those truncated references are the only unresolvable ones measured in either
 * file: 70 of Ceuta's 8,126 addresses carry one, while its thoroughfare
 * and administrative-unit references resolve 8,126 of 8,126 each.
 * A reader taking every unresolved reference as an absence would also swallow a genuinely
 * broken join, so the two are separated here and every other unresolved reference raises.
 */
export function referenceStatesNoValue(key: string): boolean {
	return key.trim().endsWith(".")
}
