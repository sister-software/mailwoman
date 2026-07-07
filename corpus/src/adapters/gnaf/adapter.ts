/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   G-NAF (Australia) corpus adapter — the parser-teaching half of #208.
 *
 *   The model mis-parses Australian addresses in their native postcode-first / house-number-last
 *   order: it tags a leading 4-digit postcode as a house number (its US/EU prior) and swaps street
 *   ↔ locality with it. `scripts/eval/au-order-probe.ts` proved this is a word-ORDER coverage gap,
 *   not capability — the same addresses parse perfectly in canonical order (65% → 87% @25km if the
 *   parse were order-robust). EU survives the same eval because its postcodes are
 *   format-distinctive (a hyphenated `26-300` reads as a postcode anywhere); a bare AU `3053` only
 *   disambiguates by position.
 *
 *   So this adapter renders each assembled G-NAF tuple (from {@link ./assemble}) in one of three real
 *   AU layouts — real-AU canonical (number-first, postcode-trailing), postcode-first,
 *   locality-first — ROTATED by row index (`i % 3`), so the locality + postcode each land in every
 *   position across the shard. This is the exact mechanism that fixed #148's v1.9.0 order-overfit
 *   for the 16 EU locales (`scripts/rerender-overture-multiorder.mjs`, v1.9.1 → shipped v4.13.0);
 *   AU was simply never in that train (`country_weights` had no AU, and `data_loader.py` excludes
 *   unlisted countries). Rotating one order per row (rather than emitting all three) keeps this a
 *   clean single-variable extension of the proven recipe + matches its source-mass structure. The
 *   corpus aligner BIO-labels each (every component surface form occurs verbatim in `raw`, so
 *   alignment lands).
 *
 *   Input: the assembled component JSONL (one `{house_number,street,locality,region,postcode}` per
 *   line). Open G-NAF licence — attribute "Geoscape Australia".
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { stableSourceID } from "../../adapter.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const GNAF_ADAPTER_ID = "gnaf"
/** Open G-NAF is freely redistributable with attribution to Geoscape Australia (CC-BY-style). */
export const GNAF_DEFAULT_LICENSE = "CC-BY-4.0"

interface GNAFTuple {
	house_number: string
	street: string
	locality: string
	region?: string
	postcode: string
}

/**
 * The address layouts an AU address actually arrives in. The model already handles postcode-TRAILING (canonical); the
 * two postcode-LEADING forms are the ones it fails, so they carry the lever. We keep the canonical form too so the
 * retrain doesn't forget it.
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
 * Build the G-NAF adapter. `inputPath` is the assembled component JSONL (see {@link ./assemble}); it is country-pinned
 * to AU regardless of `opts.country` (G-NAF is Australia-only).
 */
export function createGNAFAdapter(): CorpusAdapter {
	return {
		id: GNAF_ADAPTER_ID,
		defaultLicense: GNAF_DEFAULT_LICENSE,
		description:
			"G-NAF (Australia): assembled address tuples rendered in multiple word orders (canonical / postcode-first / locality-first) — teaches the model AU's postcode-first layout.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const lines = createInterface({ input: stream, crlfDelay: Infinity })
			let emitted = 0
			let idx = 0

			// rotates the render order (i % 3), matching v1.9.1's rerender
			try {
				for await (const line of lines) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					if (!line.trim()) continue

					let t: GNAFTuple

					try {
						t = JSON.parse(line) as GNAFTuple
					} catch {
						continue
					}

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

					// region (state) rides only the canonical render (order 0); the postcode-leading layouts
					// omit it (matching the eval's serialization) so it never breaks verbatim alignment.
					if (order === 0 && t.region) {
						components.region = t.region
					}

					const aligned = reconcileComponents(components, raw)

					if (Object.keys(aligned).length === 0) continue
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
			} finally {
				lines.close()
				stream.destroy()
			}
		},
	}
}

export const gnafAdapter = createGNAFAdapter()
