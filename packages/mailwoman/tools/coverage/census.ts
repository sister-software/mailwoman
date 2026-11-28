// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Reports per-country coverage across the corpus, training admission, weights packages, gazetteer and board.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isDirectory, pathExists, statPath } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { ProcessProgress } from "@mailwoman/core/scripting/process"
import { tryParsingJSON } from "@mailwoman/core/values/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { readReleaseConfig, weightsPackageByCountry } from "@mailwoman/core/repo/release-config"
import {
	readScopeConfig,
	type ScopeConfig,
	shippedTrainingConfig,
	shippedTrainingConfigs,
} from "@mailwoman/core/repo/scope-config"
import { dataRootPath } from "@mailwoman/core/data-root"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { allRows } from "@mailwoman/core/utils"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { DEFAULT_LABEL_SET } from "@mailwoman/neural/labels"

import { loadTrainingConfig } from "#tools/training/config"
import { countTrainShapes } from "#tools/training/exposure/train-shapes"

/**
 * Describes the best geocoding a country gets and whether its rooftop data is published or build-local.
 */
export type GeocodeTier = "rooftop-published" | "rooftop-build-local" | "locality" | "none"

/**
 * Holds the coverage summary for one country.
 */
export interface CountryCoverage {
	country: string
	/**
	 * Counts train-split rows across all corpus sources.
	 */
	corpusRows: number
	/**
	 * Counts rows labeled with a street or house number.
	 */
	corpusStreetRows: number
	/**
	 * Counts train rows written in the country's own address form, across the main corpus
	 * and every graph corpus the census read: a span tagged as {@linkcode ADDRESS_FORM_TAG} matches.
	 *
	 * A block-addressed country writes no street.
	 * Its rows label `block`, `sub_block` and `building_number`, or a compact `house_number`,
	 * and they train the graph whose label set holds those tags, so `corpusStreetRows` undercounts it.
	 */
	addressFormRows: number
	/**
	 * Reports whether `country_weights` admits this country.
	 */
	admitted: boolean
	/**
	 * Holds the locale package name when one ships.
	 */
	weightsPackage: string | null
	/**
	 * Counts admin places in the serving gazetteer.
	 */
	gazetteerPlaces: number
	geocodeTier: GeocodeTier
	/**
	 * Counts all board rows.
	 * `boardPassedRows` counts the rows with `status: pass`.
	 */
	boardRows: number
	boardPassedRows: number
}

/**
 * Reports whether a country trains.
 *
 * A country trains only when it is admitted and has at least one corpus row.
 */
export function trains(c: Pick<CountryCoverage, "admitted" | "corpusRows">): boolean {
	return c.admitted && c.corpusRows > 0
}

/**
 * Lists the countries where two coverage sources disagree, grouped by the kind of disagreement.
 */
export interface CoverageMismatches {
	/**
	 * Lists countries with corpus rows that the training config excludes.
	 */
	presentButDropped: string[]
	/**
	 * Lists admitted countries with no corpus rows.
	 */
	admittedButEmpty: string[]
	/**
	 * Lists countries with a weights package that do not train.
	 */
	packageWithoutTraining: string[]
	/**
	 * Lists training countries with no passing board case.
	 */
	trainedButUnmeasured: string[]
	/**
	 * Lists countries with board rows that do not train.
	 */
	measuredButUntrained: string[]
}

/**
 * The codes a corpus row may contain that identify no jurisdiction.
 */
const COUNTRY_LESS_CODES = ["ZZ", "??"] as const

/**
 * Describes each country-less code and the measurements for its rows.
 */
const COUNTRY_LESS_READINGS: Readonly<Record<string, string>> = {
	ZZ:
		"The ISO 3166-1 user-assigned range. In `v0.6.0-register-surface` these are bare place names from " +
		"the retired `synth-fragment` recipe, every one `locale: und`. Measured 2026-09-28 against the " +
		"candidate gazetteer: 3,115 resolve to exactly one country, 1,646 to several, and 4 to none. An " +
		"assembly can attribute the 3,115 to their country. The other 1,650 stay country-less because " +
		"the gazetteer doesn't settle them (#2358).",
	"??": "A row whose `country` column is empty, which the training loader drops.",
}

