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

import { formatAddressRow } from "@mailwoman/codex/address/format"

import { stableSourceID } from "#adapters/source-id"
import { designator } from "#inspire/address"
import type { CanonicalRow } from "#types"

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

/**
 * What a cadastre's reader has read from one address, before it becomes a row.
 *
 * Each of the four readers resolves these from a different file layout, and `cadastralRow` turns any
 * of them into the same row, so the layout stays in the adapter and the row shape has one home.
 */
export interface CadastralAddress {
	/**
	 * The thoroughfare name the address references, absent where the publisher writes none.
	 */
	street: string | undefined
	/**
	 * The house number this cadastre's own designator type states.
	 */
	house: string | undefined
	/**
	 * The postal descriptor's code.
	 */
	postcode: string | undefined
	/**
	 * The municipality-level administrative unit's name.
	 */
	locality: string | undefined
	/**
	 * The address-area name, which is a settlement within the municipality.
	 */
	settlement: string | undefined
	/**
	 * The publisher's own identifier for the address, which keys `source_id` where it exists.
	 */
	addressID: string | undefined
}

/**
 * What distinguishes one cadastre's rows from another's.
 *
 * The licence differs per publisher, so it is passed rather than derived: Gipuzkoa's register
 * entry elects `CC-BY-SA-4.0` where the other three elect no share-alike obligation.
 */
export interface CadastralSource {
	adapterID: string
	license: string
}

/**
 * One canonical row from what a Spanish cadastre states about one address.
 *
 * All four cadastres publish the INSPIRE Addresses theme, so they agree on how an
 * address becomes a row even though each writes a different file layout.
 * The municipality supplies the locality.
 *
 * The address area supplies a dependent locality only where the two differ.
 * The line renders in Spain's order.
 *
 * Composing that in each adapter repeated 42 lines four times.
 *
 * Returns `undefined` in two cases: the address carries neither a municipality
 * nor an address area, which would leave the row without a locality, or `formatAddressRow`
 * returns `undefined` for the components it was given.
 */
export function cadastralRow(address: CadastralAddress, source: CadastralSource): CanonicalRow | undefined {
	const place = address.locality ?? address.settlement

	if (!place) return undefined

	const components: CanonicalRow["components"] = {}

	if (address.house) {
		components.house_number = address.house
	}
	if (address.street) {
		components.street = address.street
	}
	if (address.postcode) {
		components.postcode = address.postcode
	}

	components.locality = place

	// The address area is a settlement within the municipality where the two names differ,
	// and repeats the municipality where they do not.
	// Writing the repetition would state a dependent locality the publisher does not hold.
	if (address.settlement && address.locality && address.settlement !== address.locality) {
		components.dependent_locality = address.settlement
	}

	const rendered = formatAddressRow(components, "ES", { singleLine: true })

	if (!rendered) return undefined

	const { raw, components: aligned } = rendered

	return {
		raw,
		components: aligned,
		country: "ES",
		locale: "es-ES",
		// `register` is left to `runAdapter`, which stamps the adapter's own
		// declaration onto a row that omits it.
		// Setting it here would state per row what the adapter already states once.
		source: source.adapterID,
		source_id: address.addressID
			? `${source.adapterID}-${address.addressID}`
			: stableSourceID(source.adapterID, aligned),
		corpus_version: "",
		license: source.license,
	}
}
