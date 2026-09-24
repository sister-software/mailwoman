/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report country coverage across five independent sources: weights package, training rows, training admission,
 *   gazetteer availability, and passing board cases. Keep parsing and geocoding distinct and report mismatches.
 *
 *   Corpus counts require scanning training parquet files, so cache them under the data root and recount only on
 *   request. Reports include the cache timestamp and identify when corpus and training-config versions differ.
 */

import {
	isDirectory,
	pathExists,
	readLocalJSONFile,
	readLocalTextFile,
	statPath,
} from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { readReleaseConfig, weightsPackageByCountry } from "@mailwoman/core/release-config"
import {
	type ScopeConfig,
	shippedTrainingConfig,
	shippedTrainingConfigs,
} from "@mailwoman/core/scope-config"
import { dataRootPath } from "@mailwoman/core/data-root"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { openParquetRowStream } from "@mailwoman/corpus/parquet/streams"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools"
import { allRows } from "@mailwoman/core/utils"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilder, type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

/**
 * Country geocoding tier, distinguishing consumer-published data from local-only data.
 */
export type GeocodeTier = "rooftop-published" | "rooftop-build-local" | "locality" | "none"

/**
 * Coverage summary for one country.
 */
export interface CountryCoverage {
	country: string
	/**
	 * Training rows across all sources.
	 */
	corpusRows: number
	/**
	 * Rows labeled with a street or house number.
	 */
	corpusStreetRows: number
	/**
	 * Whether `country_weights` admits this country.
	 */
	admitted: boolean
	/**
	 * Locale package, if one ships.
	 */
	weightsPackage?: string
	/**
	 * Admin places in the serving gazetteer.
	 */
	gazetteerPlaces: number
	geocodeTier: GeocodeTier
	/**
	 * Total board rows and passing checks.
	 */
	boardRows: number
	boardPassedRows: number
}

/**
 * A country trains only when admitted and represented in the corpus.
 */
export function trains(c: Pick<CountryCoverage, "admitted" | "corpusRows">): boolean {
	return c.admitted && c.corpusRows > 0
}

/**
 * Mismatch categories across coverage sources.
 */
export interface CoverageMismatches {
	/**
	 * Corpus rows exist, but the training config excludes the country.
	 */
	presentButDropped: string[]
	/**
	 * The config admits the country, but no corpus rows exist.
	 */
	admittedButEmpty: string[]
	/**
	 * A weights package exists, but the country is not trained.
	 */
	packageWithoutTraining: string[]
	/**
	 * The country trains, but no board case passes for it.
	 */
	trainedButUnmeasured: string[]
	/**
	 * Board rows exist for a country that is not trained.
	 */
	measuredButUntrained: string[]
}

export interface CoverageReport {
	countries: CountryCoverage[]
	mismatches: CoverageMismatches
	corpusVersion: string
	/**
	 * Corpus version referenced by the config.
	 */
	configuredCorpusVersion?: string
	/**
	 * Present when the censused corpus differs from the configured corpus.
	 */
	corpusMismatch?: string
	corpusRowsTotal: number
	/**
	 * Cached census timestamp, or `null` when recounted now.
	 */
	corpusCensusTakenAt: string | null
	configPath: string
	gazetteerPath: string
	notes: string[]
}

/**
 * Path to the cached corpus census under the data root.
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
	 * Counts and paths of unreadable train files, so partial totals are identifiable.
	 */
	filesRead: number
	filesListed: number
	unreadableFiles: string[]
}

/**
 * Normalize Arrow list encodings and reject absent or unreadable columns.
 */
export function normalizeArrowListColumn(value: unknown, column: string): string[] {
	const entries = Array.isArray(value)
		? value
		: Array.isArray((value as { list?: unknown })?.list)
			? (value as { list: unknown[] }).list.map((entry) => (entry as { element?: unknown })?.element ?? entry)
			: null

	if (entries?.every((entry): entry is string => typeof entry === "string")) return entries

	throw new Error(
		`Corpus Arrow reader requested ${column}, but the column was absent or unreadable; ` +
			"refusing to report an empty count from a partial row."
	)
}

const STREET_LABEL = /(^|-)street($|_)|house_number/

