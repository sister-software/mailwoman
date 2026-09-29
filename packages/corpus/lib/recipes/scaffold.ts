/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared scaffolding for corpus recipes: the seeded LCG PRNG, the tuple reader and
 *   the canonical → `alignRow` → `LabeledRow` jsonl emit step. A recipe ({@link CorpusRecipe})
 *   supplies only its row construction and filter. The `mailwoman corpus slice <recipe>` command
 *   supplies the I/O.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import type { AsyncChunkIterator, AsyncDataResource } from "spliterator"
import { AsyncSequence, CSVSpliterator, TextSpliterator } from "spliterator"

import { stableSourceIDFromParts } from "#adapters/utils"
import type { SurfaceOrigin } from "#types"
import { alignRow } from "#utils"

/**
 * {@link stableSourceIDFromParts} under the name the recipes use, for arbitrary
 * disambiguator keys (e.g. a variant index `v`) that are not `ComponentTag`s.
 */
export function recipeSourceID(adapterID: string, parts: Record<string, string | undefined>): string {
	return stableSourceIDFromParts(adapterID, parts)
}

/**
 * Where a country's convention writes the postcode inside the `«locality», «region»[, «country»]` admin tail.
 *
 * The position changes which tag the same digits receive, so a recipe emitting
 * one placement teaches one family of countries.
 * Each value is attested by a gauntlet board row:
 *
 * - `leading` — `«postcode» «locality», «region»`.
 *   This is the default placement.
 *   It also describes every tuple written before this field existed.
 * - `after_locality` — `«locality» «postcode», «region»`.
 * - `after_region` — `«locality», «region» «postcode»`.
 */
export type PostcodePlacement = "leading" | "after_locality" | "after_region"

/**
 * A (locality, region, postcode, country) source tuple — the input to tuples-mode recipes.
 */
export interface RecipeTuple {
	locality?: string
	/**
	 * The source's segment before the locality.
	 *
	 * Its inclusion prevents every recipe row from beginning with the locality
	 * and teaching that the first segment is the locality.
	 */
	dependentLocality?: string
	region?: string
	postcode?: string
	country?: string
	/**
	 * Defaults to `leading` when absent.
	 *
	 * That matches every tuples file written before this field existed.
	 */
	postcodePlacement?: PostcodePlacement
	/**
	 * `source_id` of the record this tuple was extracted from, when the extraction included it.
	 *
	 * A recipe forwards it as `baseSourceID`, which is the only way a `composed`
	 * row can name the record behind it.
	 * Every tuples file written before this field existed omits it, so a recipe reading one passes `null`
	 * and its rows are unlinkable to their source records by anything but the `raw` string (#2359).
	 */
	sourceID?: string
	[k: string]: unknown
}

/**
 * One CSV record, keyed by its lower-cased header name, every value trimmed.
 *
 * An undeclared column reads as `undefined`, a declared but unreached column as `""`.
 */
export type CSVRecord = Record<string, string | undefined>

/**
 * Line breaks inside a value become single spaces.
 * The function trims every value.
 *
 * The pattern matches exactly `\r` and `\n`: widening to `\s+` would silently rewrite values on
 * rows with no line break at all (OA's IA extract writes `north`, three spaces, `main street`),
 * and `scaffold.test.ts` pins both directions.
 */
export function withoutLineBreaks(record: CSVRecord): CSVRecord {
	const out: CSVRecord = {}

	for (const [key, value] of Object.entries(record)) {
		out[key] = (value ?? "").replaceAll(/[\r\n]+/g, " ").trim()
	}

	return out
}

/**
 * Read a CSV as header-keyed records.
 *
 * Returns the spliterator's own {@linkcode AsyncSequence} so a caller composes
 * `take`/`drop`/`filter` onto it.
 * An `async function*` wrapper would cost an async frame per row and remove those ops.
 */
export function readCSVRecords(source: AsyncDataResource | AsyncChunkIterator): AsyncSequence<CSVRecord> {
	return CSVSpliterator.fromAsync<CSVRecord>(source).map(withoutLineBreaks)
}

/**
 * {@link readCSVRecords} over one member of a zip archive.
 *
 * A source a checkout has not cached yields no rows after warning, while a recipe
 * that ends up with no tuples at all still throws.
 */