/**
 * One code the corpus contains that identifies no jurisdiction.
 *
 * `ZZ` is the ISO 3166-1 user-assigned range and `??` marks a row whose `country` is empty.
 * The per-country table drops both, because a reader counting its rows would report
 * a jurisdiction the register doesn't enumerate.
 *
 * An unreported drop makes 4,765 rows of `v0.6.0-register-surface` invisible,
 * so they're reported here instead.
 */
export interface CountryLessRows {
	code: string
	rows: number
	streetRows: number
	/**
	 * Describes the code and the evidence for attributing its rows.
	 */
	reading: string
}

/**
 * Holds the full coverage report that `censusCoverage` returns.
 */
export interface CoverageReport {
	countries: CountryCoverage[]
	/**
 * Rows the corpus contains under a code that identifies no jurisdiction, excluded from `countries`.
	 *
 * Empty where the counted corpus contains no such row.
	 */
	countryLess: CountryLessRows[]
	mismatches: CoverageMismatches
	corpusVersion: string
	/**
	 * Holds the corpus version that the training config references.
	 */
	configuredCorpusVersion: string | null
	/**
	 * Explains the mismatch when the counted corpus differs from the configured corpus.
	 */
	corpusMismatch: string | null
	corpusRowsTotal: number
	/**
	 * Holds the cached census timestamp, or `null` when the corpus was recounted in this run.
	 */
	corpusCensusTakenAt: string | null
	/**
	 * The corpus of each graph whose config declares its own label set,
	 * counted beside the main corpus for `addressFormRows`.
	 */
	graphCorpora: GraphCorpusReading[]
	configPath: string
	gazetteerPath: string
	notes: string[]
}

/**
 * Returns the path of the cached corpus census under the data root.
 */
export function corpusCensusPath(): PathBuilder {
	return dataRootPath("corpus", "coverage-census.json")
}

interface CorpusCensus {
	takenAt: string
	corpusVersion: string
	manifest: string
	total: number
	rows: Record<string, number>
	streetRows: Record<string, number>
	/**
	 * Rows with a span tagged as {@linkcode ADDRESS_FORM_TAG} matches, per country.
	 */
	addressFormRows: Record<string, number>
	/**
	 * These file counts and unreadable paths show when a total covers only part of the corpus.
	 */
	filesRead: number
	filesListed: number
	unreadableFiles: string[]
}

/**
 * Matches a span tag that makes its row a street row.
 *
 * The tags are `street`, a `street_*` affix, and `house_number`.
 */
const STREET_TAG = /^street($|_)|^house_number$/

/**
 * Matches a span tag that writes a row in its country's own address form:
 * a street tag, or one of the block-address tags `block`, `sub_block`
 * and `building_number` (`docs/engineering/reference/SCHEMA.mdx`).
 *
 * One tag set serves every country without a per-country table, because only the label
 * sets of block-addressed locales hold the block-address tags.
 * A Japanese row writes `2-3-16` as one compact `house_number` and `2丁目3番16号` as the three
 * block tags, and a Korean lot-number row writes its number as `house_number` with no street.
 */
export const ADDRESS_FORM_TAG = /^street($|_)|^house_number$|^block$|^sub_block$|^building_number$/

/**
 * Counts train-split rows and street rows per country.
 *
 * The rows are the ones {@linkcode countTrainShapes} selects, the sampler's train split.
 * One DuckDB query groups them on every core the host gives DuckDB.
 *
 * A street row has a span tagged `street`, a `street_*` affix or `house_number`.
 *
 * @throws If the manifest lists files but selects no train file.
 * Also if a train file is absent, or the total differs from the manifest's `counts.train`.
 */
