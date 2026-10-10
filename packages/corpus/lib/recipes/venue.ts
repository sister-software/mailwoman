/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `venue` recipe. A real venue name written as the whole query, and the same name followed by a
 *   locality drawn from the country's admin tuples. The rows teach the model that
 *   `Manchester Art Gallery` is a venue rather than a locality and a region, which the venue-head
 *   prior in `@mailwoman/neural` also asserts, so the model and the prior agree.
 *
 *   Venue names come from the Overture place-names Parquet file the venue-head table is built
 *   from, which holds `name`, `category` and `country` for every place at confidence 0.85 or
 *   higher. The file has no locality column, so the locality row joins a name to a tuple of the
 *   same country and asserts no fact about where the venue stands, so its surface is
 *   `SurfaceOrigin.Composed`. The bare row is the publisher's own string, so its surface is
 *   `SurfaceOrigin.Attested`.
 *
 *   A bare row needs a name of two or more words. A one-word name such as `Blackwell` or `Roadside`
 *   is written as a bare query only beside a locality, because a lone unknown word is the shape of a
 *   bare locality and a row that labels it `venue` would teach against bare-locality recall.
 *
 *   A name that equals a locality of the country's tuples, or whose written row is an input on a
 *   gauntlet board, is refused.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import { venueHeadLexicon } from "@mailwoman/poi-taxonomy/venue-heads"
import type { PathBuilderLike } from "path-ts"

import { normalizeGauntletSurface, readGauntletInputs } from "#gauntlet-inputs"
import { type DisposableDuckDB, escapeSQLString, openDuckDB } from "#parquet/duckdb"
import {
	alignAndWrite,
	readTuples,
	recipeSourceID,
	type CorpusRecipe,
	type RecipeTuple,
	type WriteRecipeLine,
} from "#recipes/scaffold"
import { defaultRecipeSource } from "#recipes/sources"
import { SourceRegister } from "#registers"
import { countryToLocale } from "#synthesizers/utils"
import { SurfaceOrigin } from "#types"

/**
 * The Overture release the venue-head table is built from, so the two read one name population.
 */
export const DEFAULT_VENUE_NAMES: PathBuilderLike = dataRootPath(
	"overture",
	"2026-09-23.1",
	"place-names",
	"names.parquet"
)

/**
 * Venue names drawn per country when `--count` is absent.
 */
export const DEFAULT_NAMES_PER_COUNTRY = 20_000

/**
 * Share of locality rows that also carry the region when `--venue-region-fraction` is absent.
 */
export const DEFAULT_REGION_FRACTION = 0.5

/**
 * The two written shapes.
 */
export const VenueTemplate = {
	/**
	 * The venue name as the whole query.
	 */
	Bare: "venue-bare",
	/**
	 * The venue name, a comma, and a locality of the same country.
	 */
	Locality: "venue-locality",
} as const

/**
 * One of {@linkcode VenueTemplate}.
 */
export type VenueTemplate = (typeof VenueTemplate)[keyof typeof VenueTemplate]

const LICENSE =
	"CDLA-Permissive-2.0 — Overture Maps places names; the locality comes from CC-BY / public-domain admin tuples"

const BARE_PROVENANCE = {
	register: SourceRegister.Overture,
	surface: SurfaceOrigin.Attested,
	// The names file has no record id column.
	baseSourceID: null,
}

const LOCALITY_PROVENANCE = {
	register: SourceRegister.Overture,
	surface: SurfaceOrigin.Composed,
	baseSourceID: null,
}

/**
 * A head lookup for one country, the shape `venueHeadLexicon` returns.
 */
export interface VenueHeadSuffixLookup {
	suffix(word: string): number | null
}

const SPACELESS_SCRIPT_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]+$/u

/**
 * Characters a spaceless-script name needs before it is written as a bare query.
 *
 * A two-character name such as `東京` is the length of a city name, and the head the table recognizes is
 * the name's last character, so a name shorter than this is a head with one character of stem.
 */
export const MIN_SPACELESS_BARE_CHARACTERS = 3

/**
 * Whether a name may be written as the whole query.
 *
 * In a spaced script the name needs two or more words, and at least one word
 * with a letter, so `24 7` and `A1` stay out.
 * In a script written without spaces a name is one word, so it qualifies when it has three or more
 * characters and ends in a venue head the table holds for the country, as `国立西洋美術館` ends in `館`.
 *
 * A spaceless name the table does not recognize is written beside a locality only.
 */
export function isBareVenueName(name: string, heads?: VenueHeadSuffixLookup): boolean {
	const words = name.trim().split(/\s+/u)

	if (words.length >= 2) return words.some((word) => /\p{L}{2,}/u.test(word))

	const word = words[0]!

	return (
		Boolean(heads) &&
		[...word].length >= MIN_SPACELESS_BARE_CHARACTERS &&
		SPACELESS_SCRIPT_RE.test(word) &&
		heads!.suffix(word) !== null
	)
}

/**
 * The comparison key for a name against the country's localities.
 */
export function venueNameKey(name: string): string {
	return name.normalize("NFC").trim().toLowerCase().replaceAll(/\s+/gu, " ")
}

/**
 * Admin tuples grouped by country, with the locality set each country's names are checked against.
 */
export interface CountryTuples {
	tuples: RecipeTuple[]
	localities: Set<string>
}

/**
 * The ISO 3166-1 alpha-2 code of a tuple's country.
 *
 * `corpus tuples` writes the code under `cc` and the display name under `country`.
 * Older tuples files write the code under `country`.
 * A tuple with neither form returns `null`.
 */
