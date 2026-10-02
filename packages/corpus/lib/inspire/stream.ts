/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads addresses out of one INSPIRE document that interleaves them with the features they
 *   reference.
 *
 * A publisher shipping the Addresses theme as one document writes an `ad:Address` beside the
 * `ad:ThoroughfareName`, `ad:PostalDescriptor` and place-name features it references, and the order
 * is the publisher's own. Czechia interleaves them per municipality, and the Netherlands writes
 * 300,318 reference features before its first address.
 *
 * Either way a reader has to index as it goes, because a document of 32 GB cannot be read twice from
 * one stream and the references are local. An address naming a feature the pass has not reached yet
 * is held rather than refused, since until the document ends an unresolved reference and an absent
 * one are the same observation. That distinction is what the repository's partial-read rule turns on.
 *
 * A publisher that writes every reference before any address, as Wallonia, Brussels and Slovakia do,
 * needs no holding and indexes in a pass of its own instead. Those adapters call
 * `streamMarkupElements` directly.
 */

import type { MarkupElement } from "@mailwoman/core/html/elements"
import { streamMarkupElements } from "@mailwoman/core/html/elements"

import type { CanonicalRow } from "#types"

/**
 * What a {@linkcode ComposeInspireRow} callback answers for one address.
 *
 * A row is emitted.
 * `undefined` refuses the address, which the caller counts.
 *
 * `deferred` states that the address carries a reference the pass has not indexed yet,
 * so the driver holds it and asks again once the document has ended.
 */
export type InspireRowResult = CanonicalRow | undefined | "deferred"

/**
 * Builds one row from an address and the references indexed so far.
 *
 * @param address The `ad:Address` subtree, with its attributes and children.
 * @param referenced Every referenced feature the pass has indexed, keyed as
 * {@linkcode StreamInspireRowsOptions.key} spells it.
 * @param final Whether the document has ended.
 * A caller returns `deferred` only while this is false, because afterwards an unresolved
 * reference is an absence the publisher is answerable for.
 */
export type ComposeInspireRow<Indexed> = (
	address: MarkupElement,
	referenced: ReadonlyMap<string, Indexed>,
	final: boolean
) => InspireRowResult

/**
 * How to read one publisher's document.
 */
export interface StreamInspireRowsOptions<Indexed> {
	/**
	 * The document's bytes, in order.
	 */
	chunks: AsyncIterable<string | Uint8Array>

	/**
	 * The element each address is written as, which every INSPIRE publisher spells `ad:Address`.
	 */
	addressElement?: string

	/**
	 * The elements an address references, which are indexed as they arrive.
	 */
	componentElements: readonly string[]

	/**
	 * What to index a referenced feature under.
	 *
	 * The default is its `gml:id`, which is what a local `#` fragment
	 * and a stored-query `Id` parameter both name.
	 * A feature carrying no key is skipped, because an address cannot reference it.
	 */
	key?: (feature: MarkupElement) => string | undefined

	/**
	 * What to keep per referenced feature.
	 *
	 * Czechia keeps the subtree, because it reads several values off one feature.
	 * The Netherlands keeps the one string it needs, which holds 300,318 strings
	 * rather than 300,318 subtrees.
	 */
	index: (feature: MarkupElement) => Indexed

	/**
	 * Builds a row, or defers it.
	 */
	compose: ComposeInspireRow<Indexed>

	/**
	 * A soft cap on emitted rows.
	 */
	limit?: number

	/**
	 * Stops the read where a caller cancels.
	 */
	signal?: AbortSignal
}

/**
 * The default key a referenced feature is indexed under.
 */
function gmlID(feature: MarkupElement): string | undefined {
	return feature.attributes["gml:id"]
}

/**
 * The rows one document holds, in the order the publisher wrote its addresses.
 *
 * A held address is answered after the document ends, so those rows arrive last.
 * That reorders a publisher's output and changes no row, because each row carries its own `source_id`.
 */
export async function* streamInspireRows<Indexed>(
	options: StreamInspireRowsOptions<Indexed>
): AsyncIterable<CanonicalRow> {
	const addressElement = options.addressElement ?? "ad:Address"
	const key = options.key ?? gmlID

	/**
	 * Every referenced feature the pass has indexed.
	 */
	const referenced = new Map<string, Indexed>()
	/**
	 * Addresses naming a reference the pass had not indexed when they arrived.
	 */
	const held: MarkupElement[] = []
	let emitted = 0

	const wanted = [addressElement, ...options.componentElements]

	for await (const element of streamMarkupElements(options.chunks, wanted, { xml: true })) {
		if (options.signal?.aborted) return

		if (element.name !== addressElement) {
			const id = key(element)

			if (id) {
				referenced.set(id, options.index(element))
			}

			continue
		}

		if (options.limit !== undefined && emitted >= options.limit) break

		const row = options.compose(element, referenced, false)

		if (row === "deferred") {
			held.push(element)

			continue
		}

		if (!row) continue

		yield row

		emitted++
	}

	for (const element of held) {
		if (options.signal?.aborted) return

		if (options.limit !== undefined && emitted >= options.limit) break

		const row = options.compose(element, referenced, true)

		// `deferred` after the document ended is a caller that ignored `final`,
		// and the row is refused rather than held again, which would never terminate.
		if (!row || row === "deferred") continue

		yield row

		emitted++
	}
}
