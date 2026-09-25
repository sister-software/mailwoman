/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders four hand-reviewed Venezuelan postcode facts in the `locality postcode, region` order.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { stripCombiningMarks } from "@mailwoman/normalize/fold"
import type { PathBuilderLike } from "path-ts"

import { alignAndWrite, type CorpusRecipe, recipeSourceID } from "#recipes/scaffold"
import { SourceRegister } from "#registers"
import { SurfaceOrigin } from "#types"

/**
 * The source label for these rows.
 *
 * The rows get their own sampler bucket so an eval can measure them apart from other postcode placements.
 */
export const REVIEWED_POSTCODE_TAIL_SOURCE = "synth-reviewed-postcode-tail"

const REVIEWED_TUPLE_COUNT = 4

interface ReviewedTupleProvenance {
	publisher: string
	url: string
	retrievedAt: string
	reviewStatus: "reviewed"
	sourceLicenseNote: string
}

/**
 * One reviewed postcode fact and the source it was read from.
 */
export interface ReviewedPostcodeTuple {
	id: string
	locality: string
	postcode: string
	region: string
	country: "Venezuela"
	cc: "VE"
	locale: "es-VE"
	postcodePlacement: "after_locality"
	provenance: ReviewedTupleProvenance
}

interface ReviewedPostcodeTupleFile {
	version: string
	reviewedAt: string
	tuples: ReviewedPostcodeTuple[]
}

type VariantID =
	| "canonical-country"
	| "canonical-no-country"
	| "comma-free"
	| "uppercase"
	| "left-context"
	| "accent-folded"

interface Variant {
	id: VariantID
	raw: string
	components: Record<string, string>
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Returns the path of the committed reviewed-tuple data file.
 */
export function defaultReviewedPostcodeTuplePath(): string {
	return resolveModulePath("@mailwoman/corpus/data/reviewed-ve-postcode-tuples.json")
}

/**
 * Reads and validates the reviewed tuples.
 *
 * @throws When the file does not hold exactly four complete, unique, reviewed tuples.
 */
export async function readReviewedPostcodeTuples(
	path: PathBuilderLike = defaultReviewedPostcodeTuplePath()
): Promise<ReviewedPostcodeTuple[]> {
	const document = await readLocalJSONFile<ReviewedPostcodeTupleFile>(path)

	if (!document.version || !ISO_DATE.test(document.reviewedAt) || document.tuples.length !== REVIEWED_TUPLE_COUNT) {
		throw new Error("reviewed postcode tuple file must declare a version, review date, and exactly four tuples")
	}

	const ids = new Set<string>()
	const facts = new Set<string>()

	for (const tuple of document.tuples) {
		const provenance = tuple.provenance
		const fact = `${tuple.locality}\u0000${tuple.postcode}\u0000${tuple.region}`

		if (
			!tuple.id ||
			!tuple.locality ||
			!tuple.postcode ||
			!tuple.region ||
			tuple.country !== "Venezuela" ||
			tuple.cc !== "VE" ||
			tuple.locale !== "es-VE" ||
			tuple.postcodePlacement !== "after_locality" ||
			!provenance?.publisher ||
			!URL.canParse(provenance.url) ||
			!ISO_DATE.test(provenance.retrievedAt) ||
			provenance.reviewStatus !== "reviewed" ||
			!provenance.sourceLicenseNote
		) {
			throw new Error(`invalid reviewed postcode tuple: ${tuple.id || "<missing id>"}`)
		}

		if (ids.has(tuple.id) || facts.has(fact)) throw new Error(`duplicate reviewed postcode tuple: ${tuple.id}`)
		ids.add(tuple.id)
		facts.add(fact)
	}

	return document.tuples
}

const foldAccents = (value: string): string => stripCombiningMarks(value).normalize("NFC")

/**
 * Returns the surface variants of one tuple.
 *
 * Every variant reuses the tuple's own locality, postcode and region, so no variant
 * pairs a postcode with a place the review did not cover.
 */
export function reviewedPostcodeTailVariants(tuple: ReviewedPostcodeTuple): Variant[] {
	const tail = `${tuple.locality} ${tuple.postcode}, ${tuple.region}`
	const withCountry = `${tail}, ${tuple.country}`
	const base = { locality: tuple.locality, postcode: tuple.postcode, region: tuple.region, country: tuple.country }
	const upper = Object.fromEntries(Object.entries(base).map(([key, value]) => [key, value.toUpperCase()]))

	const variants: Variant[] = [
		{ id: "canonical-country", raw: withCountry, components: base },
		{
			id: "canonical-no-country",
			raw: tail,
			components: { locality: tuple.locality, postcode: tuple.postcode, region: tuple.region },
		},
		{ id: "comma-free", raw: `${tuple.locality} ${tuple.postcode} ${tuple.region} ${tuple.country}`, components: base },
		{ id: "uppercase", raw: withCountry.toUpperCase(), components: upper },
		{
			id: "left-context",
			raw: `Comercio Ejemplo, Calle Principal, ${withCountry}`,
			components: { venue: "Comercio Ejemplo", street: "Calle Principal", ...base },
		},
	]

	const foldedLocality = foldAccents(tuple.locality)
	const foldedRegion = foldAccents(tuple.region)

	if (foldedLocality !== tuple.locality || foldedRegion !== tuple.region) {
		variants.push({
			id: "accent-folded",
			raw: `${foldedLocality} ${tuple.postcode}, ${foldedRegion}, ${tuple.country}`,
			components: { locality: foldedLocality, postcode: tuple.postcode, region: foldedRegion, country: tuple.country },
		})
	}

	return variants
}

/**
 * The corpus recipe that emits every variant of every reviewed tuple.
 */
export const reviewedPostcodeTailRecipe: CorpusRecipe = {
	name: "reviewed-postcode-tail",
	description: "Reviewed Venezuela locality-postcode-region tails with bounded surface variants",
	mode: "generate",
	async run(opts, write) {
		const tuples = await readReviewedPostcodeTuples(opts.input)
		let emitted = 0
		let skipped = 0

		for (const tuple of tuples) {
			for (const variant of reviewedPostcodeTailVariants(tuple)) {
				const sourceID = recipeSourceID(REVIEWED_POSTCODE_TAIL_SOURCE, { tuple: tuple.id, variant: variant.id })

				const canonical = {
					raw: variant.raw,
					components: variant.components,
					country: tuple.cc,
					locale: tuple.locale,
					source: REVIEWED_POSTCODE_TAIL_SOURCE,
					source_id: sourceID,
					corpus_version: "0.11.0",
					license: `Synthetic rendering of reviewed postal facts — ${tuple.provenance.publisher}; source terms recorded in reviewed-ve-postcode-tuples.json`,
				}

				if (
					alignAndWrite(write, canonical, "reviewed-postcode-tail", {
						// A person read these facts from their publishers, and the data file
						// records the publisher of each tuple.
						// No upstream bulk file exists.
						register: SourceRegister.ReviewedByHand,
						surface: SurfaceOrigin.Composed,
						baseSourceID: tuple.id,
					})
				) {
					emitted++
				} else {
					skipped++
				}
			}
		}

		return { read: tuples.length, emitted, skipped }
	},
}