export function readZippedCSVRecords(archivePath: PathBuilderLike, entryName: string): AsyncSequence<CSVRecord> {
	return AsyncSequence.from<CSVRecord>(async () => {
		if (!(await pathExists(archivePath))) {
			console.error(`  WARN: ${archivePath} is not cached — skipping ${entryName}`)

			return []
		}

		return readCSVRecords(readZipEntry(archivePath, entryName))
	})
}

/**
 * License stamped on the synthetic tuple-derived recipe outputs.
 *
 * The output is generated but inherits the terms of the real tuples it derives from,
 * so the attribution travels with it.
 */
export const SYNTHETIC_TUPLE_LICENSE = "Synthetic — derived from CC-BY / public-domain input tuples"

/**
 * The surface key shared by the Norwegian recipes (`no-fragment`, `no-street-led`).
 *
 * Must match the Norwegian digit board's `norm_surface` (NFC, lowercase, collapse whitespace,
 * keep diacritics); folding them away would collapse `Tømmerlien` to `tommerlien`,
 * never match the board's reserved `tømmerlien`, and leak the train/eval split silently.
 */
export const foldNOSurface = (value: string): string =>
	value.normalize("NFC").toLowerCase().replaceAll(/\s+/g, " ").trim()

/**
 * A cached OpenAddresses extract: the zip and the CSV member.
 */
export interface OATupleSource {
	zip: PathBuilderLike
	csv: string
}

/**
 * The four base fields every OA tuple reader extracts; `postcode` is `""` when the row
 * contains no postcode and {@link ReadOATuplesOptions.requirePostcode} is unset.
 */
export interface OATupleFields {
	house_number: string
	street: string
	locality: string
	postcode: string
}

export interface ReadOATuplesOptions<T> {
	/**
	 * Stop after this many distinct tuples.
	 *
	 * The `break` closes the reader and releases the archive.
	 * GB-scale countrywide extracts need this behavior.
	 */
	limit?: number
	/**
	 * Drop rows without a postcode, for the reversed-order and balance readers
	 * where the postcode drives the rendering.
	 */
	requirePostcode?: boolean
	/**
	 * Fold the postcode into the dedup key.
	 *
	 * The default key is `${house_number}|${street}|${locality}`, lower-cased.
	 */
	dedupIncludesPostcode?: boolean
	/**
	 * Shape the recipe's tuple from the base fields, raw record and lower-cased dedup key.
	 */
	extra: (fields: OATupleFields, row: CSVRecord, key: string) => T
}

/**
 * Stream distinct tuples out of a cached OA zip, the reader the OA-skeleton recipes
 * (`street-affix`, `unit`, `country-balanced`, `fr-order`) share.
 *
 * Field reads, filters, dedup keys and row order keep each recipe's output byte-identical.
 */
export async function readOATuples<T>(source: OATupleSource, options: ReadOATuplesOptions<T>): Promise<T[]> {
	const tuples: T[] = []
	const seen = new Set<string>()

	for await (const row of readZippedCSVRecords(source.zip, source.csv)) {
		if (options.limit !== undefined && tuples.length >= options.limit) break

		const street = row.street ?? ""
		const locality = row.city ?? ""
		const house_number = row.number ?? ""
		const postcode = row.postcode ?? ""

		if (!street || !locality || !house_number) continue

		if (options.requirePostcode && !postcode) continue

		const key = (
			options.dedupIncludesPostcode
				? `${house_number}|${street}|${locality}|${postcode}`
				: `${house_number}|${street}|${locality}`
		).toLowerCase()

		if (seen.has(key)) continue
		seen.add(key)

		tuples.push(options.extra({ house_number, street, locality, postcode }, row, key))
	}

	return tuples
}

/**
 * Stream-parse a tuples jsonl file, yielding each parsed object (blank/invalid lines skipped).
 */
export function readTuples(input: PathBuilderLike): AsyncSequence<RecipeTuple> {
	// TextSpliterator keeps the reader tolerant of malformed lines.
	// JSONSpliterator would throw.
	// These operators fuse into the source's pull loop.
	return TextSpliterator.fromAsync(input)
		.map((line) => tryParsingJSON<RecipeTuple>(line))
		.filter((tuple) => tuple !== null)
		.map((tuple) => tuple!)
}

/**
 * A canonical row as the recipes assemble it, before `alignRow` turns it into a `LabeledRow`.
 */
