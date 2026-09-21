/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared scaffolding for the synthetic-corpus recipes — the common bits the 16 root-level build
 *   scripts each re-implemented: the seeded LCG prng, the tuple reader, and the
 *   canonical → `alignRow` → `LabeledRow` jsonl emit step. A recipe ({@link CorpusRecipe}) supplies
 *   only its synthesis + filter. the `mailwoman corpus slice <recipe>` command supplies the I/O.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { readZipEntry } from "@mailwoman/core/fs/zip"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import type { PathBuilderLike } from "path-ts"
import type { AsyncChunkIterator, AsyncDataResource } from "spliterator"
import { AsyncSequence, CSVSpliterator, TextSpliterator } from "spliterator"

import { stableSourceIDFromParts } from "#adapters/utils"
import { alignRow } from "#utils"

/**
 * {@link stableSourceIDFromParts} under the name the recipes use: arbitrary disambiguator keys (e.g. A variant index `v`) that aren't `ComponentTag`s, which is how the legacy builders kept per-variant ids unique.
 */
export function recipeSourceID(adapterID: string, parts: Record<string, string | undefined>): string {
	return stableSourceIDFromParts(adapterID, parts)
}

/**
 * Where a country's convention writes the postcode inside the `«locality», «region»[, «country»]` admin tail.
 *
 * Position changes the tag assigned to the same digits.
 * On the shipped model, `Heladería Frappé Manía, Avenida Country Club, Barcelona 6001, Anzoátegui, Venezuela`
 * tags `6001` as `house_number` and loses the locality into the street, while the identical row written
 * `… 6001 Barcelona, Anzoátegui, Venezuela` tags it `postcode` and recovers `locality: Barcelona`.
 *
 * So a recipe emitting one placement teaches one family of countries.
 *
 * Each is attested by a gauntlet board row, which is the bar for adding another:
 *
 * - `leading` — `«postcode» «locality», «region»`.
 *   `Rua da Praia, 15, 8600-315 Lagos, Algarve, Portugal` (`pt_structured`).
 *   The default, and what every tuple written before this field existed means.
 * - `after_locality` — `«locality» «postcode», «region»`.
 *   `…, Barcelona 6001, Anzoátegui, Venezuela` (`ve_city_postcode_trailing_state`).
 * - `after_region` — `«locality», «region» «postcode»`.
 *   `12 MG Road, Indiranagar, Bengaluru, Karnataka 560038, India` (`in_structured`).
 */
export type PostcodePlacement = "leading" | "after_locality" | "after_region"

/**
 * A (locality, region, postcode, country) source tuple — the input to tuples-mode recipes.
 */
export interface RecipeTuple {
	locality?: string
	/**
	 * The segment before the locality, when the source has one.
	 *
	 * A recipe output whose every row begins with the locality teaches that the first named
	 * segment is the locality, which flips the model's default — measured on the v4.8.0 candidate,
	 * where `Ye Three Lords, 27 Minories, London EC3N 1DE` came back `locality: "Ye Three Lords"`.
	 */
	dependentLocality?: string
	region?: string
	postcode?: string
	country?: string
	/**
	 * Defaults to `leading` when absent.
	 *
	 * It is what every tuple file written before this field existed means.
	 * Therefore, an old tuples file produces byte-identical rows.
	 */
	postcodePlacement?: PostcodePlacement
	[k: string]: unknown
}

/**
 * The two seeded generators the legacy build scripts used, re-exported from their home in
 * `@mailwoman/core/utils` so a recipe keeps importing everything it needs from this one scaffold module.
 *
 * - `makeLcg` (`s = s*1664525 + 1013904223 mod 2^32`) — what the street/po-box/anchor builders seeded.
 * - `makeMulberry32` — what the majority of them used (german, locale, boundary-stress, unit, fr-order,
 *   country-balanced, intersection, fr-admin-split, street-affix, street-bare, po-box-cedex).
 *
 * A recipe must seed the same one its `.mjs` did, the same way it did
 * (usually `seed`, but some derive a per-stream seed), or `--seed N` stops being byte-reproducible.
 */

/**
 * One CSV record, keyed by its lower-cased header name, every value trimmed.
 *
 * A column the header does not declare reads as `undefined`; a column the header declares
 * but this record does not reach reads as `""`.
 */
export type CSVRecord = Record<string, string | undefined>

