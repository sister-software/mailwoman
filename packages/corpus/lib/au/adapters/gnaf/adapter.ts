/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * G-NAF (Australia) corpus adapter.
 *
 * The model mis-parses Australian addresses in their native postcode-first and house-number-last
 * order, where it tags a leading four-digit postcode as a house number and swaps street against
 * locality. This adapter renders each assembled G-NAF tuple (see {@link ./assemble}) in three real
 * AU layouts, rotated by row index, so the locality and postcode each land in every position across
 * the corpus. Input is the assembled component jsonl, one tuple per line. Open G-NAF licence
 * requires attribution to "Geoscape Australia".
 */

/* oxlint-disable mailwoman/prefer-home -- this adapter reads Australia's national register and writes AU surfaces
   only. One of the forms below is a deliberate malformation. The postcode-first order is the dominant failure this
   source exists to teach against — and a renderer that produces well-formed addresses cannot express it. */

import { componentsPresentIn } from "@mailwoman/codex/address-format"
import { tryParsingJSON } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"

import { stableSourceID } from "#adapters/utils"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const GNAF_ADAPTER_ID = "gnaf"
/**
 * Open G-NAF is freely redistributable with attribution to Geoscape Australia (CC-BY-style).
 */
export const GNAF_DEFAULT_LICENSE = "CC-BY-4.0"

interface GNAFTuple {
	house_number: string
	street: string
	locality: string
	region?: string
	postcode: string
}

/**
 * The address layouts an AU address actually arrives in.
 *
 * The model already handles postcode-trailing (canonical); the two postcode-leading
 * forms are the ones it fails, so they carry the change.
 * We keep the canonical form too so the retrain doesn't forget it.
 */
function renderOrders(c: GNAFTuple): string[] {
	const region = c.region ? ` ${c.region}` : ""

	return [
		// real-AU canonical: number-first, street, suburb [state] postcode — "50 Barry Street, Carlton NSW 2000"
		`${c.house_number} ${c.street}, ${c.locality}${region} ${c.postcode}`,
		// postcode-first (the dominant failure): "2000 Carlton, Barry Street 50"
		`${c.postcode} ${c.locality}, ${c.street} ${c.house_number}`,
		// locality-first: "Carlton, 2000, Barry Street 50"
		`${c.locality}, ${c.postcode}, ${c.street} ${c.house_number}`,
	]
}

/**
 * Build the G-NAF adapter.
 *
 * `inputPath` is the assembled component jsonl (see {@link ./assemble}); it is
 * country-pinned to AU regardless of `opts.country` (G-NAF is Australia-only).
 */
export function createGNAFAdapter(): CorpusAdapter {
	return {
		id: GNAF_ADAPTER_ID,
		defaultLicense: GNAF_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.GNAF,
		surface: SurfaceOrigin.Attested,
		description:
			"G-NAF (Australia): assembled address tuples rendered in multiple word orders (canonical / postcode-first / locality-first) — teaches the model AU's postcode-first layout.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			let emitted = 0
			let idx = 0

			// TextSpliterator auto-disposes on loop completion and on an early `break` (abort / limit).
			for await (const line of TextSpliterator.fromAsync(opts.inputPath)) {
				if (opts.signal?.aborted) break

				if (opts.limit !== undefined && emitted >= opts.limit) break

				const t = tryParsingJSON<GNAFTuple>(line)

				if (t === null) continue

				if (!t.house_number || !t.street || !t.locality || !t.postcode) continue

				const orders = renderOrders(t)
				const order = idx % orders.length

				idx++
				const raw = orders[order]!

				const components: CanonicalRow["components"] = {
					house_number: t.house_number,
					street: t.street,
					locality: t.locality,
					postcode: t.postcode,
				}

				// `region` rides only the canonical render, and the postcode-leading layouts
				// omit it so verbatim alignment never breaks.
				if (order === 0 && t.region) {
					components.region = t.region
				}

				// `raw` is one of three deliberate word orders, two of which no layout prints.
				// Containment is therefore checked against the string this adapter built.
				const aligned = componentsPresentIn(components, raw)

				if (!Object.keys(aligned).length) continue

				yield {
					raw,
					components: aligned,
					country: "AU",
					locale: "en-AU",
					source: GNAF_ADAPTER_ID,
					source_id: `${stableSourceID(GNAF_ADAPTER_ID, aligned)}-o${order}`,
					corpus_version: "",
					license: GNAF_DEFAULT_LICENSE,
				}

				emitted++
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const gnafAdapter = createGNAFAdapter()
