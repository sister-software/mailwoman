/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `synth-po-box`: PO box / PMB / Apartado / BP synthesizer adapter.
 *
 *   Consumes a JSONL stream of (locality, region, postcode, country) tuples — typically extracted
 *   from existing corpus output (TIGER/NAD/BAN/WOF) — and emits synthetic PO box training rows. See
 *   `../../synthesize-po-box.ts` for the per-locale templates and number-noise logic.
 *
 *   Why an adapter and not an augmenter:
 *
 *   - Per USPS Pub 28 / DMM 508, a PO box delivery line is mutually exclusive with a street line.
 *       Synthesizing PO boxes by mutating a street row would teach the model an invalid pattern.
 *       The clean shape is: read just (locality, region, postcode, country) and produce a fresh
 *       PO-box-shaped row.
 *   - Per-DeepSeek (3-turn consult, 2026-05-28): PMB rows that COMBINE a street line with a PMB number
 *       ARE valid (CMRA addresses). Those are produced when `pmbRatio > 0` AND the input tuple
 *       carries a `street` field.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { stableSourceId } from "../../adapter.js"
import { synthesizePoBoxRow, type PoBoxBaseTuple } from "../../synthesize-po-box.js"
import type { AdapterOptions, CanonicalRow, CorpusAdapter } from "../../types.js"

export const SYNTH_PO_BOX_ADAPTER_ID = "synth-po-box"
export const SYNTH_PO_BOX_LICENSE = "Synthetic — derived from CC-BY / public-domain input tuples"

export interface PoBoxInputRow extends PoBoxBaseTuple {
	street?: string
	houseNumber?: string
}

export interface SynthPoBoxAdapterOptions {
	/**
	 * How many PO box variants to emit per input tuple. Each variant picks a different leader (and
	 * possibly a different number / noise level). Default 1.
	 */
	variantsPerInput?: number
	/**
	 * Probability (0..1) of emitting a PMB-with-street variant when both the input has a street and
	 * the locale supports PMB. Default 0.15.
	 */
	pmbRatio?: number
	/**
	 * Deterministic seed for reproducible synthesis. Default Date.now().
	 */
	seed?: number
}

function makeRandom(seed: number): () => number {
	let s = seed
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296
		return s / 4294967296
	}
}

export function createSynthPoBoxAdapter(opts: SynthPoBoxAdapterOptions = {}): CorpusAdapter {
	const variantsPerInput = opts.variantsPerInput ?? 1
	const pmbRatio = opts.pmbRatio ?? 0.15

	return {
		id: SYNTH_PO_BOX_ADAPTER_ID,
		defaultLicense: SYNTH_PO_BOX_LICENSE,
		description:
			"Synthetic PO box / PMB / Apartado / Boîte Postale rows. Consumes JSONL of (locality, region, postcode, country) tuples and emits locale-appropriate PO box variants.",

		async *rows(options: AdapterOptions): AsyncIterable<CanonicalRow> {
			const random = makeRandom(opts.seed ?? Date.now())

			const stream = createReadStream(options.inputPath, { encoding: "utf8" })
			const rl = createInterface({ input: stream, crlfDelay: Infinity })

			let emitted = 0
			let skipped = 0

			for await (const line of rl) {
				if (options.signal?.aborted) break
				if (options.limit !== undefined && emitted >= options.limit) break

				const trimmed = line.trim()
				if (!trimmed) continue

				let input: PoBoxInputRow
				try {
					input = JSON.parse(trimmed) as PoBoxInputRow
				} catch {
					skipped++
					continue
				}

				if (!input.locality || !input.region || !input.postcode || !input.country) {
					skipped++
					continue
				}

				if (options.country && options.country !== input.country) continue

				for (let v = 0; v < variantsPerInput; v++) {
					const synth = synthesizePoBoxRow(input, { random, pmbRatio })
					if (!synth) continue

					// Include `v` in dependent_locality slot to vary the digest across variants;
					// stableSourceId only accepts ComponentTag keys.
					const sourceId = stableSourceId(SYNTH_PO_BOX_ADAPTER_ID, {
						locality: `${input.locality}#${v}`,
						region: input.region,
						postcode: input.postcode,
						country: input.country,
					})

					yield {
						raw: synth.raw,
						components: synth.components,
						country: input.country,
						locale: synth.locale,
						source: SYNTH_PO_BOX_ADAPTER_ID,
						source_id: sourceId,
						corpus_version: "",
						license: SYNTH_PO_BOX_LICENSE,
					}
					emitted++

					if (options.limit !== undefined && emitted >= options.limit) break
				}
			}
		},
	}
}

export const synthPoBoxAdapter = createSynthPoBoxAdapter()