/**
 * Line breaks inside a value become single spaces, and every value is trimmed.
 *
 * A quote-aware parse is the first thing able to return a value containing a line
 * break — `us/ia/statewide.csv` has 12, all unit designators like `"#2\n#2"` —
 * and every consumer synthesizes one-line address text from these cells with no guard,
 * because until that parse landed no value could carry one.
 * Collapsing keeps the record (the address is fine. The source's line break is not part of it)
 * without emitting a training row with a newline inside it.
 *
 * Only `\r` and `\n`, deliberately — not `\s`.
 * Runs of spaces and tabs pass through exactly as the source wrote them
 * (OA's IA extract writes `north`, three spaces, `main street`), because those could
 * always appear and every recipe output built to date contains them.
 *
 * Widening this to `\s+` silently rewrites values on rows with no line break at all.
 * `scaffold.test.ts` pins both halves.
 *
 * This is what a CSV reader here still owns.
 * Quote handling, object rows, and lower-case keys are `CSVSpliterator`'s defaults, so a recipe reads
 * a source with `CSVSpliterator.fromAsync(source).map(withoutLineBreaks)` and needs nothing else.
 *
 * @category CSV
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
 * Returns the spliterator's own {@linkcode AsyncSequence}, so a caller composes
 * `take`/`drop`/`filter` onto it.
 * Those ops fuse into one pull loop, and a `take` that is satisfied closes the
 * source's file handle on the way out.
 *
 * Wrapping this in an `async function*` costs an async frame per row and takes those ops away.
 * Don't.
 *
 * A source at or below the spliterator's 128 KiB bulk threshold is read whole and parsed
 * by the synchronous engine, so this is also the right reader for small sources.
 * There is no buffered variant to reach for.
 *
 * @category CSV
 */
export function readCSVRecords(source: AsyncDataResource | AsyncChunkIterator): AsyncSequence<CSVRecord> {
	return CSVSpliterator.fromAsync<CSVRecord>(source).map(withoutLineBreaks)
}

/**
 * {@link readCSVRecords} over one member of a zip archive — what every recipe reading a cached OA source wants.
 *
 * A source a checkout has not cached yields nothing, after saying so.
 *
 * A lab holds the archives for the countries it has built, so a recipe naming ten
 * sources routinely finds three, and the `unzip -p` subprocesses these replaced behaved
 * the same way by accident — a non-zero exit warned and returned no rows.
 * A recipe that ends up with no tuples at all still throws.
 *
 * That is the case where the cache rather than the recipe, is the problem.
 *
 * @category CSV
 */
export function readZippedCSVRecords(archivePath: PathBuilderLike, entryName: string): AsyncSequence<CSVRecord> {
	return AsyncSequence.from<CSVRecord>(async () => {
		if (!(await pathExists(String(archivePath)))) {
			console.error(`  WARN: ${archivePath} is not cached — skipping ${entryName}`)

			return []
		}

		return readCSVRecords(readZipEntry(archivePath, entryName))
	})
}

/**
 * License stamped on the synthetic tuple-derived recipe outputs
 * (`po-box`, `no-street`, `house-venue`): the output is generated, but it inherits the
 * terms of the real tuples it is derived from, so the attribution travels with it.
 */
export const SYNTHETIC_TUPLE_LICENSE = "Synthetic — derived from CC-BY / public-domain input tuples"

/**
 * The surface key shared by the Norwegian recipes (`no-fragment`, `no-street-led`).
 *
 * Must match the Norwegian digit board's `norm_surface`: NFC, lowercase,
 * collapse whitespace — and keep diacritics.
 * Fr-fragment's norm strips them (NFD + combining-mark removal), which is right for French
 * but would collapse `Tømmerlien` → `tommerlien` here.
 *
 * Therefore, a recipe's exclusion check would never match the board's reserved `tømmerlien`
 * and the train/eval split would leak silently.
 *
 * Diacritic street heads (…vegen/…veien with ø/å/æ) are the whole point of those recipes' boundary.
 * Folding them away is not an option.
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
 * The four base fields every OA tuple reader extracts.
 *
 * `postcode` is `""` when the row carries none and {@link ReadOATuplesOptions.requirePostcode} is unset.
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
	 * The `break` closes the reader and releases the archive, which is what the
	 * GB-scale countrywide extracts need.
	 */
	limit?: number
	/**
	 * Drop rows without a postcode (reversed-order and balance readers, where the postcode drives the rendering).
	 */
	requirePostcode?: boolean
	/**
	 * Fold the postcode into the dedup key (`fr-order`'s key).
	 *
	 * The default key is `${house_number}|${street}|${locality}`, lower-cased.
	 */
	dedupIncludesPostcode?: boolean
	/**
	 * Shape the recipe's tuple from the base fields, the raw record, and the (lower-cased) dedup key.
	 */
	extra: (fields: OATupleFields, row: CSVRecord, key: string) => T
}