// repo-health-ignore export-name-affix -- counts rows in a built corpus. @mailwoman/corpus's buildCorpus creates it
export async function buildCorpusCensus(
	manifestPath: PathBuilderLike,
	progress?: (step: ProcessProgress) => void
): Promise<CorpusCensus> {
	const manifest = await readLocalJSONFile<{ corpus_version?: string; files?: unknown } & Record<string, unknown>>(
		manifestPath
	)

	const listed = baseManifestFiles<{ path: string; split?: string; split_attribute?: { path: string } }>(manifest)

	// A file either records one `split`, or holds every split's rows and points under
	// `split_attribute` at the held-out ids that decide each row.
	const parquetFiles = listed
		.filter((file) => file.path && (file.split === "train" || file.split_attribute))
		.map((file) => localManifestFilePath(file.path))

	if (listed.length && !parquetFiles.length) {
		throw new Error(
			`${manifestPath} lists ${listed.length} file(s) and none carries split "train" or a split_attribute, ` +
				"so this census cannot select the train rows."
		)
	}

	const unreadableFiles: string[] = []

	progress?.({ stage: `Checking ${parquetFiles.length} train file(s)` })

	for (const path of parquetFiles) {
		if (!(await pathExists(path))) {
			unreadableFiles.push(path)
		}
	}

	if (unreadableFiles.length) {
		throw new Error(
			`${unreadableFiles.length} of ${parquetFiles.length} train file(s) listed by ${manifestPath} are absent ` +
				`(first: ${unreadableFiles[0]}). Refusing to report a partial corpus — check MAILWOMAN_DATA_ROOT ` +
				"and the manifest's paths."
		)
	}

	const rows: Record<string, number> = {}
	const streetRows: Record<string, number> = {}
	const addressFormRows: Record<string, number> = {}
	let total = 0

	const shapes = parquetFiles.length
		? await countTrainShapes(manifestPath.toString(), progress ? { progress } : {})
		: []

	for (const shape of shapes) {
		const country = (shape.country ?? "").toUpperCase() || "??"

		total += shape.rows
		rows[country] = (rows[country] ?? 0) + shape.rows

		if (shape.spanTags?.some((tag) => STREET_TAG.test(tag))) {
			streetRows[country] = (streetRows[country] ?? 0) + shape.rows
		}

		if (shape.spanTags?.some((tag) => ADDRESS_FORM_TAG.test(tag))) {
			addressFormRows[country] = (addressFormRows[country] ?? 0) + shape.rows
		}
	}

	const declaredTrain = (manifest["counts"] as { train?: unknown } | undefined)?.train

	if (typeof declaredTrain === "number" && declaredTrain !== total) {
		throw new Error(`Corpus census counted ${total} train rows, and ${manifestPath} declares ${declaredTrain}.`)
	}

	const filesRead = parquetFiles.length

	return {
		takenAt: new Date().toISOString(),
		corpusVersion: manifest.corpus_version ?? "unknown",
		manifest: manifestPath.toString(),
		total,
		rows,
		streetRows,
		addressFormRows,
		filesRead,
		filesListed: parquetFiles.length,
		unreadableFiles,
	}
}

/**
 * Compares two corpus versions, ignoring an optional leading `v`.
 */
export function sameCorpusVersion(a: string, b: string): boolean {
	const bare = (version: string): string => version.trim().replace(/^v/, "")

	return bare(a) === bare(b)
}

/**
 * Reads the corpus version from a training config's `corpus_dir`.
 *
 * Returns `null` when the config is missing or has no `corpus_dir`.
 */