export interface CanonicalRecipeRow {
	raw: string
	components: Record<string, string>
	country: string
	locale?: string
	source: string
	source_id: string
	corpus_version?: string
	license?: string
}

/**
 * Emit one line of a recipe's output.
 *
 * The delimiter is supplied separately, so pass only the content, without appending `"\n"`.
 */
export type WriteRecipeLine = (line: string) => void

/**
 * A sink the recipe writer sends each output line to.
 * A `WriteStream` or a test's array push can satisfy it.
 */
export interface RecipeLineSink {
	write(chunk: string): unknown
}

/**
 * Bind {@linkcode WriteRecipeLine} to a sink, supplying the delimiter.
 *
 * A concatenation would stringify a non-string chunk through `toString()` and corrupt its bytes.
 */
export function createRecipeLineWriter(sink: RecipeLineSink): WriteRecipeLine {
	return (line) => {
		sink.write(line)
		sink.write("\n")
	}
}

/**
 * What a recipe records about the rows it writes.
 *
 * `register` and `surface` answer separate questions.
 * A collapsed result would report a real record as fabricated.
 */
export interface RecipeProvenance {
	/**
	 * The published register the underlying record came from, or `null` when the row names none.
	 */
	register: string | null

	/**
	 * How the written `raw` string was produced.
	 */
	surface: SurfaceOrigin

	/**
	 * `source_id` of the row this was derived from.
	 *
	 * This field is required.
	 * `null` is a statement rather than an omission.
	 *
	 * A `composed` row reorders fields from a real record, so it has an underlying record by definition.
	 * `null` means the recipe did not preserve that record's id.
	 *
	 * The cost of `null` is measurable.
	 * Over `v0.6.0-register-surface` it is `null` for 4,176,539 of the 4,206,561 `composed` rows,
	 * 99.3%, and every leak measurement over a composed source is therefore a lower bound: two rows
	 * composed from one underlying address under different `source_id`s look like unrelated rows.
	 *
	 * `holdout-overlap.run.ts` then compares their `raw` strings.
	 * That misses any pair the recipe rendered differently (#2359).
	 */
	baseSourceID: string | null
}

/**
 * The register a tuple-reading recipe was invoked with.
 *
 * It throws when the flag is absent, naming the recipe, because a default would
 * stamp one register's id on another register's records.
 */
export function requireRegister(opts: RecipeOptions, recipe: string): string {
	if (!opts.register) {
		throw new Error(
			`${recipe} requires --register <id>: the register the --input tuples were extracted from, ` +
				`e.g. whos-on-first, openstreetmap, fr-ban. It is written onto every row this recipe emits.`
		)
	}

	return opts.register
}

/**
 * Run a canonical row through `alignRow` and, on success, write the `LabeledRow`
 * with its recipe id and provenance as one jsonl line.
 *
 * The provenance columns are flat because the parquet schema is flat.
 */
export function alignAndWrite(
	write: WriteRecipeLine,
	canonical: CanonicalRecipeRow,
	recipe: string,
	provenance: RecipeProvenance
): boolean {
	const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

	if (!aligned.row) return false

	write(
		stringifyJSON({
			...aligned.row,
			recipe,
			register: provenance.register,
			surface: provenance.surface,
			base_source_id: provenance.baseSourceID ?? null,
		})
	)

	return true
}

/**
 * Parsed options a recipe's `run` receives.
 *
 * Common fields + the union of recipe-specific flags.
 */
