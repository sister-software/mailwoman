/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-country accuracy of two or more models on the same held-out corpus rows.
 *
 *   The regression board holds rows for the locales the model already served, so a corpus change that adds
 *   countries shows its gains only where the board happens to hold a row. This grader reads rows that
 *   `corpus split-slice` routed to the test split and scores every arm on the same rows. Each row is parsed
 *   with its own country as the locale hint.
 *
 *   Every arm records one outcome per row, keyed by a stable row identity, so a later step can compute paired
 *   differences between the published model and a candidate. The primary outcome is exact parse correctness
 *   (`score/exact-parse`). Two diagnostics remain: a gold span counts as recovered when the parse holds its
 *   text, folded, under the same tag, and `goldRecovered` marks a row whose every gold span was recovered.
 *   `goldRecovered` permits additional predictions, so it differs from exact parse accuracy.
 */

import { type StreetSpanConvention, streetSpanConventionFor } from "@mailwoman/codex/street-convention"
import type { AddressTree } from "@mailwoman/core/decoder"
import { groupTuplesByTag, walkNodes } from "@mailwoman/core/decoder"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { readReleaseConfig, weightsPackageByCountry } from "@mailwoman/core/release-config"
import { type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import { normalizeDuckDBValue } from "@mailwoman/corpus/parquet/streams"
import { readSplitAttribute } from "@mailwoman/corpus/tools/overlay/split-attribute"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { foldCaseWhitespace } from "@mailwoman/normalize/fold"
import type { PathBuilderLike } from "path-ts"

import { scoreExactParseUnderConvention, validateAnnotatedSpans } from "#tools/eval-harness/score/exact-parse"

/**
 * One held-out row, in the corpus parquet schema.
 */
export interface HeldoutRow {
	raw: string
	span_starts: number[]
	span_ends: number[]
	span_tags: string[]
	country: string | null
	source: string
	source_id: string | null
	/**
	 * The independent sampling unit the row belongs to, as {@linkcode heldoutRowGroup} keys it.
	 */
	group: string
}

/**
 * The kind of a held-out row, as {@linkcode heldoutRowKind} reads it.
 */
export type HeldoutRowKind = "gazetteer" | "address"

/**
 * What is known about whether either compared model saw a row in training.
 *
 * - `verified_unseen`: a recorded exclusion history shows neither the published model
 *   nor the candidate trained on the row.
 * - `unseen_by_candidate`: a recorded history shows the candidate did not train on the row,
 *   while the published model did or its history is not established.
 *   A minimum check may read such a row.
 *   A comparative check may not, because the row favors the published model.
 * - `known_overlap`: a recorded history shows at least one of them trained on the row.
 * - `unknown`: no recorded history covers the row.
 *
 * A class other than `unknown` is assigned only from a {@linkcode ProvenanceHistory}
 * entry for the row's identity.
 * Membership in the test split is not evidence: a row moved into the test split by a
 * split repair may have been in the published model's training data.
 */
export type HeldoutProvenance = "verified_unseen" | "unseen_by_candidate" | "known_overlap" | "unknown"

/**
 * A recorded exclusion history entry for one row.
 */
export interface ProvenanceRecord {
	provenance: Exclude<HeldoutProvenance, "unknown">
	/**
	 * Where the history was recorded, such as an overlap audit's artifact path and hash.
	 */
	evidence: string
}

/**
 * Recorded exclusion history keyed by {@linkcode heldoutRowID}.
 */
export type ProvenanceHistory = ReadonlyMap<string, ProvenanceRecord>

/**
 * Available and sampled test rows for one country and row kind.
 */
export interface HeldoutCellCount {
	country: string
	kind: HeldoutRowKind
	available: number
	sampled: number
}

/**
 * One arm's outcome on one row.
 */
export interface HeldoutRowOutcome {
	rowID: string
	country: string
	source: string
	kind: HeldoutRowKind
	/**
	 * The row's {@linkcode heldoutRowGroup}, which keeps derived variants together in resampling.
	 */
	group: string
	provenance: HeldoutProvenance
	/**
	 * The weights locale package that parsed the row, under {@linkcode HELDOUT_INFERENCE_RULE}.
	 * Absent when the parse function named no package.
	 */
	weightsLocale?: string
	/**
	 * The predicted spans equal the annotated spans, with no missing and no additional span.
	 */
	exact: boolean
	/**
	 * The country's street span convention the row was scored under.
	 */
	streetConvention: StreetSpanConvention
	/**
	 * The `whole` convention's street join changed `exact`.
	 */
	streetJoinChanged: boolean
	missingSpans: number
	additionalSpans: number
	spans: number
	spansRecovered: number
	/**
	 * Every gold span was recovered by folded text.
	 * Additional predictions are permitted.
	 */
	goldRecovered: boolean
}

/**
 * One country and row kind's totals for one arm.
 */
export interface CountryScore {
	rows: number
	/**
	 * Rows whose predicted spans exactly equal the annotated spans.
	 */
	rowsExactParse: number
	/**
	 * Rows whose `exact` the `whole` street convention's join changed.
	 */
	rowsStreetJoinChanged: number
	/**
	 * Rows whose every gold span the parse recovered, permitting additional predictions.
	 * A diagnostic.
	 */
	rowsGoldRecovered: number
	spans: number
	spansRecovered: number
}

/**
 * The cell kind that holds a country's capability-probe rows, apart from its address and gazetteer cells.
 */
export const HELDOUT_CAPABILITY_CELL = "capability"

/**
 * The cell key a scored row is totaled under: `<country>/<kind>`, or `<country>/capability`
 * for a row whose source is a capability probe.
 */
export function heldoutCellKey(
	outcome: Pick<HeldoutRowOutcome, "country" | "kind" | "source">,
	capabilitySources: ReadonlySet<string>
): string {
	return `${outcome.country}/${capabilitySources.has(outcome.source) ? HELDOUT_CAPABILITY_CELL : outcome.kind}`
}

/**
 * One arm's per-row outcomes, in row order, and their totals keyed by {@linkcode heldoutCellKey}.
 */
export interface HeldoutArmResult {
	rows: HeldoutRowOutcome[]
	cells: Map<string, CountryScore>
}

/**
 * Whether a row is a gazetteer surface or an address, read from its source.
 *
 * Who's On First sources render place names with their admin parents, such as
 * `Wollin, Mecklenburg-Vorpommern`, and make up most of a small country's test rows.
 * Scored together with addresses they set a country's score by the source mix
 * rather than by how the model reads addresses.
 */
export function heldoutRowKind(source: string): HeldoutRowKind {
	return source.startsWith("wof-") ? "gazetteer" : "address"
}

/**
 * A row's stable identity: `<source>:<source_id>`, or `<source>:raw-sha256:<hex>`
 * when the row has no `source_id`.
 */
export function heldoutRowID(row: Pick<HeldoutRow, "source" | "source_id" | "raw">): string {
	return row.source_id ? `${row.source}:${row.source_id}` : `${row.source}:raw-sha256:${sha256Hex(row.raw)}`
}

/**
 * The grouping columns a held-out sample reads from every test file.
 */
export const HELDOUT_GROUP_COLUMNS = ["source_id", "base_source_id"] as const

/**
 * The independent group of one corpus row: its `base_source_id` when the row was
 * derived from a base row, else its own `source_id`.
 *
 * A derived row records the `source_id` of the row it came from, so a base row
 * and every augmentation of it (case, typo, reorder variants) share one group,
 * and the paired bootstrap resamples them together.
 *
 * The key is not prefixed with the source.
 * A base row may sit in a different source from its derivatives, and a
 * recipe may name a base by a register key such as `<register>:<csv>:<key>`,
 * so a source prefix would split groups that belong together.
 *
 * Two unrelated sources that happen to share an id string are merged into one group,
 * which widens an interval rather than narrowing it.
 *
 * Limits: the group joins only rows linked through `base_source_id`.
 * Two distinct rows describing the same address from different publishers,
 * or many addresses on one street or in one small place, remain separate groups.
 *
 * A larger unit for that shared place or source structure needs a key the corpus does not yet record.
 *
 * @throws When neither column holds a non-empty string: an unreadable grouping column
 * is refused rather than defaulted to the row's own identity.
 */
export function heldoutRowGroup(row: { source_id?: unknown; base_source_id?: unknown }, rowLabel: string): string {
	const base = row.base_source_id

	if (base != null) {
		if (typeof base !== "string" || !base) {
			throw new Error(`held-out row ${rowLabel} holds an unreadable base_source_id: ${stringifyJSON(base)}`)
		}

		return base
	}

	const own = row.source_id

	if (typeof own !== "string" || !own) {
		throw new Error(
			`held-out row ${rowLabel} has no readable grouping column: base_source_id is null and source_id is ${stringifyJSON(own ?? null)}`
		)
	}

	return own
}

/**
 * Throws unless every file carries the grouping columns.
 *
 * `read_parquet(..., union_by_name = true)` fills a column a file lacks with `NULL`,
 * which would read as "not derived" on every row of that file.
 */
export async function assertGroupColumns(files: readonly string[]): Promise<void> {
	for (const file of files) {
		const columns = await parquetColumnNames(file)
		const missing = HELDOUT_GROUP_COLUMNS.filter((column) => !columns.includes(column))

		if (missing.length) {
			throw new Error(`${file} lacks the grouping column(s) ${missing.join(", ")}; refusing to sample without them`)
		}
	}
}

/**
 * The rule a held-out sample is drawn by, recorded in a dataset manifest.
 */
export interface HeldoutSamplingRule {
	/**
	 * `per-record-country-kind-hash-order`: one row per `<source>:<source_id>` record,
	 * then the per-country and per-kind quota in hash order.
	 *
	 * The method enters the dataset version, so a change to which rows a sample reads changes the method name.
	 */
	method: "per-record-country-kind-hash-order"
	/**
	 * Rows drawn per country and row kind.
	 */
	perCountry: number
	/**
	 * Mixed into the order hash; `null` orders by `hash(raw)` alone.
	 */
	seed: number | null
	/**
	 * The ordering expression, for a reader outside this module.
	 */
	order: string
	/**
	 * The dataset whose groups this sample never draws, so the two are disjoint by group and by row.
	 */
	excludes?: { datasetID: string; version: string }
	/**
	 * Manifest file paths the sample did not read, such as a file that lacks a grouping column.
	 */
	skippedFiles?: string[]
}

/**
 * A frozen dataset whose groups a new sample must not draw.
 */
export interface HeldoutSampleExclusion {
	datasetID: string
	version: string
	groups: readonly string[]
}

/**
 * The ordering a sample with `seed` uses: DuckDB `hash`, then the row's identity columns
 * as a tiebreak so rows with identical text are drawn in a fixed order.
 */
export function heldoutSampleOrder(seed: number | null): string {
	const key = seed == null ? "hash(raw)" : `hash(raw, ${Math.trunc(seed).toString()})`

	return `${key}, source, source_id`
}

/**
 * Reads up to `perCountry` test-split rows per country and row kind from a corpus
 * manifest's test files, with the number of test rows available in each cell.
 *
 * The rows of each country are ordered by a hash of their text, so the same
 * corpus yields the same sample on every run.
 *
 * @param pathRoot The local directory that stands for the manifest's `/data` prefix, such as the data root.
 */
export async function sampleHeldoutRows(
	manifestPath: PathBuilderLike,
	perCountry: number,
	pathRoot: string,
	seed: number | null = null,
	limits: DuckDBLimits = {},
	exclude: HeldoutSampleExclusion | null = null,
	skipFiles: readonly string[] = []
): Promise<{
	rows: HeldoutRow[]
	counts: HeldoutCellCount[]
	files: string[]
	rule: HeldoutSamplingRule
}> {
	const manifest = await readLocalJSONFile<{
		slices: Array<{
			path: string
			split?: string
			split_attribute?: { path?: unknown; sha256?: unknown; counts?: { test?: unknown } }
		}>
	}>(manifestPath)

	const files: string[] = []
	// A file split by an attribute holds every split.
	// Only the attribute's `test` ids are read from it.
	const attributeTestIDs: Array<{ file: string; ids: string[] }> = []

	const unlisted = skipFiles.filter((path) => !manifest.slices.some((slice) => slice.path === path))

	if (unlisted.length) throw new Error(`${manifestPath.toString()} lists no file ${unlisted.join(", ")} to skip`)

	for (const slice of manifest.slices) {
		if (skipFiles.includes(slice.path)) continue

		const file = slice.path.replace(/^\/data/u, pathRoot)

		if (slice.split === "test") {
			files.push(file)

			continue
		}

		const reference = slice.split_attribute

		if (!reference) continue

		if (typeof reference.path !== "string" || typeof reference.sha256 !== "string") {
			throw new TypeError(`${manifestPath.toString()} file ${slice.path} names an incomplete split attribute`)
		}

		const attributePath = reference.path.replace(/^\/data/u, pathRoot)
		const digest = await sha256File(attributePath)

		if (digest !== reference.sha256) {
			throw new Error(`${attributePath} has sha256 ${digest}; ${manifestPath.toString()} records ${reference.sha256}`)
		}

		const { test } = await readSplitAttribute(attributePath)

		if (!test.length) continue

		files.push(file)
		attributeTestIDs.push({ file, ids: test })
	}

	if (!files.length) throw new Error(`${manifestPath.toString()} lists no test files`)

	await assertGroupColumns(files)

	using db = await openDuckDB(limits)

	await db.run(`CREATE TEMP TABLE attribute_files (file VARCHAR)`)
	await db.run(`CREATE TEMP TABLE attribute_test (file VARCHAR, source_id VARCHAR)`)
	await db.run(`CREATE TEMP TABLE excluded_groups (k VARCHAR)`)

	const insert = async (table: string, tuples: string[]) => {
		for (let start = 0; start < tuples.length; start += 5000) {
			await db.run(`INSERT INTO ${table} VALUES ${tuples.slice(start, start + 5000).join(", ")}`)
		}
	}

	const quote = (value: string) => `'${escapeSQLString(value)}'`

	await insert(
		"attribute_files",
		attributeTestIDs.map(({ file }) => `(${quote(file)})`)
	)

	await insert(
		"attribute_test",
		attributeTestIDs.flatMap(({ file, ids }) => ids.map((id) => `(${quote(file)}, ${quote(id)})`))
	)

	await insert(
		"excluded_groups",
		(exclude?.groups ?? []).map((group) => `(${quote(group)})`)
	)

	// A row's identity is its record, `<source>:<source_id>` (`heldoutRowID`),
	// and the overlap audit joins training rows on that record.
	// A test split can hold one record more than once: the same row written twice,
	// or several renderings of one record under its id.
	// The sample and the available counts therefore read one row per record, the first in sample order.
	// Rows without a `source_id` are identified by their text and keep every distinct row.
	// A row whose group (`heldoutRowGroup`) an excluded dataset holds is never drawn.
	const source =
		`(SELECT DISTINCT raw, span_starts, span_ends, span_tags, country, source, source_id, base_source_id ` +
		`FROM read_parquet([${files.map(quote).join(", ")}], union_by_name = true, filename = true) t ` +
		`WHERE (t.filename NOT IN (SELECT file FROM attribute_files) ` +
		`OR (t.filename, CAST(t.source_id AS VARCHAR)) IN (SELECT (file, source_id) FROM attribute_test)) ` +
		`AND coalesce(CAST(t.base_source_id AS VARCHAR), CAST(t.source_id AS VARCHAR)) NOT IN (SELECT k FROM excluded_groups) ` +
		`QUALIFY source_id IS NULL OR row_number() OVER (PARTITION BY source, source_id ORDER BY ${heldoutSampleOrder(seed)}) = 1)`

	const reader = await db.runAndReadAll(
		`SELECT raw, span_starts, span_ends, span_tags, country, source, source_id, base_source_id FROM ${source} ` +
			// Each country draws its quota of address rows and of gazetteer rows separately (`heldoutRowKind`).
			`QUALIFY row_number() OVER (PARTITION BY coalesce(country, 'ZZ'), starts_with(source, 'wof-') ORDER BY ${heldoutSampleOrder(seed)}) <= ` +
			Math.trunc(perCountry).toString() +
			// Without an ORDER BY, DuckDB returns the window's rows in a run-dependent order,
			// and the rows file's sha256, which a dataset manifest records, would differ between
			// two freezes of one sample.
			` ORDER BY coalesce(country, 'ZZ'), starts_with(source, 'wof-'), ${heldoutSampleOrder(seed)}`
	)

	const availableReader = await db.runAndReadAll(
		`SELECT coalesce(country, 'ZZ') AS country, starts_with(source, 'wof-') AS gazetteer, count(*) AS n FROM ${source} GROUP BY ALL`
	)

	const spanList = (value: unknown): unknown[] => {
		const normalized = normalizeDuckDBValue(value)

		if (!Array.isArray(normalized))
			throw new Error(`a held-out row holds a non-list span column: ${String(normalized)}`)

		return normalized
	}

	const rows = reader.getRowObjects().map((row): HeldoutRow => ({
		group: heldoutRowGroup(row, `${String(row.source)}:${String(row.source_id)}`),
		raw: String(row.raw),
		span_starts: spanList(row.span_starts).map(Number),
		span_ends: spanList(row.span_ends).map(Number),
		span_tags: spanList(row.span_tags).map((tag) => {
			if (typeof tag !== "string") throw new Error(`a held-out row holds a non-string span tag: ${stringifyJSON(tag)}`)

			return tag
		}),
		country: row.country == null ? null : String(row.country),
		source: String(row.source),
		source_id: row.source_id == null ? null : String(row.source_id),
	}))

	const available = availableReader.getRowObjects().map((row) => ({
		country: String(row.country),
		kind: (row.gazetteer === true ? "gazetteer" : "address") as HeldoutRowKind,
		available: Number(row.n),
	}))

	const rule: HeldoutSamplingRule = {
		method: "per-record-country-kind-hash-order",
		perCountry: Math.trunc(perCountry),
		seed,
		order: heldoutSampleOrder(seed),
		...(exclude ? { excludes: { datasetID: exclude.datasetID, version: exclude.version } } : {}),
		...(skipFiles.length ? { skippedFiles: [...skipFiles].toSorted() } : {}),
	}

	return { rows, counts: countHeldoutCells(available, rows), files, rule }
}

/**
 * Joins each cell's available test-row count with the number of sampled rows in it.
 */
export function countHeldoutCells(
	available: ReadonlyArray<{
		country: string
		kind: HeldoutRowKind
		available: number
	}>,
	sampled: readonly HeldoutRow[]
): HeldoutCellCount[] {
	const counts = new Map<string, HeldoutCellCount>()

	for (const cell of available) {
		counts.set(`${cell.country}/${cell.kind}`, { ...cell, sampled: 0 })
	}

	for (const row of sampled) {
		const key = `${row.country ?? "ZZ"}/${heldoutRowKind(row.source)}`
		const cell = counts.get(key)

		if (!cell) throw new Error(`sampled row ${heldoutRowID(row)} falls in ${key}, which the availability count lacks`)

		cell.sampled++
	}

	return [...counts.values()].toSorted((a, b) => `${a.country}/${a.kind}`.localeCompare(`${b.country}/${b.kind}`))
}

/**
 * Scores one parse of one row.
 */
export function scoreHeldoutRow(row: HeldoutRow, tree: AddressTree, history?: ProvenanceHistory): HeldoutRowOutcome {
	const rowID = heldoutRowID(row)
	const annotated = validateAnnotatedSpans(row, rowID)

	const exactOutcome = scoreExactParseUnderConvention(
		row.raw,
		annotated,
		[...walkNodes(tree.roots)],
		streetSpanConventionFor(row.country)
	)

	const byTag = groupTuplesByTag(tree)

	let spansRecovered = 0

	for (const [i, tag] of row.span_tags.entries()) {
		const gold = foldCaseWhitespace(row.raw.slice(row.span_starts[i], row.span_ends[i]))

		if ((byTag.get(tag) ?? []).some((value) => foldCaseWhitespace(value) === gold)) {
			spansRecovered++
		}
	}

	return {
		rowID,
		country: row.country ?? "ZZ",
		source: row.source,
		kind: heldoutRowKind(row.source),
		group: row.group,
		provenance: history?.get(rowID)?.provenance ?? "unknown",
		exact: exactOutcome.exact,
		streetConvention: exactOutcome.streetConvention,
		streetJoinChanged: exactOutcome.streetJoinChanged,
		missingSpans: exactOutcome.missing.length,
		additionalSpans: exactOutcome.additional.length,
		spans: row.span_tags.length,
		spansRecovered,
		goldRecovered: spansRecovered === row.span_tags.length,
	}
}

/**
 * Scores one arm over every row, given a parse function.
 *
 * A row whose source is in `capabilitySources` keeps its outcome, which the capability
 * checks read, and is totaled in its country's capability cell rather than its address cell.
 * A release specification names those sources through `capabilityProbeSources`.
 *
 * Refuses rows that share an identity, because paired outcomes are joined by identity.
 */
export async function scoreHeldoutArm(
	rows: readonly HeldoutRow[],
	parse: (row: HeldoutRow) => Promise<AddressTree>,
	history?: ProvenanceHistory,
	weightsLocaleFor?: (row: HeldoutRow) => string,
	capabilitySources: ReadonlySet<string> = new Set()
): Promise<HeldoutArmResult> {
	const outcomes: HeldoutRowOutcome[] = []
	const cells = new Map<string, CountryScore>()
	const seen = new Set<string>()

	for (const row of rows) {
		const outcome = scoreHeldoutRow(row, await parse(row), history)

		if (weightsLocaleFor) {
			outcome.weightsLocale = weightsLocaleFor(row)
		}

		if (seen.has(outcome.rowID)) {
			throw new Error(`two held-out rows share the identity ${outcome.rowID}`)
		}

		seen.add(outcome.rowID)
		outcomes.push(outcome)

		const key = heldoutCellKey(outcome, capabilitySources)

		const cell = cells.get(key) ?? {
			rows: 0,
			rowsExactParse: 0,
			rowsStreetJoinChanged: 0,
			rowsGoldRecovered: 0,
			spans: 0,
			spansRecovered: 0,
		}

		cell.rows++
		cell.spans += outcome.spans
		cell.spansRecovered += outcome.spansRecovered

		if (outcome.exact) {
			cell.rowsExactParse++
		}

		if (outcome.streetJoinChanged) {
			cell.rowsStreetJoinChanged++
		}

		if (outcome.goldRecovered) {
			cell.rowsGoldRecovered++
		}

		cells.set(key, cell)
	}

	return { rows: outcomes, cells }
}

/**
 * Throws unless every arm scored the same row identities in the same order.
 */
export function assertPairedArms(arms: readonly HeldoutArmResult[]): void {
	const [first, ...rest] = arms

	if (!first) throw new Error("no arms to pair")

	for (const [index, arm] of rest.entries()) {
		if (arm.rows.length !== first.rows.length) {
			throw new Error(`arm ${index + 1} scored ${arm.rows.length} rows; arm 0 scored ${first.rows.length}`)
		}

		for (const [i, outcome] of arm.rows.entries()) {
			if (outcome.rowID !== first.rows[i]!.rowID) {
				throw new Error(`arm ${index + 1} row ${i} is ${outcome.rowID}; arm 0 row ${i} is ${first.rows[i]!.rowID}`)
			}
		}
	}
}

/**
 * The rule that chooses the weights package each held-out row is parsed with,
 * recorded in every report and every release verdict.
 */
export const HELDOUT_INFERENCE_RULE =
	"served-locale-package: each row is parsed by the shipped Latin locale package whose region subtag is the " +
	"row's country (release.config.json `locales`, through weightsPackageByCountry), loaded from the arm's " +
	"weights cache; a country without a shipped package is parsed by en-us. NeuralAddressClassifier.parse runs " +
	"with postcodeRepair and the row's country as localeHint. A package whose loader reports an unfed required " +
	"channel is refused."

/**
 * The base package a country without its own shipped package is parsed with.
 */
export const HELDOUT_BASE_LOCALE = "en-us"

/**
 * Returns the shipped Latin locale packages keyed by country, as production installs them.
 *
 * Only `locales` is read: the character-path families in `charWeights` are separate graphs
 * and outside the Latin graph's release requirements.
 */
export async function readHeldoutLocalePackages(): Promise<ReadonlyMap<string, string>> {
	const config = await readReleaseConfig()

	return weightsPackageByCountry({ locales: config.locales })
}

/**
 * The weights locale package a row is parsed with under {@linkcode HELDOUT_INFERENCE_RULE}.
 */
export function heldoutWeightsLocale(country: string | null, packages: ReadonlyMap<string, string>): string {
	return (country && packages.get(country.toUpperCase())) || HELDOUT_BASE_LOCALE
}

/**
 * The part of a loaded classifier the held-out scorer uses.
 */
export type HeldoutClassifier = Pick<NeuralAddressClassifier, "parse" | "unfedChannels">

/**
 * Loads one locale package from a weights cache.
 */
export type HeldoutClassifierLoader = (locale: string, cacheRoot: string) => Promise<HeldoutClassifier>

const loadFromCache: HeldoutClassifierLoader = (locale, cacheRoot) =>
	NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot })

