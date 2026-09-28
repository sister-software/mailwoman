/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates French street fragments without a postcode from BAN tuples.
 *
 *   The output mixes designator-led streets with bare commune names as counterexamples.
 *   Some streets include a house number.
 *   `--exclude-surfaces` is required so that streets on the fragment evaluation board stay out of training. Training on
 *   these rows needs the French `street_prefix` loss mask disabled.
 */

import { titleCaseFR } from "@mailwoman/codex/fr"
import { sample } from "@mailwoman/core/random"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

import { decomposeFrStreet } from "#fr/adapters/ban/street-decompose"
import { alignAndWrite, readTuples, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * The provenance for every row.
 * Street and commune names both come from BAN.
 */
/**
 * Resolved once, because `source_id` carries the source as its prefix and a pair that
 * disagreed would name a source no row of this output declares.
 */
const FR_FRAGMENT_SOURCE = defaultRecipeSource("synth-fr-fragment")

const FR_FRAGMENT_PROVENANCE = {
	register: SourceRegister.BaseAdresseNationale,
	surface: SurfaceOrigin.Composed,
	// The BAN record behind each row exists.
	// The tuple file has no `sourceID` to identify it.
	// The extraction must emit that ID to populate this field (#2359).
	baseSourceID: null,
}

/**
 * House numbers to sample from.
 * Repeated entries weight the draw toward small values.
 */
const HOUSE_NUMBERS = [
	1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18, 20, 21, 24, 27, 30, 33, 42, 57, 68, 84, 102, 115, 140,
]

/**
 * French repetition and letter suffixes for house numbers.
 */
const ALNUM_SUFFIXES = ["bis", "ter", "A", "B"]

// The reserved-surface list is stored in this folded form: accents stripped, lowercase, single spaces.
const norm = (value: string): string =>
	value
		.normalize("NFD")
		.replaceAll(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replaceAll(/\s+/g, " ")
		.trim()

/**
 * Matches common French particles in a street name.
 */
const PARTICLE = /\b(de la|de l'|du|des|de|d'|le|la|les)\b/i

/**
 * Matches a year or a French day-and-month phrase in a street name.
 */
const DATEISH =
	/\b(1[0-9]|20)\d{2}\b|\b\d{1,2}\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i

// The share of numbered rows whose house number has a suffix.
const ALNUM_HOUSE_NUMBER_SHARE = 0.25

/**
 * The recipe registered with the corpus builder.
 */
export const frFragmentRecipe: CorpusRecipe = {
	name: "fr-fragment",
	description:
		"FR street fragments with NO house number (#727 T2): the house-number-licence change — bare/particle/date-name/homonym + the bare-locality counter",
	mode: "tuples",
	options: [
		{
			flag: "--exclude-surfaces <path>",
			description: "REQUIRED. The fragment board's reserved surface list; every listed street is skipped.",
		},
		{
			flag: "--hn-prob <n>",
			description: "Share of rows carrying a house number (default 0.35 — the anchor, not the point)",
		},
		{
			flag: "--bare-prob <n>",
			description: "Share of NO-house-number rows that are bare LOCALITIES (default 0.25 — the counter)",
		},
	],
	async run(opts, write) {
		const random = makeMulberry32(opts.seed)
		const excludePath = opts.excludeSurfaces

		if (!excludePath) {
			throw new Error(
				"fr-fragment: --exclude-surfaces is REQUIRED. Pass the fragment board's reserved list " +
					"(mailwoman/eval-harness/fixtures/ban-fragments-fr.surfaces.txt) or this recipe trains on its own eval set. " +
					"Source-disjoint by street SURFACE is the split discipline; there is no safe default."
			)
		}

		const excluded = new Set<string>()

		for await (const line of TextSpliterator.fromAsync(excludePath)) {
			if (!line.startsWith("#")) {
				excluded.add(line)
			}
		}

		if (!excluded.size) throw new Error(`fr-fragment: --exclude-surfaces "${excludePath}" listed no surfaces`)

		const hnProb = opts.hnProb ?? 0.35
		const bareLocalityProb = opts.bareProb ?? 0.25

		// Commune names collected here feed the bare-locality counterexamples.
		const localities = new Set<string>()

		let read = 0
		let emitted = 0
		let skipped = 0
		let contaminated = 0

		for await (const tuple of readTuples(opts.input!)) {
			read++
			const fullStreet = String(tuple.street ?? "").trim()
			const locality = String(tuple.locality ?? "").trim()

			if (locality) {
				localities.add(locality)
			}

			if (!fullStreet) {
				skipped++

				continue
			}

			if (excluded.has(norm(fullStreet))) {
				contaminated++

				continue
			}

			const { prefix, street } = decomposeFrStreet(fullStreet)

			// The recipe keeps only streets that start with a designator such as "rue".
			if (!prefix || !street) {
				skipped++

				continue
			}

			const carriesNumber = random() < hnProb
			const components: Record<string, string> = { street_prefix: prefix, street }
			let raw = `${prefix} ${street}`
			let klass = DATEISH.test(street) ? "date-name" : PARTICLE.test(street) ? "street-particle" : "bare-street"

			if (carriesNumber) {
				const number = sample(HOUSE_NUMBERS, random)
				const alnum = random() < ALNUM_HOUSE_NUMBER_SHARE
				const suffix = sample(ALNUM_SUFFIXES, random)

				const houseNumber = alnum
					? suffix === "bis" || suffix === "ter"
						? `${number} ${suffix}`
						: `${number}${suffix}`
					: String(number)

				components.house_number = houseNumber
				raw = `${houseNumber} ${prefix} ${street}`
				klass = alnum ? "alnum-housenumber" : "street-housenumber"
			}

			const sourceID = recipeSourceID(FR_FRAGMENT_SOURCE, { ...components, v: String(read) })

			if (
				alignAndWrite(
					write,
					{
						raw,
						components,
						country: "FR",
						locale: "fr-FR",
						source: FR_FRAGMENT_SOURCE,
						source_id: sourceID,
						corpus_version: "0.9.4",
						license: "Synthetic — fr-fragment; (street, commune) from BAN (Base Adresse Nationale, Licence Ouverte)",
					},
					`fr-fragment:${klass}`,
					FR_FRAGMENT_PROVENANCE
				)
			) {
				emitted++
			} else {
				skipped++
			}
		}

		// MARK: Bare-locality counterexamples

		// The count makes bare localities `bareLocalityProb` of all emitted rows.
		const pool = [...localities].toSorted()
		const wanted = Math.round((emitted / Math.max(1, 1 - bareLocalityProb)) * bareLocalityProb)

		for (let i = 0; i < wanted && pool.length; i++) {
			// The fragment evaluation board uses title-cased commune names.
			const name = titleCaseFR(sample(pool, random))
			const sourceID = recipeSourceID(FR_FRAGMENT_SOURCE, { locality: name, v: `neg-${i}` })

			if (
				alignAndWrite(
					write,
					{
						raw: name,
						components: { locality: name },
						country: "FR",
						locale: "fr-FR",
						source: FR_FRAGMENT_SOURCE,
						source_id: sourceID,
						corpus_version: "0.9.4",
						license: "Synthetic — fr-fragment counter-distribution; commune from BAN (Licence Ouverte)",
					},
					"fr-fragment:bare-locality",
					FR_FRAGMENT_PROVENANCE
				)
			) {
				emitted++
			} else {
				skipped++
			}
		}

		if (contaminated) {
			console.error(`fr-fragment: skipped ${contaminated} rows whose street surface is reserved by the fragment board`)
		}

		return { read, emitted, skipped }
	},
}