async function* streamCorpusCensusRows(path: string): AsyncGenerator<Record<string, unknown>> {
	let sawFirst = false
	let projectedLabels = true

	for await (const record of openParquetRowStream<Record<string, unknown>>(path, { columns: ["country", "labels"] })) {
		if (!sawFirst) {
			sawFirst = true

			if (record["labels"] === undefined) {
				projectedLabels = false

				break
			}
		}

		yield record
	}

	if (!projectedLabels) {
		for await (const record of openParquetRowStream<Record<string, unknown>>(path)) { yield record }
	}
}

/**
 * Shared manifest reader supports both current and legacy parquet-list keys
 * and fails on unreadable manifests.
 */
/**
 * Count all training rows and street-labeled rows per country.
 */
export async function buildCorpusCensus(manifestPath: PathBuilderLike): Promise<CorpusCensus> {
	// Include the legacy manifest key so `baseManifestFiles` can read either schema.
	const manifest = await readLocalJSONFile<{ corpus_version?: string; slices?: unknown } & Record<string, unknown>>(
		manifestPath
	)

	const parquetFiles = baseManifestFiles(manifest)
		.filter((file) => file.split === "train" && file.path)
		.map((file) => localManifestFilePath(file.path))

	const rows: Record<string, number> = {}
	const streetRows: Record<string, number> = {}
	const unreadableFiles: string[] = []
	let total = 0
	let filesRead = 0

	for (const path of parquetFiles) {
		try {
			for await (const record of streamCorpusCensusRows(path)) {
				total++

				const country = String(record["country"] ?? "").toUpperCase() || "??"

				rows[country] = (rows[country] ?? 0) + 1

				if (normalizeArrowListColumn(record["labels"], "labels").some((label) => STREET_LABEL.test(String(label)))) {
					streetRows[country] = (streetRows[country] ?? 0) + 1
				}
			}

			filesRead++
		} catch {
			unreadableFiles.push(path)
		}
	}

	// If train files are listed but none are read, report a read failure instead of a false zero.
	if (parquetFiles.length && total === 0) {
		throw new Error(
			`Corpus census read 0 rows from ${parquetFiles.length} train file(s) listed by ${manifestPath}, ` +
				`${unreadableFiles.length} of them unreadable` +
				(unreadableFiles[0] ? ` (first: ${unreadableFiles[0]})` : "") +
				". Refusing to report an empty corpus — check MAILWOMAN_DATA_ROOT and the manifest's paths."
		)
	}

	return {
		takenAt: new Date().toISOString(),
		corpusVersion: manifest.corpus_version ?? "unknown",
		manifest: manifestPath.toString(),
		total,
		rows,
		streetRows,
		filesRead,
		filesListed: parquetFiles.length,
		unreadableFiles,
	}
}

/**
 * Compare corpus versions after removing an optional leading `v`.
 */
export function sameCorpusVersion(a: string, b: string): boolean {
	const bare = (version: string): string => version.trim().replace(/^v/, "")

	return bare(a) === bare(b)
}

/**
 * Read the corpus version from `corpus_dir`, or return `undefined` when the config has none.
 */
export async function readConfiguredCorpusVersion(configPath: PathBuilderLike): Promise<string | undefined> {
	if (!(await pathExists(configPath))) return undefined

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a training config is a few hundred lines, read sync
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		const match = /^\s*corpus_dir:\s*["']?([^"'\s]+)/.exec(line)

		if (!match) continue

		// Versioned corpus paths include the version as a directory segment.
		const segments = match[1]!.split("/").filter((segment) => segment.length)
		const versioned = segments.indexOf("versioned")

		if (versioned !== -1 && segments[versioned + 1]) return segments[versioned + 1]!.replace(/^v/, "")

		return segments.at(-1)?.replace(/^corpus-v?/, "")
	}

	return undefined
}

/**
 * Read `country_weights` without YAML coercion, preserving two-letter keys such as `no` as strings.
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

	// Scan the small config directly to avoid YAML 1.1 coercing the country code `no` to boolean.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and sync by interface
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		if (/^\s*country_weights:\s*$/.test(line)) {
			inBlock = true

			continue
		}

		if (!inBlock) continue

		// Stop when the country_weights block ends.
		if (/^\s{0,2}\S/.test(line) && !/^\s*["']?[A-Za-z]{2}["']?\s*:/.test(line)) break

		const match = /^\s*["']?([A-Za-z]{2})["']?\s*:\s*([0-9.eE+-]+)/.exec(line)

		if (match && Number(match[2]) > 0) {
			admitted.add(match[1]!.toUpperCase())
		}
	}

	return admitted
}

/**
 * Count board rows and passing cases in the loader's two-letter country directories.
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

			// Skip malformed fixture lines and continue counting.
			for await (const line of TextSpliterator.fromAsync(dirPath(file))) {
				if (!line.trim()) continue

				const row = tryParsingJSON<{ country?: string; status?: string }>(line)

				if (row === null) continue

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
 * Count admin places per country in the serving gazetteer.
 */
