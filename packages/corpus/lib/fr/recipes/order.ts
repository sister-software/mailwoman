/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate canonical and reversed French addresses from real OpenAddresses tuples. Reversed forms
 *   vary postcode, locality, and street order. Optional sub-modes add ordinal house numbers and
 *   uppercase localities. `--golden` emits a held-out evaluation set.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import { dataRootPath } from "@mailwoman/core/data-root"
import { stringifyJSON } from "@mailwoman/core/json"
import { isPresent } from "@mailwoman/core/objects"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"

import { stableSourceID } from "#adapters/utils"
import { readOATuples, type CorpusRecipe } from "#recipes/scaffold"
import type { CanonicalRow } from "#types"
import { alignRow } from "#utils"

const SOURCE = { zip: dataRootPath("oa-cache", "fr__countrywide.zip"), csv: "fr/countrywide.csv" }

/**
 * French house-number ordinal suffixes.
 */
const ORDINAL_SUFFIXES: readonly string[] = ["bis", "ter", "quater"]
/**
 * Probability of adding an ordinal suffix.
 */
const ORDINAL_PROB = 0.12
/**
 * Probability of rendering a locality in uppercase.
 */
const ALLCAPS_PROB = 0.1

/**
 * French tuple read from the cached OpenAddresses archive.
 */
interface FrTuple {
	house_number: string
	street: string
	locality: string
	postcode: string
}

/**
 * Read up to `limit` distinct tuples with house numbers and postcodes.
 */
async function readTuples(limit: number): Promise<FrTuple[]> {
	return readOATuples(SOURCE, {
		limit,
		requirePostcode: true,
		dedupIncludesPostcode: true,
		extra: (fields) => fields,
	})
}

/**
 * Optionally append an ordinal suffix to a house number.
 */
function maybeAddOrdinal(random: () => number, house_number: string): string {
	if (random() >= ORDINAL_PROB) return house_number
	const suffix = sample(ORDINAL_SUFFIXES, random)

	// Include lowercase and uppercase suffix forms.
	return `${house_number} ${random() < 0.5 ? suffix : suffix.toUpperCase()}`
}

/**
 * Render a tuple in canonical French order.
 */
function renderCanonical(
	hn: string,
	street: string,
	postcode: string,
	locality: string
): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const raw = `${hn} ${street}, ${postcode} ${locality}`

	return { raw, components: { house_number: hn, street, postcode, locality } }
}

// Cumulative cutoffs for four reversed layouts.
const REVERSED_VARIANT_A_CUTOFF = 0.25
const REVERSED_VARIANT_B_CUTOFF = 0.5
const REVERSED_VARIANT_C_CUTOFF = 0.75

/**
 * Recipe registered with the corpus builder.
 */
export const frOrderRecipe: CorpusRecipe = {
	name: "fr-order",
	description: "French reversed-order rows (#560): real OA FR tuples rendered canonical + 4 postcode-first variants",
	mode: "generate",
	options: [
		{ flag: "--reversed-fraction <p>", description: "Fraction rendered reversed-order. Default 0.5" },
		{ flag: "--golden", description: "Emit the held-out reversed-order eval set" },
	],
	async run(opts, write) {
		if (opts.count == null) throw new Error("fr-order recipe requires --count <N>")
		const count = opts.count
		// Preserve the legacy random stream for generated rows.
		const random = makeMulberry32(opts.seed)
		const source = opts.sourceName ?? "synth-fr-order"
		const reversedFraction = opts.reversedFraction ?? 0.5

		// Read extra rows to account for filtering and deduplication.
		const poolLimit = Math.max(count * 8, 40_000)
		const pool = await readTuples(poolLimit)

		console.error(`  ${SOURCE.csv}: ${pool.length} unique tuples (capped read)`)

		if (!pool.length) {
			throw new Error(`No FR tuples found — is ${SOURCE.zip} present?`)
		}

		let emitted = 0
		let skipped = 0
		let guard = 0
		const N = pool.length

		while (emitted < count && guard++ < count * 10) {
			const base = pool[Math.floor(random() * N)]!
			const { street, postcode } = base
			const locality = random() < ALLCAPS_PROB ? base.locality.toUpperCase() : base.locality
			const house_number = maybeAddOrdinal(random, base.house_number)

			// Choose canonical or reversed order.
			const isReversed = random() < reversedFraction

			let rendered: { raw: string; components: Partial<Record<ComponentTag, string>> }

			if (isReversed) {
				const variantRoll = random()
				let raw: string

				if (variantRoll < REVERSED_VARIANT_A_CUTOFF) {
					// Postcode and locality before number and street.
					raw = `${postcode} ${locality}, ${house_number} ${street}`
				} else if (variantRoll < REVERSED_VARIANT_B_CUTOFF) {
					// Locality, postcode, number, and street.
					raw = `${locality}, ${postcode}, ${house_number} ${street}`
				} else if (variantRoll < REVERSED_VARIANT_C_CUTOFF) {
					// Locality, number, street, and postcode without commas.
					raw = `${locality} ${house_number} ${street} ${postcode}`
				} else {
					// Postcode, number, street, then locality.
					raw = `${postcode}, ${house_number} ${street}, ${locality}`
				}

				rendered = { raw, components: { house_number, street, postcode, locality } }
			} else {
				rendered = renderCanonical(house_number, street, postcode, locality)
			}

			const { raw, components } = rendered

			// Require each component value to appear verbatim in the address.
			const componentValues = Object.values(components).filter(isPresent)

			if (!componentValues.every((v) => raw.includes(v))) {
				skipped++

				continue
			}

			// Golden output carries parse truth without corpus metadata.
			if (opts.golden) {
				write(stringifyJSON({ raw, components, country: "FR" }))

				emitted++

				continue
			}

			const sourceID = stableSourceID(source, {
				street: components.street,
				house_number: components.house_number,
				locality: components.locality,
				postcode: components.postcode,
			})

			const canonical: CanonicalRow = {
				raw,
				components,
				country: "FR",
				locale: "fr-FR",
				source,
				source_id: sourceID,
				corpus_version: "0.5.0",
				license: "OpenAddresses FR countrywide tuples, rendered canonical + reversed-order — see ingest SOURCE",
			}

			const aligned = alignRow(canonical)

			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++

				continue
			}

			write(
				stringifyJSON({
					...aligned.row,
					synth_method: "fr-order",
					synth_order: isReversed ? "reversed" : "canonical",
					synth_base_id: null,
				})
			)

			emitted++
		}

		return { emitted, skipped }
	},
}