/**
 * Stream distinct tuples out of a cached OA zip — the reader the OA-skeleton recipes
 * (`street-affix`, `unit`, `country-balanced`, `fr-order`) share.
 *
 * Field reads, filters, dedup keys and row order are exactly what each recipe's
 * local copy did, so a recipe's output stays byte-identical.
 *
 * @category CSV
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
	// TextSpliterator (not JSONSpliterator) keeps the reader's established tolerance:
	// malformed lines are skipped rather than rejecting the sequence.
	// These operators fuse into the source's pull loop instead of adding an async-generator frame per tuple.
	return TextSpliterator.fromAsync(input)
		.map((line) => line.trim())
		.filter((line) => Boolean(line))
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
 * The delimiter is supplied by the caller of `run` — pass the content alone, never `content + "\n"`.
 */
export type WriteRecipeLine = (line: string) => void

/**
 * A sink the recipe writer emits into.
 *
 * `WriteStream` satisfies it, and so does a test's array push.
 */
export interface RecipeLineSink {
	write(chunk: string): unknown
}

/**
 * Bind {@linkcode WriteRecipeLine} to a sink, supplying the delimiter.
 *
 * The content and the delimiter are separate writes.
 * Stream writes are ordered, so the newline always follows its line, and concatenating the
 * two would stringify a non-string chunk through `toString()` and corrupt its bytes.
 */
export function createRecipeLineWriter(sink: RecipeLineSink): WriteRecipeLine {
	return (line) => {
		sink.write(line)
		sink.write("\n")
	}
}

/**
 * Run a canonical row through `alignRow` and, on success, write the `LabeledRow`
 * (+ `synth_method` / `synth_base_id`) as one jsonl line.
 *
 * @returns true if emitted, false if alignment quarantined it.
 */
export function alignAndWrite(
	write: WriteRecipeLine,
	canonical: CanonicalRecipeRow,
	synthMethod: string,
	synthBaseID: string | null = null
): boolean {
	const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

	if (!aligned.row) return false
	write(stringifyJSON({ ...aligned.row, synth_method: synthMethod, synth_base_id: synthBaseID }))

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
	input?: string
	count?: number
	golden?: boolean
	sourceName?: string
	// recipe-specific (each recipe reads only what it needs):
	houseNumberProb?: number
	pmbRatio?: number
	militaryRatio?: number
	reversedFraction?: number
	edgesDir?: string
	country?: string
	intlFraction?: number
	/**
	 * `german`: fraction of native-order rows rendered with no commas at all
	 * (`Neusser Str. 12 Nippes 50733 Köln`), the single-line register #1946 found
	 * the model loses the district on.
	 *
	 * Default 0.3.
	 */
	commaFreeFraction?: number
	/**
	 * `german`: fraction of rows that carry a WOF Ortsteil of the tuple's locality as `dependent_locality`.
	 *
	 * Default 0.3. 0 when no admin database is readable.
	 */
	ortsteilFraction?: number
	/**
	 * `german`: the WOF admin database the Ortsteil pool is read from.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority-importance.db`.
	 */
	adminDB?: string
	/**
	 * `locale`: fraction of rows that append an explicit country surface form + a `country` component.
	 *
	 * Default 0.
	 */
	countryFraction?: number
	/**
	 * `locale`: tri-state override of the per-part `districtAsLocality` mapping for this invocation.
	 *
	 * `undefined` (flag absent) leaves each `COUNTRY_SOURCES` part's own value untouched.
	 * Every existing locale build stays byte-identical.
	 *
	 * `true`/`false` forces that value on every part read this run.
	 *
	 * ES's pedanía recipe output (`synth-es-pedania`) additionally uses `true` to select
	 * {@link LocaleCountrySource.pedaniaParts} instead of the default `parts` — see `locale.ts`.
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
	banDir?: string
	multilocaleCount?: number
	/**
	 * `fr-fragment` / `no-fragment` / `no-street-led`: the eval board's reserved street-surface list.
	 *
	 * Required for those recipes — a recipe output that trains on its own eval set measures memorization.
	 * See their docstrings.
	 */
	excludeSurfaces?: string
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
	 * Default = the committed `corpus/data/sub-venue-lexicon.json`, resolved through the package manifest so it works from the source tree and from `out/`.
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
	 * Default `$MAILWOMAN_DATA_ROOT/poi/poi.db`.
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
	 * Rows dropped because their street surface is reserved by an eval board (`--exclude-surfaces`).
	 *
	 * Separate from `skipped` on purpose: a nonzero value is the audit trail that
	 * the train/eval split actually fired.
	 * Zero when a recipe has no board split.
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
 * A corpus recipe: its identity, input mode, and its synthesis `run`.
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
	 * Do the build: create the recipe's prng from `opts.seed` (its legacy generator — `makeLcg`
	 * or `makeMulberry32` — for byte-reproducibility), synthesize, and emit each row via `write`.
	 */
	run(opts: RecipeOptions, write: WriteRecipeLine): Promise<RecipeStats>
}