export function tupleCountryCode(tuple: RecipeTuple): string | null {
	for (const value of [tuple.cc, tuple.country]) {
		if (typeof value === "string" && /^[A-Za-z]{2}$/u.test(value.trim())) return value.trim().toUpperCase()
	}

	return null
}

/**
 * Groups the admin tuples by country and keeps those with a locality.
 */
export async function groupTuplesByCountry(input: PathBuilderLike): Promise<Map<string, CountryTuples>> {
	const byCountry = new Map<string, CountryTuples>()

	for await (const tuple of readTuples(input)) {
		const country = tupleCountryCode(tuple)

		if (!country || !tuple.locality) continue
		let entry = byCountry.get(country)

		if (!entry) {
			entry = { tuples: [], localities: new Set() }
			byCountry.set(country, entry)
		}

		entry.tuples.push(tuple)
		entry.localities.add(venueNameKey(tuple.locality))
	}

	return byCountry
}

/**
 * Reads up to `limit` distinct names of one country from the Overture names file.
 *
 * The order is a hash of the name and the seed, so one seed draws one sample and a second seed another.
 */
export async function readVenueNames(
	db: DisposableDuckDB,
	venueNames: PathBuilderLike,
	country: string,
	limit: number,
	seed: number
): Promise<string[]> {
	const result = await db.runAndReadAll(
		`SELECT DISTINCT name FROM read_parquet('${escapeSQLString(String(venueNames))}')
		WHERE country = '${escapeSQLString(country)}' AND name IS NOT NULL AND length(trim(name)) >= 3
		ORDER BY hash(name, ${Math.floor(seed)}) LIMIT ${Math.floor(limit)}`
	)

	return result.getRows().map((row) => String(row[0]))
}

interface EmitContext {
	write: WriteRecipeLine
	source: { bare: string; locality: string }
	boardInputs: ReadonlySet<string>
	random: () => number
	stats: { emitted: number; skipped: number; contaminated: number }
}

function emit(
	context: EmitContext,
	raw: string,
	components: Record<string, string>,
	country: string,
	template: VenueTemplate,
	idParts: Record<string, string | undefined>
): void {
	if (context.boardInputs.has(normalizeGauntletSurface(raw))) {
		context.stats.contaminated++

		return
	}

	const source = template === VenueTemplate.Bare ? context.source.bare : context.source.locality

	const ok = alignAndWrite(
		context.write,
		{
			raw,
			components,
			country,
			locale: countryToLocale(country),
			source,
			source_id: recipeSourceID(source, { ...idParts, template }),
			corpus_version: "0.12.0",
			license: LICENSE,
		},
		template,
		template === VenueTemplate.Bare ? BARE_PROVENANCE : LOCALITY_PROVENANCE
	)

	if (ok) {
		context.stats.emitted++
	} else {
		context.stats.skipped++
	}
}

/**
 * Recipe registered with the corpus builder.
 *
 * `--input` supplies locality, region and country tuples, and every country
 * in it with venue names is covered.
 * `--count` caps the names drawn per country.
 * `--venue-names` points at the Overture names file.
 */
export const venueRecipe: CorpusRecipe = {
	name: "venue",
	description: "A real venue name as the whole query, and the name beside a locality of its country",
	mode: "tuples",
	options: [
		{ flag: "--venue-names <parquet>", description: `Overture place-names file (default ${DEFAULT_VENUE_NAMES})` },
		{ flag: "--count <n>", description: `venue names per country (default ${DEFAULT_NAMES_PER_COUNTRY})` },
		{
			flag: "--venue-region-fraction <share>",
			description: `locality rows that also carry the region (default ${DEFAULT_REGION_FRACTION})`,
		},
	],
	async run(opts, write) {
		if (!opts.input) throw new Error("venue recipe requires --input <tuples.jsonl>")
		const random = makeMulberry32(opts.seed)
		const venueNames = opts.venueNames ?? DEFAULT_VENUE_NAMES
		const perCountry = opts.count ?? DEFAULT_NAMES_PER_COUNTRY
		const regionFraction = opts.venueRegionFraction ?? DEFAULT_REGION_FRACTION
		const byCountry = await groupTuplesByCountry(opts.input)
		const boardInputs = await readGauntletInputs()

		const context: EmitContext = {
			write,
			source: {
				bare: opts.sourceName ? `${opts.sourceName}-bare` : defaultRecipeSource("synth-venue-bare"),
				locality: opts.sourceName ? `${opts.sourceName}-locality` : defaultRecipeSource("synth-venue-locality"),
			},
			boardInputs,
			random,
			stats: { emitted: 0, skipped: 0, contaminated: 0 },
		}

		let read = 0

		using db = await openDuckDB({ threads: 4 })

		for (const [country, { tuples, localities }] of byCountry) {
			const names = await readVenueNames(db, venueNames, country, perCountry, opts.seed)
			const heads = venueHeadLexicon(country)

			for (const name of names) {
				read++

				if (localities.has(venueNameKey(name))) {
					context.stats.skipped++

					continue
				}

				const tuple = tuples[Math.floor(random() * tuples.length)]!
				const locality = tuple.locality!
				const withRegion = Boolean(tuple.region) && random() < regionFraction
				const components: Record<string, string> = { venue: name, locality }
				let raw = `${name}, ${locality}`

				if (withRegion) {
					components.region = tuple.region!
					raw = `${raw}, ${tuple.region}`
				}

				emit(context, raw, components, country, VenueTemplate.Locality, {
					name,
					locality,
					region: withRegion ? tuple.region : undefined,
				})

				if (isBareVenueName(name, heads)) {
					emit(context, name, { venue: name }, country, VenueTemplate.Bare, { name })
				}
			}
		}

		return { read, ...context.stats }
	},
}