export async function readGazetteerCoverage(dbPath: PathBuilderLike): Promise<Map<string, number>> {
	const out = new Map<string, number>()

	if (!(await pathExists(dbPath))) return out

	try {
		using db = new DatabaseClient<CandidateDatabase>(dbPath, { readOnly: true })

		const tables = allRows<{ name: string }>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'"))
		const names = new Set(tables.map((t) => t.name))

		// Support both candidate and legacy admin schemas.
		const sql = names.has("candidate")
			? "SELECT c.code AS cc, COUNT(*) AS n FROM candidate x JOIN country_codes c ON c.id = x.country_id GROUP BY c.code"
			: "SELECT country AS cc, COUNT(*) AS n FROM spr GROUP BY country"

		for (const row of allRows<{ cc: string | null; n: number }>(db.prepare(sql))) {
			if (row.cc) {
				out.set(row.cc.toUpperCase(), row.n)
			}
		}
	} catch {
		// Treat an unreadable gazetteer as unavailable.
	}

	return out
}

/**
 * Countries with consumer-published rooftop address points.
 */
export const ROOFTOP_PUBLISHED = new Set(["US", "FR"])

/**
 * How the training config was selected.
 */
export const ConfigProvenance = {
	/**
	 * The caller named the file.
	 */
	Given: "given",
	/**
	 * The file is the one `scope.config.json` records for a weights family's shipped graph.
	 */
	Registered: "registered",
} as const

export type ConfigProvenance = (typeof ConfigProvenance)[keyof typeof ConfigProvenance]

/**
 * Resolved training config and its source.
 */
export interface ResolvedTrainingConfig {
	path: string
	provenance: ConfigProvenance
	/**
	 * The weights family whose shipped graph this config produced, when the register named it.
	 */
	family?: string
}

/**
 * Resolve the requested config or the registered config for a weights family.
 *
 * Defaults to the Latin family and records whether the path was caller-supplied or registered.
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
 * The weights family whose config answers an admission question that names no family.
 *
 * The Latin family, because its `country_weights` covers every country outside
 * the four the character family trains.
 * The choice is recorded rather than implied: reading the character config by default
 * would report 4 admitted countries for a repository whose shipped Latin graph admits 25.
 */
export const DEFAULT_ADMISSION_FAMILY = "en-us"

/**
 * Every country some shipped graph's training config admits, and which family admitted it.
 *
 * The union, because admission is per graph and the two graphs partition the world between them.
 * A country in neither map trains nothing that ships today, whatever the in-flight configs promise.
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
 * The newest corpus manifest, by modification time.
 *
 * The directory name cannot order these.
 * Corpus versions are `v0.9.9-si-bare-village`, `v0.26.0-trailing-region-leftcontext`,
 * `v8-jp-full-…` — a set that sorts neither lexically (`v0.9.9` beats `v0.26.0`, because `9` > `2`)
 * nor numerically (`v8` beats both).
 *
 * Measured: the name sort picked `v0.9.9` and reported the coverage of a corpus nine
 * versions old, with nothing in the output to say it had.
 * Every caller names the manifest it used.
 *
 * Two manifests sharing the newest mtime raise rather than one of them being returned.
 * An mtime tie is what a fresh checkout or a bulk copy produces, and the sibling `newestConfig` picked
 * one of 225 configs that way and reported another arm's numbers under this arm's name (#2349).
 * The caller that hits this passes the manifest it means.
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


export interface CensusCoverageOptions {
	/**
	 * Training config whose `country_weights` decides admission.
	 */
	configPath: string
	/**
	 * Corpus manifest.json to census.
	 *
	 * Only read when the cache is missing or `refresh` is set.
	 */
	manifestPath: string
	/**
	 * The gauntlet cases tree.
	 */
	casesRoot: PathBuilderLike
	/**
	 * Serving gazetteer.
	 *
	 * Defaults to the data root's `wof/candidate.db`.
	 */
	gazetteerPath?: string
	/**
	 * Recount the corpus rather than reading the cache.
	 *
	 * Costs minutes.
	 */
	refresh?: boolean
}

