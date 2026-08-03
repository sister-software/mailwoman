/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared scaffolding for the synthetic-corpus SHARD RECIPES — the common bits the 16
 *   `build-*-shard.mjs` scripts each re-implemented: the seeded LCG PRNG, the tuple reader, and the
 *   canonical → `alignRow` → `LabeledRow` JSONL emit step. A recipe ({@link ShardRecipe}) supplies
 *   only its synthesis + filter; the `mailwoman corpus shard <recipe>` command supplies the I/O.
 */

import { CSVSpliterator } from "spliterator"

import { stableSourceID } from "../adapter.ts"
import { alignRow } from "../align.ts"

/**
 * {@link stableSourceID}, but accepting arbitrary disambiguator keys (e.g. a variant index `v`) that aren't
 * `ComponentTag`s. `stableSourceID` sorts + hashes EVERY key it's given, so passing extra keys is how the legacy
 * builders kept per-variant ids unique — the strict typing is just too narrow for that. Centralizes the one cast.
 */
export function shardSourceID(adapterID: string, parts: Record<string, string | undefined>): string {
	return stableSourceID(adapterID, parts as unknown as Parameters<typeof stableSourceID>[1])
}

/**
 * A (locality, region, postcode, country) source tuple — the input to tuples-mode recipes.
 */
export interface ShardTuple {
	locality?: string
	region?: string
	postcode?: string
	country?: string
	[k: string]: unknown
}

/**
 * The two seeded generators the legacy `build-*-shard` scripts used, re-exported from their home in
 * `@mailwoman/core/utils` so a recipe keeps importing everything it needs from this one scaffold module.
 *
 * - `makeLcg` (`s = s*1664525 + 1013904223 mod 2^32`) — what the street/po-box/anchor builders seeded.
 * - `makeMulberry32` — what the MAJORITY of them used (german, locale, boundary-stress, unit, fr-order, country-balanced,
 *   intersection, fr-admin-split, street-affix, street-bare, po-box-cedex).
 *
 * A recipe must seed the same one its `.mjs` did, the same way it did (usually `seed`, but some derive a per-stream
 * seed), or `--seed N` stops being byte-reproducible.
 */
export { makeLcg, mulberry32 as makeMulberry32, makeLcg as makeRandom } from "@mailwoman/core/utils"

/**
 * One CSV record, keyed by its lower-cased header name, every value trimmed. A column the header does not declare reads
 * as `undefined`; a column the header declares but this record does not reach reads as `""`.
 */
export type CSVRecord = Record<string, string | undefined>

/**
 * Read an in-memory CSV (an `unzip -p` buffer, say) as header-keyed records.
 *
 * Quote handling spans the ROW split, not only the column split: a newline inside a quoted field belongs to a single
 * record, so the record boundaries can only be found by a scanner that already knows where the quotes are. Find the
 * lines first and unquote afterwards and such a record splits in two — the first half short by however many columns
 * followed the newline, which is how a `street` value comes to be read as `city`.
 *
 * Header names are lower-cased on the way in. `normalizeKeys` will not do it: it leaves an ALL CAPS header alone, and
 * OpenAddresses ships `LON,LAT,NUMBER,STREET` while other extracts ship the same names lower-case. A recipe names its
 * columns in lower case either way.
 *
 * Line breaks inside a value become single spaces. A quote-aware parse is the first thing here able to return a value
 * CONTAINING one — `us/ia/statewide.csv` has 12, all unit designators like `"#2\n#2"` — and every consumer synthesizes
 * one-line address text from these cells with no guard, because until that parse landed no value could carry one.
 * Collapsing keeps the record (the address is fine; the source's line break is not part of it) without emitting a
 * training row with a newline inside it.
 *
 * Only `\r` and `\n`, deliberately — NOT `\s`. Runs of spaces and tabs pass through exactly as the source wrote them
 * (OA's IA extract writes `NORTH`, three spaces, `MAIN STREET`), because those could always appear and every shard
 * built to date contains them. Widening this to `\s+` silently rewrites values on rows with no line break at all.
 * `scaffold.test.ts` pins both halves.
 */
export function* readCSVRecords(source: Uint8Array): Generator<CSVRecord> {
	let header: string[] | null = null

	// `header: false` keeps the first record in the stream so this reader owns the lower-casing.
	for (const cells of CSVSpliterator.from(source, { header: false, enableQuoteHandling: true })) {
		if (!header) {
			header = cells.map((name) => name.trim().toLowerCase())

			continue
		}

		const record: CSVRecord = {}

		for (let i = 0; i < header.length; i++) {
			record[header[i]!] = (cells[i] ?? "").replaceAll(/[\r\n]+/g, " ").trim()
		}

		yield record
	}
}

/**
 * Stream-parse a tuples JSONL file, yielding each parsed object (blank/invalid lines skipped).
 */