/**
 * Scores one model, loaded from a package-shaped weights cache as `mwdev_arc` takes, over every row,
 * parsing each row with the package {@linkcode HELDOUT_INFERENCE_RULE} names and recording it per row.
 *
 * @throws When a package the rows need is absent from the cache, or its loader reports an unfed
 * required channel: a degraded configuration is not the product the requirements describe.
 */
export async function scoreHeldoutWeights(
	rows: readonly HeldoutRow[],
	cacheRoot: string,
	history?: ProvenanceHistory,
	options: {
		packages?: ReadonlyMap<string, string>
		load?: HeldoutClassifierLoader
		/**
		 * Sources totaled in a country's capability cell, as {@linkcode scoreHeldoutArm} takes them.
		 */
		capabilitySources?: ReadonlySet<string>
	} = {}
): Promise<HeldoutArmResult> {
	const packages = options.packages ?? (await readHeldoutLocalePackages())
	const load = options.load ?? loadFromCache
	const classifiers = new Map<string, Promise<HeldoutClassifier>>()

	const classifierFor = (locale: string): Promise<HeldoutClassifier> => {
		let pending = classifiers.get(locale)

		if (!pending) {
			pending = load(locale, cacheRoot).then((classifier) => {
				const [unfed, ...more] = classifier.unfedChannels

				if (unfed) {
					throw new Error(
						`refusing to score ${locale} from ${cacheRoot}: the loader reports the required ${unfed.channel} ` +
							`channel unfed for ${unfed.weightsPackage} (${unfed.detail})` +
							(more.length ? `, and ${more.map((m) => m.channel).join(", ")} as well` : "")
					)
				}

				return classifier
			})

			classifiers.set(locale, pending)
		}

		return pending
	}

	const localeFor = (row: HeldoutRow) => heldoutWeightsLocale(row.country, packages)

	return scoreHeldoutArm(
		rows,
		async (row) =>
			(await classifierFor(localeFor(row))).parse(row.raw, {
				postcodeRepair: true,
				...(row.country ? { localeHint: row.country } : {}),
			}),
		history,
		localeFor,
		options.capabilitySources
	)
}