/**
 * Assemble the five registers into one per-country report, and name where they disagree.
 */
export async function censusCoverage(options: CensusCoverageOptions): Promise<CoverageReport> {
	const cachePath = corpusCensusPath()
	let census: CorpusCensus
	let takenAt: string | null

	if (!options.refresh && (await pathExists(cachePath))) {
		census = await readLocalJSONFile<CorpusCensus>(cachePath)
		takenAt = census.takenAt
	} else {
		census = await buildCorpusCensus(options.manifestPath)
		await writeLocalJSONFile(census, cachePath)
		takenAt = null
	}

	const admitted = await readAdmittedCountries(options.configPath)
	const board = await readBoardCoverage(options.casesRoot)
	const gazetteerPath = options.gazetteerPath ?? wofDatabasePath("candidate.db")
	const gazetteer = await readGazetteerCoverage(gazetteerPath)
	// derived from `release.config.json` rather than restated here.
	// This was a hand-written eleven-entry table, and `repo-health`'s `locale-tables`
	// check exists because it was a second copy of the config's two lists.
	// The check still holds every other country→locale table against the config,
	// and this one can no longer disagree with it.
	const weightsPackages = weightsPackageByCountry(await readReleaseConfig())

	const all = new Set<string>([
		...Object.keys(census.rows),
		...admitted,
		...board.keys(),
		...gazetteer.keys(),
		...weightsPackages.keys(),
	])

	all.delete("??")
	// The unknown-country placeholder is not a country and is correctly dropped by the loader.
	all.delete("ZZ")

	const countries: CountryCoverage[] = [...all].toSorted().map((cc) => {
		const boardEntry = board.get(cc)
		const gazetteerPlaces = gazetteer.get(cc) ?? 0

		return {
			country: cc,
			corpusRows: census.rows[cc] ?? 0,
			corpusStreetRows: census.streetRows[cc] ?? 0,
			admitted: admitted.has(cc),
			...(weightsPackages.has(cc) ? { weightsPackage: weightsPackages.get(cc) } : {}),
			gazetteerPlaces,
			geocodeTier: ROOFTOP_PUBLISHED.has(cc) ? "rooftop-published" : gazetteerPlaces > 0 ? "locality" : "none",
			boardRows: boardEntry?.rows ?? 0,
			boardPassedRows: boardEntry?.passed ?? 0,
		}
	})

	const configuredCorpusVersion = await readConfiguredCorpusVersion(options.configPath)

	// A cached census and a config are two artifacts that both look authoritative
	// and were never made to agree.
	// When they name different corpora every row count below is about the wrong corpus,
	// and reads as a real absence.
	const corpusMismatch =
		configuredCorpusVersion &&
		census.corpusVersion !== "unknown" &&
		!sameCorpusVersion(configuredCorpusVersion, census.corpusVersion)
			? `The census counted corpus ${census.corpusVersion}; the config trains on ${configuredCorpusVersion}. ` +
				"Every row count here is about the corpus that was COUNTED, not the one that trains — a country the " +
				"newer corpus added reads as zero rows. Re-run with refresh, or point at the config whose corpus was " +
				"censused."
			: undefined

	return {
		countries,
		mismatches: {
			presentButDropped: countries.filter((c) => c.corpusRows > 0 && !c.admitted).map((c) => c.country),
			admittedButEmpty: countries.filter((c) => c.admitted && c.corpusRows === 0).map((c) => c.country),
			packageWithoutTraining: countries.filter((c) => c.weightsPackage && !trains(c)).map((c) => c.country),
			trainedButUnmeasured: countries.filter((c) => trains(c) && c.boardPassedRows === 0).map((c) => c.country),
			measuredButUntrained: countries.filter((c) => c.boardRows > 0 && !trains(c)).map((c) => c.country),
		},
		corpusVersion: census.corpusVersion,
		configuredCorpusVersion,
		...(corpusMismatch ? { corpusMismatch } : {}),
		corpusRowsTotal: census.total,
		corpusCensusTakenAt: takenAt,
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