export async function* readTuples(input: string): AsyncGenerator<ShardTuple> {
	// TextSpliterator (not JSONSpliterator) so a malformed line is SKIPPED, not thrown — the
	// per-line try/catch below is the tolerance this reader has always had.
	const { TextSpliterator } = await import("spliterator")

	for await (const line of TextSpliterator.fromAsync(input)) {
		const trimmed = line.trim()

		if (!trimmed) continue

		try {
			yield JSON.parse(trimmed) as ShardTuple
		} catch {
			// skip malformed line
		}
	}
}

/**
 * A canonical row as the recipes assemble it, before `alignRow` turns it into a `LabeledRow`.
 */
export interface CanonicalShardRow {
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
 * Run a canonical row through `alignRow` and, on success, write the `LabeledRow` (+ `synth_method` / `synth_base_id`)
 * as one JSONL line. Returns true if emitted, false if alignment quarantined it.
 */
export function alignAndWrite(
	write: (line: string) => void,
	canonical: CanonicalShardRow,
	synthMethod: string,
	synthBaseID: string | null = null
): boolean {
	const aligned = alignRow(canonical as Parameters<typeof alignRow>[0])

	if (!aligned.row) return false
	write(JSON.stringify({ ...aligned.row, synth_method: synthMethod, synth_base_id: synthBaseID }) + "\n")

	return true
}

/**
 * Parsed options a recipe's `run` receives. Common fields + the union of recipe-specific flags.
 */
export interface ShardRecipeOpts {
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
	 * `locale`: fraction of rows that append an explicit country surface form + a `country` component. Default 0.
	 */
	countryFraction?: number
	/**
	 * `locale`: tri-state override of the per-part `districtAsLocality` mapping for this invocation. `undefined` (flag
	 * absent) leaves each `COUNTRY_SOURCES` part's own value untouched — every existing locale build stays
	 * byte-identical. `true`/`false` forces that value on every part read this run. ES's pedanía shard
	 * (`synth-es-pedania`) additionally uses `true` to select {@link LocaleCountrySource.pedaniaParts} instead of the
	 * default `parts` — see `locale.ts`.
	 */
	districtAsLocality?: boolean
	bareProb?: number
	hnProb?: number
	communes?: string
	/**
	 * `fr-lieudit`: BAN `adresses-<dept>.csv` directory. Default `$MAILWOMAN_DATA_ROOT/corpus/sources/ban`.
	 */
	banDir?: string
	multilocaleCount?: number
	/**
	 * `fr-fragment` / `no-fragment` / `no-street-led`: the eval board's reserved street-surface list. REQUIRED for those
	 * recipes — a shard that trains on its own eval set measures memorization. See their docstrings.
	 */
	excludeSurfaces?: string
	/**
	 * `no-fragment`: share of rows that are counter-distribution (bare locality OR bare postcode).
	 */
	counterProb?: number
	/**
	 * `no-fragment` knob 3: emit N copies of each street+number row whose number has >= longNumberMinDigits digits
	 * (oversample the failing long-number class). Default 1 = no boost.
	 */
	longNumberBoost?: number
	/**
	 * `no-fragment` knob 3: minimum digit count for a number to count as "long" and be boosted. Default 3.
	 */
	longNumberMinDigits?: number
}

/**
 * Tally a recipe returns.
 */
export interface ShardStats {
	read?: number
	emitted: number
	skipped: number
	/**
	 * Rows dropped because their street SURFACE is reserved by an eval board (`--exclude-surfaces`). Separate from
	 * `skipped` on purpose: a nonzero value is the audit trail that the train/eval split actually fired. Zero when a
	 * recipe has no board split.
	 */
	contaminated?: number
}

/**
 * A single declared recipe-specific option flag (for the command's --help).
 */
export interface ShardRecipeOption {
	flag: string
	description: string
}

/**
 * A shard recipe: its identity, input mode, and its synthesis `run`.
 */
export interface ShardRecipe {
	/**
	 * Recipe id, e.g. "street", "po-box" — the `<recipe>` positional.
	 */
	name: string
	/**
	 * One-line description for `--list` / help.
	 */
	description: string
	/**
	 * `tuples` reads `--input` JSONL; `generate` self-generates `--count` rows.
	 */
	mode: "tuples" | "generate"
	/**
	 * Recipe-specific flags this recipe honors (documentation only).
	 */
	options?: ShardRecipeOption[]
	/**
	 * Do the build: create the recipe's PRNG from `opts.seed` (its LEGACY generator — `makeLcg` or `makeMulberry32` — for
	 * byte-reproducibility), synthesize, and emit each row via `write`.
	 */
	run(opts: ShardRecipeOpts, write: (line: string) => void): Promise<ShardStats>
}
