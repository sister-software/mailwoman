/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Reports per-country coverage across the corpus, training admission, weights packages, gazetteer and board.
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
	 * Reports whether `country_weights` admits this country.
	 */
	admitted: boolean
	/**
	 * Holds the locale package name when one ships.
	 */
	weightsPackage?: string
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
 * Reports whether a country trains, which requires admission and at least one corpus row.
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
 * Holds the full coverage report that `censusCoverage` returns.
 */
export interface CoverageReport {
	countries: CountryCoverage[]
	mismatches: CoverageMismatches
	corpusVersion: string
	/**
	 * Holds the corpus version that the training config references.
	 */
	configuredCorpusVersion?: string
	/**
	 * Explains the mismatch when the counted corpus differs from the configured corpus.
	 */
	corpusMismatch?: string
	corpusRowsTotal: number
	/**
	 * Holds the cached census timestamp, or `null` when the corpus was recounted in this run.
	 */
	corpusCensusTakenAt: string | null
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
	 * These file counts and unreadable paths show when a total covers only part of the corpus.
	 */
	filesRead: number
	filesListed: number
	unreadableFiles: string[]
}

/**
 * Flattens an Arrow list column to a string array.
 *
 * @throws If the column is absent or holds non-string entries, so a partial row never counts as empty.
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
 * Counts train-split rows and street-labeled rows per country.
 *
 * @throws If the manifest lists train files but no row could be read.
 */
export async function buildCorpusCensus(manifestPath: PathBuilderLike): Promise<CorpusCensus> {
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
 * Compares two corpus versions, ignoring an optional leading `v`.
 */
export function sameCorpusVersion(a: string, b: string): boolean {
	const bare = (version: string): string => version.trim().replace(/^v/, "")

	return bare(a) === bare(b)
}

/**
 * Reads the corpus version from a training config's `corpus_dir`.
 *
 * Returns `undefined` when the config is missing or has no `corpus_dir`.
 */
export async function readConfiguredCorpusVersion(configPath: PathBuilderLike): Promise<string | undefined> {
	if (!(await pathExists(configPath))) return undefined

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a training config is a few hundred lines, read sync
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		const match = /^\s*corpus_dir:\s*["']?([^"'\s]+)/.exec(line)

		if (!match) continue

		// A versioned corpus path has the version as the segment after `versioned`.
		const segments = match[1]!.split("/").filter((segment) => segment.length)
		const versioned = segments.indexOf("versioned")

		if (versioned !== -1 && segments[versioned + 1]) return segments[versioned + 1]!.replace(/^v/, "")

		return segments.at(-1)?.replace(/^corpus-v?/, "")
	}

	return undefined
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

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and sync by interface
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		if (/^\s*country_weights:\s*$/.test(line)) {
			inBlock = true

			continue
		}

		if (!inBlock) continue

		// A top-level key that is not a country code ends the block.
		if (/^\s{0,2}\S/.test(line) && !/^\s*["']?[A-Za-z]{2}["']?\s*:/.test(line)) break

		const match = /^\s*["']?([A-Za-z]{2})["']?\s*:\s*([0-9.eE+-]+)/.exec(line)

		if (match && Number(match[2]) > 0) {
			admitted.add(match[1]!.toUpperCase())
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
 * country that the character family does not train.
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
	 * Sets the serving gazetteer, which defaults to the data root's `wof/candidate.db`.
	 */
	gazetteerPath?: string
	/**
	 * Recounts the corpus instead of reading the cache, which takes minutes.
	 */
	refresh?: boolean
}

/**
 * Combines the coverage sources into one per-country report and lists where they disagree.
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
	const weightsPackages = weightsPackageByCountry(await readReleaseConfig())

	const all = new Set<string>([
		...Object.keys(census.rows),
		...admitted,
		...board.keys(),
		...gazetteer.keys(),
		...weightsPackages.keys(),
	])

	// `??` marks a row with no country, and the loader drops the `ZZ` placeholder.
	all.delete("??")
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
