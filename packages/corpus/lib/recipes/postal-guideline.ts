/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `postal-guideline` recipe: evaluation-only rows that write a post-office box or its national
 *   equivalent as the postal operator's published guideline states it. Each country's leg renders
 *   only forms its codex rule table cites, and no leg uses a training recipe's leader vocabulary.
 *
 *   Every row's locality and postcode come from a place that {@linkcode splitForRow} holds out, and
 *   the recipe keeps a row only when its split is `test`. A place the split holds out sends half its
 *   rows to `val` by a hash of `source_id`, so the recipe redraws the box number of a row that lands
 *   there. Before returning, it checks every row again and throws on any row outside `test`.
 *
 *   The holdouts are read when the recipe runs. A base rebuild that changes them changes which places
 *   qualify, so the rows are generated against the split of the corpus they are evaluated with.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { stringifyJSON } from "@mailwoman/core/json"
import { mulberry32, sample } from "@mailwoman/core/random"
import { TSVSpliterator } from "spliterator"

import { AU_DELIVERY_GUIDELINE_LEG } from "#au/recipes/delivery-guideline"
import { DE_POSTFACH_GUIDELINE_LEG } from "#de/recipes/postfach-guideline"
import { IT_CASELLA_POSTALE_GUIDELINE_LEG } from "#it/recipes/casella-postale-guideline"
import type { PostalGuidelineLeg, PostalGuidelinePlace } from "#recipes/postal-guideline/leg"
import { recipeSourceID, type CanonicalRecipeRow, type CorpusRecipe } from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { SurfaceOrigin, type LabeledRow } from "#types"
import { alignRow } from "#utils/align"
import { type CountryHoldout, defaultHoldouts, splitForRow } from "#utils/split"

/**
 * The legs the recipe runs, one per country.
 */
export const POSTAL_GUIDELINE_LEGS: readonly PostalGuidelineLeg[] = [
	DE_POSTFACH_GUIDELINE_LEG,
	IT_CASELLA_POSTALE_GUIDELINE_LEG,
	AU_DELIVERY_GUIDELINE_LEG,
]

/**
 * Rows written per leg when `--count` is not given.
 */
export const POSTAL_GUIDELINE_DEFAULT_COUNT = 2000

/**
 * Draws per requested row before a leg gives up.
 */
const ATTEMPTS_PER_ROW = 50

/**
 * One emitted row.
 */
export type PostalGuidelineRow = LabeledRow & {
	template: string
	base_source_id: null
	register: string
	surface: string
}

/**
 * Options for {@link generatePostalGuidelineRows}.
 */
export interface PostalGuidelineRowsOptions {
	/**
	 * Every renderable place of each leg's country, keyed by country code.
	 */
	places: ReadonlyMap<string, readonly PostalGuidelinePlace[]>
	/**
	 * Rows per leg.
	 */
	count: number
	seed: number
	source: string
	legs?: readonly PostalGuidelineLeg[]
	/**
	 * @defaultValue `defaultHoldouts()`
	 */
	holdouts?: Record<string, CountryHoldout>
}

/**
 * Whether the split holds out a place.
 * The answer is the same for every `source_id`.
 */
function isHeldOutPlace(
	country: string,
	components: Record<string, string>,
	holdouts: Record<string, CountryHoldout>
): boolean {
	return splitForRow({ source_id: "", country, components }, holdouts) !== "train"
}

/**
 * The held-out places of one leg, in input order and without repeats.
 */
export function heldOutPlaces(
	leg: PostalGuidelineLeg,
	places: readonly PostalGuidelinePlace[],
	holdouts: Record<string, CountryHoldout>
): PostalGuidelinePlace[] {
	const seen = new Set<string>()
	const kept: PostalGuidelinePlace[] = []

	for (const place of places) {
		const key = `${place.locality}|${place.postcode}|${place.region ?? ""}`.toLowerCase()

		if (seen.has(key)) continue

		seen.add(key)

		const components: Record<string, string> = { locality: place.locality, postcode: place.postcode }

		if (place.region) {
			components.region = place.region
		}

		if (isHeldOutPlace(leg.country, components, holdouts)) {
			kept.push(place)
		}
	}

	return kept
}

/**
 * Throws unless every row's split is `test`, naming the first row that is not.
 */
export function assertEveryRowInTest(
	rows: ReadonlyArray<Pick<LabeledRow, "source_id" | "country" | "components" | "raw">>,
	holdouts: Record<string, CountryHoldout> = defaultHoldouts()
): void {
	for (const row of rows) {
		const split = splitForRow(row, holdouts)

		if (split !== "test") {
			throw new Error(
				`postal-guideline: row ${row.source_id} (${stringifyJSON(row.raw)}) splits to ${split}, not test. ` +
					`The source is evaluation-only, so the recipe refuses to emit it.`
			)
		}
	}
}

