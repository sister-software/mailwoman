/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   G-NAF (Australia) corpus adapter — the parser-teaching half of #208.
 *
 *   The model mis-parses Australian addresses in their native postcode-first / house-number-last
 *   order: it tags a leading 4-digit postcode as a house number (its US/EU prior) and swaps street
 *   ↔ locality with it. `scripts/eval/au-order-probe.ts` proved this is a word-ORDER coverage gap, not
 *   capability — the same addresses parse perfectly in canonical order (65% → 87% @25km if the parse
 *   were order-robust). EU survives the same eval because its postcodes are format-distinctive (a
 *   hyphenated `26-300` reads as a postcode anywhere); a bare AU `3053` only disambiguates by position.
 *
 *   So this adapter renders each assembled G-NAF tuple (from {@link ./assemble}) in MULTIPLE orders —
 *   the proven both-order lever (`synthesize-german.ts`, #323), widened to AU's three real layouts:
 *   real-AU canonical (number-first, postcode-trailing), postcode-first, and locality-first. Training
 *   the postcode in every position teaches the model a leading 4-digit can still be a postcode. Each
 *   emitted order is a separate row; the corpus aligner BIO-labels each (every component surface form
 *   occurs verbatim in `raw`, so alignment lands).
 *
 *   Input: the assembled component JSONL (one `{house_number,street,locality,region,postcode}` per
 *   line). Open G-NAF licence — attribute "Geoscape Australia".
 */

import { stableSourceId } from "../../adapter.js"
import { reconcileComponents } from "../../format.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

export const GNAF_ADAPTER_ID = "gnaf"
/** Open G-NAF is freely redistributable with attribution to Geoscape Australia (CC-BY-style). */
export const GNAF_DEFAULT_LICENSE = "CC-BY-4.0"

interface GnafTuple {
	house_number: string
	street: string
	locality: string
	region?: string
	postcode: string
}

/**
 * The address layouts an AU address actually arrives in. The model already handles postcode-TRAILING
 * (canonical); the two postcode-LEADING forms are the ones it fails, so they carry the lever. We keep
 * the canonical form too so the retrain doesn't forget it.
 */
function renderOrders(c: GnafTuple): string[] {
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
 * Build the G-NAF adapter. `inputPath` is the assembled component JSONL (see {@link ./assemble}); it
 * is country-pinned to AU regardless of `opts.country` (G-NAF is Australia-only).
 */
export function createGnafAdapter(): CorpusAdapter {
	return {
		id: GNAF_ADAPTER_ID,
		defaultLicense: GNAF_DEFAULT_LICENSE,
		description:
			"G-NAF (Australia): assembled address tuples rendered in multiple word orders (canonical / postcode-first / locality-first) — teaches the model AU's postcode-first layout.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			const stream = createReadStream(opts.inputPath, { encoding: "utf8" })
			const lines = createInterface({ input: stream, crlfDelay: Infinity })
			let emitted = 0
			try {
				for await (const line of lines) {
					if (opts.signal?.aborted) break
					if (opts.limit !== undefined && emitted >= opts.limit) break
					if (!line.trim()) continue

					let t: GnafTuple
					try {
						t = JSON.parse(line) as GnafTuple
					} catch {
						continue
					}
					if (!t.house_number || !t.street || !t.locality || !t.postcode) continue

					const components: CanonicalRow["components"] = {
						house_number: t.house_number,
						street: t.street,
						locality: t.locality,
						postcode: t.postcode,
					}
					// region (state) rides only the canonical render (index 0); the postcode-leading layouts
					// the eval uses omit it, so keep it off them for verbatim alignment.

					for (const [i, raw] of renderOrders(t).entries()) {
						if (opts.limit !== undefined && emitted >= opts.limit) break
						const comps = i === 0 && t.region ? { ...components, region: t.region } : components
						const aligned = reconcileComponents(comps, raw)
						if (Object.keys(aligned).length === 0) continue
						yield {
							raw,
							components: aligned,
							country: "AU",
							locale: "en-AU",
							source: GNAF_ADAPTER_ID,
							source_id: `${stableSourceId(GNAF_ADAPTER_ID, aligned)}-o${i}`,
							corpus_version: "",
							license: GNAF_DEFAULT_LICENSE,
						}
						emitted++
					}
				}
			} finally {
				lines.close()
				stream.destroy()
			}
		},
	}
}

export const gnafAdapter = createGnafAdapter()