export async function readConfiguredCorpusVersion(configPath: PathBuilderLike): Promise<string | null> {
	if (!(await pathExists(configPath))) return null

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a training config is a few hundred lines, read sync
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		const match = /^\s*corpus_dir:\s*["']?([^"'\s]+)/.exec(line)

		if (!match) continue

		// A versioned corpus path has the version as the segment after `versioned`.
		const segments = match[1]!.split("/").filter((segment) => segment.length)
		const versioned = segments.indexOf("versioned")

		if (versioned !== -1 && segments[versioned + 1]) return segments[versioned + 1]!.replace(/^v/, "")

		return segments.at(-1)?.replace(/^corpus-v?/, "") ?? null
	}

	return null
}

/**
 * Reads the countries with a positive weight in a training config's `country_weights`.
 *
 * The reader scans lines instead of parsing YAML because YAML 1.1 coerces the key `no` to a boolean.
 *
 * @throws If the config file is missing.
 */
export async function readAdmittedCountries(configPath: PathBuilderLike): Promise<Set<string>> {
	if (!(await pathExists(configPath))) {
		throw new Error(
			`no training config at ${configPath}. Admission is read from that file's \`country_weights\`, so an ` +
				"unreadable config has no admitted set — it is not a config admitting nothing."
		)
	}

	const admitted = new Set<string>()
	let inBlock = false

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded and sync by interface
	for (const rawLine of (await readLocalTextFile(configPath)).split("\n")) {
		const line = rawLine.replace(/\s#.*$/u, "")

		if (/^\s*country_weights:\s*$/.test(line)) {
			inBlock = true

			continue
		}

		if (!inBlock) continue

		// A top-level key that's not a country code ends the block.
		if (/^\s{0,2}\S/.test(line) && !/^\s*["']?[A-Za-z]{2}["']?\s*:/.test(line)) break

		// A flow-style mapping writes several `CC: weight` pairs on one line, so every pair on the line is read.
		for (const match of line.matchAll(/["']?\b([A-Za-z]{2})\b["']?\s*:\s*([0-9.eE+-]+)/g)) {
			if (Number(match[2]) > 0) { admitted.add(match[1]!.toUpperCase()) }
		}
	}

	return admitted
}

/**
 * Counts board rows and passing rows per country in the two-letter directories under `casesRoot`.
 */
export async function readBoardCoverage(
	casesRoot: PathBuilderLike
): Promise<Map<string, { rows: number; passed: number }>> {
	const out = new Map<string, { rows: number; passed: number }>()

	if (!(await pathExists(casesRoot))) return out

	for await (const dir of Globerator.from("*", { cwd: casesRoot, onlyFiles: false })) {
		if (!/^[a-z]{2}$/.test(dir)) continue

		const dirPath = resolvePathBuilder(casesRoot, dir)

		if (!(await isDirectory(dirPath))) continue

		for await (const file of Globerator.files("jsonl", { cwd: dirPath, recursive: false })) {
			// Malformed lines are skipped.
			for await (const line of TextSpliterator.fromAsync(dirPath(file))) {
				const row = tryParsingJSON<{ country?: string; status?: string }>(line)

				if (!row) continue

				const country = String(row.country ?? dir).toUpperCase()
				const entry = out.get(country) ?? { rows: 0, passed: 0 }

				entry.rows++

				if (row.status === "pass") {
					entry.passed++
				}

				out.set(country, entry)
			}
		}
	}

	return out
}

/**
 * Counts admin places per country in the serving gazetteer.
 *
 * Returns an empty map when the gazetteer is missing or unreadable.
 */
export async function readGazetteerCoverage(dbPath: PathBuilderLike): Promise<Map<string, number>> {
	const out = new Map<string, number>()

	if (!(await pathExists(dbPath))) return out

	try {
		using db = new DatabaseClient<CandidateDatabase>(dbPath, { readOnly: true })

		const tables = allRows<{ name: string }>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'"))
		const names = new Set(tables.map((t) => t.name))

		// The query supports both the candidate schema and the legacy `spr` schema.
		const sql = names.has("candidate")
			? "SELECT c.code AS cc, COUNT(*) AS n FROM candidate x JOIN country_codes c ON c.id = x.country_id GROUP BY c.code"
			: "SELECT country AS cc, COUNT(*) AS n FROM spr GROUP BY country"

		for (const row of allRows<{ cc: string | null; n: number }>(db.prepare(sql))) {
			if (row.cc) {
				out.set(row.cc.toUpperCase(), row.n)
			}
		}
	} catch {
		// An unreadable gazetteer counts as unavailable.
	}

	return out
}

/**
 * Lists the countries whose rooftop address points are published to consumers.
 */
export const ROOFTOP_PUBLISHED = new Set(["US", "FR"])

/**
 * Lists the countries whose rooftop address points a user must build locally, such as AU from G-NAF.
 */
export const ROOFTOP_BUILD_LOCAL = new Set(["AU"])

/**
 * Records how the training config was selected.
 */
export const ConfigProvenance = {
	/**
	 * The caller passed the file.
	 */
	Given: "given",
	/**
	 * `scope.config.json` records the file for a weights family's shipped graph.
	 */
	Registered: "registered",
} as const

/**
 * Records how the training config was selected.
 */
export type ConfigProvenance = (typeof ConfigProvenance)[keyof typeof ConfigProvenance]

/**
 * Holds a resolved training config path and how it was selected.
 */
export interface ResolvedTrainingConfig {
	path: string
	provenance: ConfigProvenance
	/**
	 * Holds the weights family whose shipped graph this config produced, for a registered config.
	 */
	family?: string
}

/**
 * Resolves the requested training config, or else the registered config for a weights family.
 *
 * The family defaults to `DEFAULT_ADMISSION_FAMILY`.
 */
export function resolveTrainingConfig(
	scope: ScopeConfig,
	options: { requested?: string | undefined; family?: string } = {}
): ResolvedTrainingConfig {
	if (options.requested) {
		return { path: options.requested, provenance: ConfigProvenance.Given }
	}

	const family = options.family ?? DEFAULT_ADMISSION_FAMILY
	const registered = shippedTrainingConfig(scope, family)

	return {
		path: repoRootPath(...registered.config.split("/")),
		provenance: ConfigProvenance.Registered,
		family,
	}
}

/**
 * Sets the weights family whose config answers an admission question when the caller gives no family.
 *
 * The Latin family is the default because its `country_weights` covers every
 * country that the character family doesn't train.
 */
export const DEFAULT_ADMISSION_FAMILY = "en-us"

/**
 * Maps each country admitted by a shipped graph's training config to the families that admit it.
 *
 * Admission is per graph, so the result is the union across all shipped graphs.
 */
export async function admittedByShippedGraphs(scope: ScopeConfig): Promise<Map<string, string[]>> {
	const byCountry = new Map<string, string[]>()

	for (const entry of shippedTrainingConfigs(scope)) {
		const admitted = await readAdmittedCountries(repoRootPath(...entry.config.split("/")))

		for (const country of admitted) {
			byCountry.set(country, [...(byCountry.get(country) ?? []), entry.family])
		}
	}

	return byCountry
}

/**
 * Returns the newest corpus manifest by modification time, or an empty string when none exists.
 *
 * Version directory names such as `v0.9.9-…`, `v0.26.0-…` and `v8-…` sort correctly
 * neither lexically nor numerically, so the name cannot order them.
 *
 * @throws If two manifests share the newest mtime, as a fresh checkout or bulk copy produces.
 * The caller must then pass the manifest explicitly.
 */
export async function newestManifest(): Promise<string> {
	const root = dataRootPath("corpus", "versioned")

	if (!(await pathExists(root))) return ""

	const found: Array<{ path: string; at: number }> = []

	for await (const candidate of Globerator.from("*/*/MANIFEST.json", { cwd: root, absolute: true })) {
		found.push({ path: candidate, at: (await statPath(candidate)).mtimeMs })
	}

	const ordered = found.toSorted((a, b) => b.at - a.at)
	const newest = ordered[0]

	if (!newest) return ""

	const tied = ordered.filter((candidate) => candidate.at === newest.at)

	if (tied.length > 1) {
		throw new Error(
			`${tied.length} corpus manifests share the newest modification time (${new Date(newest.at).toISOString()}), ` +
				`so which corpus is newest is undecidable here: ${tied.map((candidate) => candidate.path).join(", ")}. ` +
				"Pass the manifest to census rather than letting this choose one."
		)
	}

	return newest.path
}

/**
 * Runs {@linkcode censusCoverage} on this repository's inputs: the registered config (or `requested`),
 * the newest corpus manifest, every shipped graph's config, and the gauntlet cases tree.
 *
 * The coverage page and the `grouping-coverage` health check both read their
 * report through this, so they read the same corpora.
 */
export async function repositoryCoverageReport(
	options: { requested?: string | undefined; refresh?: boolean; countWhenUncached?: boolean } = {}
): Promise<CoverageReport> {
	const scope = await readScopeConfig()

	return censusCoverage({
		configPath: resolveTrainingConfig(scope, { requested: options.requested }).path,
		manifestPath: await newestManifest(),
		graphConfigs: shippedTrainingConfigs(scope).map((entry) => ({
			family: entry.family,
			path: repoRootPath(...entry.config.split("/")).toString(),
		})),
		casesRoot: repoRootPath("packages", "mailwoman", "tools", "eval-harness", "gauntlet", "cases"),
		refresh: options.refresh ?? false,
		countWhenUncached: options.countWhenUncached ?? true,
	})
}

/**
 * Configures `censusCoverage`.
 */
export interface CensusCoverageOptions {
	/**
	 * Sets the training config whose `country_weights` decides admission.
	 */
	configPath: string
	/**
	 * Sets the corpus `MANIFEST.json` to count.
	 *
	 * The census reads it only when the cache is missing or `refresh` is set.
	 */
	manifestPath: string
	/**
	 * Sets the root of the gauntlet cases tree.
	 */
	casesRoot: PathBuilderLike
	/**
	 * Sets the serving gazetteer.
	 *
	 * @defaultValue the data root's `wof/candidate.db`.
	 */
	gazetteerPath?: string
	/**
	 * Recounts the corpus instead of reading the cache.
	 * This takes minutes.
	 */
	refresh?: boolean
	/**
	 * The shipped graphs' training configs.
	 *
	 * The census also counts the corpus of each one whose `data.label_set` isn't the default
	 * label set, because that graph trains on its own corpus rather than on `manifestPath`'s.
	 */
	graphConfigs?: ReadonlyArray<{ family: string; path: string }>
	/**
	 * Counts a corpus whose cached census is absent or predates a field the report reads.
	 *
	 * With `false` such a corpus throws, naming the cache, so a caller that must stay fast
	 * never starts a count of minutes and never reads a missing count as zero.
	 *
	 * @defaultValue true
	 */
	countWhenUncached?: boolean
	/**
	 * Receives each stage, including every corpus count and why its cache couldn't serve.
	 *
	 * @defaultValue a reporter that drops every step
	 */
	progress?: (step: ProcessProgress) => void
}

/**
 * One graph corpus the census counted beside the main corpus.
 */
export interface GraphCorpusReading {
	family: string
	labelSet: string
	corpusVersion: string
	manifest: string
	/**
	 * The cached census timestamp, or `null` when the corpus was recounted in this run.
	 */
	takenAt: string | null
}

/**
 * Returns the path of the cached census of one graph's own corpus.
 */
export function graphCorpusCensusPath(family: string): PathBuilder {
	return dataRootPath("corpus", "coverage-census", `${family}.json`)
}

/**
 * Reads the cached census at `cachePath` when it holds every field the report reads and,
 * with `matchManifest`, counts `manifestPath`; otherwise counts the corpus.
 *
 * The main census leaves `matchManifest` off because its manifest is the newest one on the data root.
 * A later corpus build moves that manifest without invalidating the count already taken.
 *
 * @throws When the cache can't serve and `countWhenUncached` is false.
 */
async function readOrCountCensus(
	cachePath: PathBuilder,
	manifestPath: string,
	options: {
		refresh: boolean
		countWhenUncached: boolean
		matchManifest: boolean
		label: string
		progress: (step: ProcessProgress) => void
	}
): Promise<{ census: CorpusCensus; takenAt: string | null }> {
	const cached = !options.refresh && (await pathExists(cachePath)) ? await readLocalJSONFile<CorpusCensus>(cachePath) : null

	const stale = !cached
		? "absent"
		: !cached.addressFormRows
			? "written before the census counted address-form rows"
			: options.matchManifest && cached.manifest !== manifestPath
				? `a census of ${cached.manifest}`
				: null

	if (cached && !stale) return { census: cached, takenAt: cached.takenAt }

	if (!options.countWhenUncached && !options.refresh) {
		throw new Error(
			`The corpus census at ${cachePath} is ${stale}, and this caller doesn't count a corpus. Run ` +
				"`node packages/mailwoman/tools/dev-tools/corpus/jurisdiction-coverage.run.ts --refresh` on a host that holds it."
		)
	}

	options.progress({
		stage: `Counting ${options.label} (${options.refresh ? "refresh requested" : `cached census is ${stale}`})`,
	})

	// The census can count several corpora in turn, so each count's stages start with its label.
	const census = await buildCorpusCensus(manifestPath, (step) =>
		options.progress({ ...step, stage: `${options.label}: ${step.stage}` })
	)

	await writeLocalJSONFile(census, cachePath)

	return { census, takenAt: null }
}

/**
 * Combines the coverage sources into one per-country report and lists where they disagree.
 */
export async function censusCoverage(options: CensusCoverageOptions): Promise<CoverageReport> {
	const progress = options.progress ?? (() => {})

	const counting = {
		refresh: options.refresh ?? false,
		countWhenUncached: options.countWhenUncached ?? true,
		progress,
	}

	progress({ stage: "Reading the corpus census" })

	const { census, takenAt } = await readOrCountCensus(corpusCensusPath(), options.manifestPath, {
		...counting,
		matchManifest: false,
		label: "the training corpus",
	})

	const graphCorpora: GraphCorpusReading[] = []
	const addressFormRows = new Map<string, number>(Object.entries(census.addressFormRows))

	for (const graph of options.graphConfigs ?? []) {
		const { data } = await loadTrainingConfig(graph.path)

		if (data.label_set === DEFAULT_LABEL_SET) continue

		const manifest = localManifestFilePath(`${data.corpus_dir}/MANIFEST.json`)

		const counted = await readOrCountCensus(graphCorpusCensusPath(graph.family), manifest, {
			...counting,
			matchManifest: true,
			label: `the ${graph.family} graph corpus`,
		})

		graphCorpora.push({
			family: graph.family,
			labelSet: data.label_set,
			corpusVersion: counted.census.corpusVersion,
			manifest,
			takenAt: counted.takenAt,
		})

		for (const [country, rows] of Object.entries(counted.census.addressFormRows)) {
			addressFormRows.set(country, (addressFormRows.get(country) ?? 0) + rows)
		}
	}

	progress({ stage: "Reading the board, gazetteer and weights coverage" })

	const admitted = await readAdmittedCountries(options.configPath)
	const board = await readBoardCoverage(options.casesRoot)
	const gazetteerPath = options.gazetteerPath ?? wofDatabasePath("candidate.db")
	const gazetteer = await readGazetteerCoverage(gazetteerPath)
	const weightsPackages = weightsPackageByCountry(await readReleaseConfig())

	const all = new Set<string>([
		...Object.keys(census.rows),
		...admitted,
		...board.keys(),
		...gazetteer.keys(),
		...weightsPackages.keys(),
	])

	// Both codes leave the per-country table and are reported under `countryLess`, so the rows
	// behind them are visible without reading as a jurisdiction the register doesn't enumerate.
	const countryLess: CountryLessRows[] = []

	for (const code of COUNTRY_LESS_CODES) {
		all.delete(code)

		const rows = census.rows[code] ?? 0

		if (!rows) continue

		countryLess.push({
			code,
			rows,
			streetRows: census.streetRows[code] ?? 0,
			reading: COUNTRY_LESS_READINGS[code] ?? "a code outside ISO 3166-1 alpha-2",
		})
	}

	const countries: CountryCoverage[] = [...all].toSorted().map((cc) => {
		const boardEntry = board.get(cc)
		const gazetteerPlaces = gazetteer.get(cc) ?? 0

		return {
			country: cc,
			corpusRows: census.rows[cc] ?? 0,
			corpusStreetRows: census.streetRows[cc] ?? 0,
			addressFormRows: addressFormRows.get(cc) ?? 0,
			admitted: admitted.has(cc),
			weightsPackage: weightsPackages.get(cc) ?? null,
			gazetteerPlaces,
			geocodeTier: ROOFTOP_PUBLISHED.has(cc)
				? "rooftop-published"
				: ROOFTOP_BUILD_LOCAL.has(cc)
					? "rooftop-build-local"
					: gazetteerPlaces > 0
						? "locality"
						: "none",
			boardRows: boardEntry?.rows ?? 0,
			boardPassedRows: boardEntry?.passed ?? 0,
		}
	})

	const configuredCorpusVersion = await readConfiguredCorpusVersion(options.configPath)

	// A cached census can count a different corpus than the config trains on.
	// Every row count then describes the wrong corpus, so the report flags it.
	const corpusMismatch =
		configuredCorpusVersion &&
		census.corpusVersion !== "unknown" &&
		!sameCorpusVersion(configuredCorpusVersion, census.corpusVersion)
			? `The census counted corpus ${census.corpusVersion}; the config trains on ${configuredCorpusVersion}. ` +
				"Every row count here is about the corpus that was COUNTED, not the one that trains — a country the " +
				"newer corpus added reads as zero rows. Re-run with refresh, or point at the config whose corpus was " +
				"censused."
			: null

	return {
		countries,
		countryLess,
		mismatches: {
			presentButDropped: countries.filter((c) => c.corpusRows > 0 && !c.admitted).map((c) => c.country),
			admittedButEmpty: countries.filter((c) => c.admitted && c.corpusRows === 0).map((c) => c.country),
			packageWithoutTraining: countries.filter((c) => c.weightsPackage && !trains(c)).map((c) => c.country),
			trainedButUnmeasured: countries.filter((c) => trains(c) && c.boardPassedRows === 0).map((c) => c.country),
			measuredButUntrained: countries.filter((c) => c.boardRows > 0 && !trains(c)).map((c) => c.country),
		},
		corpusVersion: census.corpusVersion,
		configuredCorpusVersion,
		corpusMismatch,
		corpusRowsTotal: census.total,
		corpusCensusTakenAt: takenAt,
		graphCorpora,
		configPath: options.configPath,
		gazetteerPath: gazetteerPath.toString(),
		notes: [
			"A weights package is not training. Only `en-us` ships a model.onnx; the other eight locale packages are " +
				"data-only overlays over it, and every locale resolves the identical weights file.",
			"`country_weights` is a HARD admission filter (data_loader.py: `weight is None -> continue`). A country " +
				"absent from it trains on nothing regardless of how many corpus rows exist — the Norway bug's mechanism.",
			"Rooftop geocoding is `published` for US and FR only. `data-bundles.ts` has four entries and every other " +
				"rooftop database is ODbL build-local, which looks identical from inside the repo and is unobtainable outside it.",
			"A board row that is not `status: pass` tracks rather than checks, so `boardPassedRows: 0` means nothing about " +
				"that country is verified.",
		],
	}
}