/**
 * Renders, aligns and checks the rows of every leg.
 *
 * Throws when a leg has no held-out place or cannot reach `count` rows, rather than returning fewer.
 */
export function generatePostalGuidelineRows(opts: PostalGuidelineRowsOptions): PostalGuidelineRow[] {
	const holdouts = opts.holdouts ?? defaultHoldouts()
	const legs = opts.legs ?? POSTAL_GUIDELINE_LEGS
	const random = mulberry32(opts.seed)
	const rows: PostalGuidelineRow[] = []

	for (const leg of legs) {
		const pool = heldOutPlaces(leg, opts.places.get(leg.country) ?? [], holdouts)

		if (!pool.length) {
			throw new Error(`postal-guideline: no ${leg.country} place is held out by the split, so the leg has no skeleton.`)
		}

		const seen = new Set<string>()
		let emitted = 0

		for (let attempt = 0; emitted < opts.count && attempt < opts.count * ATTEMPTS_PER_ROW; attempt++) {
			const rendering = leg.render(random, sample(pool, random), pool)

			if (!Object.values(rendering.components).every((value) => rendering.raw.includes(value))) {
				throw new Error(`postal-guideline: ${leg.country} rendered a component its raw omits: ${rendering.raw}`)
			}

			const sourceID = recipeSourceID(opts.source, { ...rendering.components, country: leg.country })

			if (seen.has(sourceID)) continue

			const canonical: CanonicalRecipeRow = {
				raw: rendering.raw,
				components: rendering.components,
				country: leg.country,
				locale: leg.locale,
				source: opts.source,
				source_id: sourceID,
				license: `GeoNames postal export (CC-BY 4.0) places + ${leg.rules[0]!.citation.publisher} guideline forms (@mailwoman/codex)`,
			}

			if (splitForRow(canonical, holdouts) !== "test") continue

			const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

			if (aligned.kind !== "labeled") {
				throw new Error(`postal-guideline: ${leg.country} row does not align (${aligned.row.reason}): ${rendering.raw}`)
			}

			seen.add(sourceID)

			rows.push({
				...aligned.row,
				template: `${rendering.template}:${rendering.ruleID}`,
				base_source_id: null,
				register: SourceRegister.GeoNamesPostal,
				surface: SurfaceOrigin.Invented,
			})

			emitted++
		}

		if (emitted < opts.count) {
			throw new Error(
				`postal-guideline: ${leg.country} reached ${emitted} of ${opts.count} rows from ${pool.length} held-out places.`
			)
		}
	}

	assertEveryRowInTest(rows, holdouts)

	return rows
}

/**
 * Reads one country's GeoNames postal export, as `<CC>.txt` or `<CC>.zip` under the
 * data root's `geonames-postal` directory, through the leg's row reader.
 */
export async function readPostalGuidelinePlaces(leg: PostalGuidelineLeg): Promise<PostalGuidelinePlace[]> {
	const text = dataRootPath("geonames-postal", `${leg.country}.txt`)
	const zip = dataRootPath("geonames-postal", `${leg.country}.zip`)
	let rows: AsyncIterable<string[]>

	if (await pathExists(text)) {
		rows = readUnquotedTSV(text)
	} else if (await pathExists(zip)) {
		rows = TSVSpliterator.fromAsync(readZipEntry(zip, `${leg.country}.txt`), {
			header: false,
			enableQuoteHandling: false,
		}) as AsyncIterable<string[]>
	} else {
		throw new Error(
			`postal-guideline: neither ${text} nor ${zip} exists. Fetch it with \`mailwoman corpus fetch geonames-postal\`.`
		)
	}

	const places: PostalGuidelinePlace[] = []

	for await (const columns of rows) {
		const place = leg.placeFromColumns(columns)

		if (place) {
			places.push(place)
		}
	}

	return places
}

/**
 * The registered recipe.
 */
export const postalGuidelineRecipe: CorpusRecipe = {
	name: "postal-guideline",
	description:
		"Evaluation-only PO box rows (DE Postfach, IT casella postale, AU CARE PO/MS/RMS) from cited operator guidelines, " +
		"on held-out GeoNames places; every row splits to test",
	mode: "generate",
	options: [{ flag: "--count", description: "Rows per country leg (default 2000)" }],
	async run(opts, write) {
		const places = new Map<string, readonly PostalGuidelinePlace[]>()

		for (const leg of POSTAL_GUIDELINE_LEGS) {
			const read = await readPostalGuidelinePlaces(leg)

			console.error(`  ${leg.country}: ${read.length} GeoNames postal places`)

			places.set(leg.country, read)
		}

		const rows = generatePostalGuidelineRows({
			places,
			count: opts.count ?? POSTAL_GUIDELINE_DEFAULT_COUNT,
			seed: opts.seed,
			source: opts.sourceName ?? defaultRecipeSource("synth-postal-guideline"),
		})

		for (const row of rows) {
			write(stringifyJSON(row))
		}

		return { emitted: rows.length, skipped: 0 }
	},
}