export interface RecipeOptions {
	output: string
	seed: number
	variants: number
	input?: PathBuilderLike
	count?: number
	golden?: boolean
	sourceName?: string
	/**
	 * The published register the `--input` tuples were extracted from.
	 *
	 * {@link requireRegister} refuses a run that omits it rather than recording a guess.
	 * A recipe that generates its rows from this repository's own tables declares its register in code.
	 */
	register?: string
	houseNumberProb?: number
	pmbRatio?: number
	militaryRatio?: number
	reversedFraction?: number
	edgesDir?: string
	country?: string
	intlFraction?: number
	/**
	 * `german`: fraction of native-order rows rendered with no commas at all.
	 * The default is 0.3.
	 */
	commaFreeFraction?: number
	/**
	 * `german`: fraction of rows whose `dependent_locality` is a WOF Ortsteil of the tuple's locality.
	 *
	 * The default is 0.3.
	 * It is 0 when no admin database is readable.
	 */
	ortsteilFraction?: number
	/**
	 * `german`: the WOF admin database the Ortsteil pool is read from.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority-importance.db`.
	 */
	adminDB?: string
	/**
	 * `locale`: fraction of rows that append an explicit country surface form + a `country` component.
	 *
	 * Default 0.
	 */
	countryFraction?: number
	/**
	 * `locale`: tri-state override of the per-part `districtAsLocality` mapping.
	 *
	 * `undefined` leaves each `COUNTRY_SOURCES` part's own value untouched.
	 * `true` or `false` forces that value on every part read this run.
	 */
	districtAsLocality?: boolean
	bareProb?: number
	hnProb?: number
	communes?: string
	/**
	 * `fr-lieudit`: BAN `adresses-<dept>.csv` directory.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/corpus/sources/ban`.
	 */
	banDir?: PathBuilderLike
	multilocaleCount?: number
	/**
	 * `fr-fragment` / `no-fragment` / `no-street-led`: the eval board's reserved street-surface list.
	 *
	 * It is required for those recipes, because a recipe output that trains on
	 * its own eval set measures memorization.
	 */
	excludeSurfaces?: PathBuilderLike
	/**
	 * `no-fragment`: share of rows that are counter-distribution (bare locality or bare postcode).
	 */
	counterProb?: number
	/**
	 * `no-fragment` knob 3: emit N copies of each street+number row whose number has >=
	 * longNumberMinDigits digits (oversample the failing long-number class).
	 *
	 * Default 1 = no boost.
	 */
	longNumberBoost?: number
	/**
	 * `no-fragment` knob 3: minimum digit count for a number to count as "long" and be boosted.
	 *
	 * Default 3.
	 */
	longNumberMinDigits?: number
	/**
	 * `sub-venue`: the sub-venue lexicon JSON.
	 *
	 * Default = the committed `corpus/data/sub-venue-lexicon.json`, resolved through the package manifest so it works
	 * from the source tree and from `out/`.
	 */
	lexicon?: string
	/**
	 * `sub-venue`: directory of `sub-venue-extract` JSONLs, one per region.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/sub-venue/extracts`.
	 */
	extractsDir?: string
	/**
	 * `sub-venue`: the `poi.db` spatial layer, read for the en-US and fr-FR venue + confound
	 * pools (the two of poi.db's four countries this recipe has legs for).
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/db/poi/poi.db`.
	 */
	poiDB?: string
	/**
	 * `sub-venue`: GB/US/FR address-context tuples jsonl.
	 *
	 * Default the house-venue v3 tuples (`$MAILWOMAN_DATA_ROOT/corpus/intermediate/house-venue-tuples-v3.jsonl`);
	 * DE and ES read OpenAddresses directly.
	 */
	subVenueTuples?: string
	/**
	 * `sub-venue`: share of emitted rows that are confound negatives.
	 *
	 * Default 0.3.
	 */
	negativeFraction?: number
}

/**
 * Tally a recipe returns.
 */
export interface RecipeStats {
	read?: number
	emitted: number
	skipped: number
	/**
	 * Rows dropped because their street surface is reserved by an eval board.
	 *
	 * It is separate from `skipped` so a nonzero value is the audit trail that the train/eval split fired.
	 */
	contaminated?: number
}

/**
 * A single declared recipe-specific option flag (for the command's --help).
 */
export interface RecipeOption {
	flag: string
	description: string
}

/**
 * A corpus recipe: its identity, input mode and synthesis `run`.
 */
export interface CorpusRecipe {
	/**
	 * Recipe id, e.g. "street", "po-box" — the `<recipe>` positional.
	 */
	name: string
	/**
	 * One-line description for `--list` / help.
	 */
	description: string
	/**
	 * `tuples` reads `--input` jsonl; `generate` self-generates `--count` rows.
	 */
	mode: "tuples" | "generate"
	/**
	 * Recipe-specific flags this recipe honors (documentation only).
	 */
	options?: RecipeOption[]
	/**
	 * Build by creating the recipe's PRNG from `opts.seed`.
	 * Synthesize rows and emit each one through `write`.
	 */
	run(opts: RecipeOptions, write: WriteRecipeLine): Promise<RecipeStats>
}
