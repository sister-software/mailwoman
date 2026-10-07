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
 * is the publisher's own. Czechia interleaves them per municipality, and the Netherlands writes its
 * reference features before its first address.
 *
 * Either way a reader has to index as it goes, because a 32 GB document cannot be read twice from
 * one stream and the references are local. An address naming a feature the pass has not reached yet
 * is held rather than refused, since until the document ends an unresolved reference and an absent
 * one are the same observation. That distinction is what the repository's partial-read rule turns on.
 *
 * A publisher that writes every reference before any address, as Wallonia, Brussels and Slovakia do,
 * needs no holding and indexes in a pass of its own instead. Those adapters call
 * `streamMarkupElements` directly.
 *
 * A publisher that writes every reference *after* its addresses needs the opposite of holding, and
 * {@linkcode streamIndexedInspireRows} serves it. The Dirección General del Catastro and the
 * Diputación Foral de Gipuzkoa both do, so holding would leave every address pending. Those two
 * read the member twice and index first.
 */

import type { MarkupElement } from "@mailwoman/core/html/elements"
import { streamMarkupElements } from "@mailwoman/core/html/elements"

import type { CanonicalRow } from "#types"

/**
 * What a {@linkcode ComposeInspireRow} callback answers for one address.
 *
 * A row is emitted.
 * `null` refuses the address.
 * The caller counts each refusal.
 *
 * `deferred` states that the address holds a reference the pass has not indexed yet,
 * so the driver holds it and asks again once the document has ended.
 */
export type InspireRowResult = CanonicalRow | null | "deferred"

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
	 * The element each address is written as.
	 * Every INSPIRE publisher spells it `ad:Address`.
	 */
	addressElement?: string

	/**
	 * The elements an address references.
	 * The reader indexes them as they arrive.
	 */
	componentElements: readonly string[]

	/**
	 * What to index a referenced feature under.
	 *
	 * The default is its `gml:id`, which is what a local `#` fragment
	 * and a stored-query `Id` parameter both name.
	 * A feature carrying no key is skipped, because an address cannot reference it.
	 */
	key?: (feature: MarkupElement) => string | null

	/**
	 * What to keep per referenced feature.
	 *
	 * Czechia keeps the subtree, because it reads several values off one feature.
	 * The Netherlands keeps the one string it needs.
	 * That holds 300,318 strings rather than 300,318 subtrees.
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
function gmlID(feature: MarkupElement): string | null {
	return feature.attributes["gml:id"] ?? null
}

/**
 * The rows one document holds, in the order the publisher wrote its addresses.
 *
 * A held address is answered after the document ends, so those rows arrive last.
 * That reorders a publisher's output and changes no row, because each row holds its own `source_id`.
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

		// `deferred` after the document ended is a caller that ignored `final`.
		// The row is refused, because holding it again would never terminate.
		if (!row || row === "deferred") continue

		yield row

		emitted++
	}
}

/**
 * How to read one publisher's document twice, indexing its references before reading its addresses.
 */
export interface StreamIndexedInspireRowsOptions<Indexed> extends Omit<
	StreamInspireRowsOptions<Indexed>,
	"chunks" | "compose"
> {
	/**
	 * Opens the document's bytes.
	 *
	 * Called once per pass, so it must deliver the same bytes each time.
	 *
	 * A factory rather than an iterable, because a byte stream is consumed by the first pass.
	 * `inspireGMLChunks` inflates the archive member again.
	 *
	 * That is what makes the second pass cheap relative to holding every address.
	 */
	chunks: () => AsyncIterable<string | Uint8Array>

	/**
	 * Builds a row from an address and the complete reference index.
	 *
	 * There is no `final` argument and no deferral: the first pass has read the whole document,
	 * so a reference resolving to no feature is a value the reader asked for and could not read.
	 * The caller raises on one rather than writing the address without it.
	 */
	compose: (address: MarkupElement, referenced: ReadonlyMap<string, Indexed>) => CanonicalRow | null
}

/**
 * The rows one document holds, read with its reference index already complete.
 *
 * The first pass reads only the component elements and the second only the addresses,
 * so the resident set is the index rather than the addresses.
 * The rows arrive in the publisher's own order. {@linkcode streamInspireRows}
 * cannot promise because it answers a held address last.
 */
export async function* streamIndexedInspireRows<Indexed>(
	options: StreamIndexedInspireRowsOptions<Indexed>
): AsyncIterable<CanonicalRow> {
	const addressElement = options.addressElement ?? "ad:Address"
	const key = options.key ?? gmlID
	const referenced = new Map<string, Indexed>()

	for await (const feature of streamMarkupElements(options.chunks(), options.componentElements, { xml: true })) {
		if (options.signal?.aborted) return

		const id = key(feature)

		if (id) {
			referenced.set(id, options.index(feature))
		}
	}

	let emitted = 0

	for await (const address of streamMarkupElements(options.chunks(), addressElement, { xml: true })) {
		if (options.signal?.aborted) return

		if (options.limit !== undefined && emitted >= options.limit) return

		const row = options.compose(address, referenced)

		if (!row) continue

		yield row

		emitted++
	}
}
