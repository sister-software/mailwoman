/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   what can mailwoman do, PER country — parse and geocode kept apart, from primary sources.
 *
 *   This exists because establishing it by hand took a full session and produced four wrong answers on the way. The
 *   question sounds like one question and is five, held in five places that do not agree:
 *
 *   1. **A weights package exists** — `@mailwoman/neural-weights-<locale>`. Says nothing about training: only `en-us`
 *      ships a `model.onnx` at all, the other eight are data-only overlays over it, and `en-nz` / `en-in` ship for
 *      locales the shipped model has never seen a training row from.
 *   2. **The corpus holds rows** — but a country can hold 11 million rows and none of them a street.
 *   3. **The training config admits the country** — `country_weights` is a hard filter (`data_loader.py`: `weight is
 *      None -> continue`), so a country absent from it trains on nothing no matter how many rows exist. That is the
 *      Norway bug's mechanism, and it was still live for every country outside the map.
 *   4. **The gazetteer can resolve it** — 244 countries, which is a different and much wider set than the parser's.
 *   5. **The board measures it** — and a country with rows that are all `improvement_target` has nothing verified.
 *
 *   Conflating any two of those produces a confident wrong answer, which is why the report keeps them in separate
 *   columns and names the mismatches explicitly rather than leaving them to be noticed.
 *
 *   ## The corpus census is cached, and says when it was taken
 *
 *   Counting rows means reading every train parquet file. Measured on 681M rows across 705 files: ~6 minutes projecting
 *   `country` alone, and ~19 minutes once `labels` comes too — and `labels` cannot be dropped, because the street count
 *   is the column that separates "we taught this country's addresses" from "we taught its name". Exact and far too slow
 *   for a tool call, so it is cached to the data root and refreshed on request. A stale cache is reported with its age
 *   rather than silently served as current.
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
import { openParquetRowStream } from "@mailwoman/corpus/parquet/streams"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools"
import { allRows } from "@mailwoman/core/utils"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join, type PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

/**
 * How well a country can be geocoded, in the three tiers the resolution ladder actually has.
 *
 * `published` means a consumer can get it with `mailwoman data pull`.
 * `build-local` means the artifact exists on a lab machine and cannot be shipped — ODbL sources,
 * mostly — which reads identically to `published` from inside the repo and not at all from outside it.
 */
export type GeocodeTier = "rooftop-published" | "rooftop-build-local" | "locality" | "none"

/**
 * One country's row.
 */
export interface CountryCoverage {
	country: string
	/**
	 * Rows in the training corpus, all sources.
	 */
	corpusRows: number
	/**
	 * Of those, rows carrying a `street` or `house_number` label.
	 * The ones that teach an address rather than a name.
	 */
	corpusStreetRows: number
	/**
	 * Whether the training config's `country_weights` admits it.
	 *
	 * A false here means the rows train nothing.
	 */
	admitted: boolean
	/**
	 * The locale package serving it, if one ships.
	 *
	 * Existence is not training — see the file header.
	 */
	weightsPackage?: string
	/**
	 * Admin places in the serving gazetteer.
	 */
	gazetteerPlaces: number
	geocodeTier: GeocodeTier
	/**
	 * Board rows, and how many of them check rather than merely track.
	 */
	boardRows: number
	boardPassedRows: number
}

/**
 * Whether a country actually trains: admitted by `country_weights` and holding corpus rows.
 *
 * The Norway-bug predicate, shared with `mailwoman data coverage`'s renderer
 * so the two reports cannot disagree about what "trained" means.
 */
export function trains(c: Pick<CountryCoverage, "admitted" | "corpusRows">): boolean {
	return c.admitted && c.corpusRows > 0
}

/**
 * The four ways the five registers disagree.
 *
 * Each one is a real defect class that has shipped at least once.
 */
export interface CoverageMismatches {
	/**
	 * Rows in the corpus rather than admitted by `country_weights` — trains on nothing.
	 *
	 * The Norway shape.
	 */
	presentButDropped: string[]
	/**
	 * Admitted by `country_weights`, no corpus rows — the config promises a locale it cannot deliver.
	 */
	admittedButEmpty: string[]
	/**
	 * A published weights package exists for a country the model was never trained on.
	 */
	packageWithoutTraining: string[]
	/**
	 * Trained (admitted, with rows) but no board row checks it.
	 * A locale nothing would catch regressing.
	 */
	trainedButUnmeasured: string[]
	/**
	 * Board rows exist but the country trains on nothing.
	 * Measured against a capability we never taught.
	 */
	measuredButUntrained: string[]
}

export interface CoverageReport {
	countries: CountryCoverage[]
	mismatches: CoverageMismatches
	corpusVersion: string
	/**
	 * The corpus version the config points at, which is not always the one the census counted.
	 */
	configuredCorpusVersion?: string
	/**
	 * Set when the censused corpus and the configured corpus differ.
	 *
	 * Its presence means every row count in this report is about a corpus the run
	 * does not read, so a zero is not evidence of absence.
	 */
	corpusMismatch?: string
	corpusRowsTotal: number
	/**
	 * ISO timestamp the cached corpus census was taken, or `null` when it was computed in this call.
	 */
	corpusCensusTakenAt: string | null
	configPath: string
	gazetteerPath: string
	notes: string[]
}

/**
 * Where the cached corpus census lives.
 *
 * Under the data root rather than the repo: it describes a build artifact
 * rather than source, and it is regenerated rather than edited.
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
	 * Train files the manifest listed that this count could not read, and how many it did read.
	 *
	 * A census that skipped a file still answers a number, and that number is a floor rather than the corpus.
	 * Carrying both counts is what lets a reader tell a country with no rows from a
	 * country whose rows were in a file nobody opened.
	 */
	filesRead: number
	filesListed: number
	unreadableFiles: string[]
}

/**
 * Arrow list columns arrive as `{list:[{element:v}]}`.
 *
 * Reading one as a plain array yields nothing and every label-based count comes back zero —
 * a false negative that looks exactly like a real absence.
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
 * The manifest's parquet-file list, under whichever key the manifest on disk writes.
 *
 * The key is a string interface with every corpus ever built, so it is read and never renamed.
 * Both spellings are live: of the 41 manifests under `$MAILWOMAN_DATA_ROOT/corpus/versioned`,
 * 8 write `slices` and 33 write the pre-rename key.
 *
 * A reader that knows only one of them finds no files, counts no rows, and reports
 * every country as untrained — an absence indistinguishable from the real thing,
 * and the shape this census exists to catch.
 * `manifest_files` in `mailwoman_train/data/loader/corpus_files.py` is the same fallback on the Python side.
 */
// The file list was read here by a private copy of `baseManifestFiles`, which differed
// from it in the one way that matters: the copy answered an empty list for a manifest
// shape it did not recognize, and this census then reported 0 rows for every country.
// That is the reading `docs/engineering/reference/the-meaning-of-zero.mdx` exists
// to refuse, in the reader whose whole job is coverage.
// The shared one raises and names the cause.

/**
 * Count every train row in the corpus, per country, and how many carry a street span.
 *
 * Exact rather than sampled: parquet files are grouped by source, so a stride over them
 * reads a handful of families and reports their countries as the corpus's.
 * Column projection keeps the full read affordable.
 */
export async function buildCorpusCensus(manifestPath: string): Promise<CorpusCensus> {
	// `slices` is named here so `baseManifestFiles` accepts the parsed object.
	// It reads the pre-rename key off the same object at runtime, and that key's spelling
	// stays in the corpus package because the word is banned in this tree.
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

	// A manifest that lists train files and a count of zero cannot both be true,
	// so the count is the instrument failing.
	// Answering zero here writes "every country trains on nothing" over a cache that held
	// the real numbers, and the reading it produces is the one this census exists to catch.
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
		manifest: manifestPath,
		total,
		rows,
		streetRows,
		filesRead,
		filesListed: parquetFiles.length,
		unreadableFiles,
	}
}

/**
 * Whether two corpus-version strings name the same corpus.
 *
 * The two sides are written differently by construction: a manifest's `corpus_version`
 * carries the `v` prefix the directory does (`v0.31.0-region-code-and-unit`),
 * and {@linkcode readConfiguredCorpusVersion} strips it.
 * Comparing the raw strings declares a mismatch on every correct pairing, and a warning that
 * fires when nothing is wrong stops being read, which costs the reading it exists to give.
 */
export function sameCorpusVersion(a: string, b: string): boolean {
	const bare = (version: string): string => version.trim().replace(/^v/, "")

	return bare(a) === bare(b)
}

/**
 * The corpus version the training config points at, from its `corpus_dir`.
 *
 * This exists so a cached census can be checked against the corpus the run actually reads.
 * The two are separate artifacts that both look authoritative: the census names the corpus
 * it counted, the config names the corpus it trains on, and nothing made them agree.
 *
 * A census of `0.26.0` answering a question about a `0.27.0` run reports a country's
 * rows as zero when the newer corpus added them.
 * An absence indistinguishable from the real thing, which is the failure this whole file exists to prevent.
 *
 * @returns undefined when the config states no corpus_dir.
 * That is "cannot check", not "they match".
 */
export async function readConfiguredCorpusVersion(configPath: string): Promise<string | undefined> {
	if (!(await pathExists(configPath))) return undefined

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a training config is a few hundred lines, read sync
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		const match = /^\s*corpus_dir:\s*["']?([^"'\s]+)/.exec(line)

		if (!match) continue

		// .../versioned/<version>/corpus-<version> — the directory segment is the version.
		const segments = match[1]!.split("/").filter((segment) => segment.length)
		const versioned = segments.indexOf("versioned")

		if (versioned !== -1 && segments[versioned + 1]) return segments[versioned + 1]!.replace(/^v/, "")

		return segments.at(-1)?.replace(/^corpus-v?/, "")
	}

	return undefined
}

/**
 * Read `country_weights` out of a training config without a YAML dependency.
 *
 * The block is a flat `CC: weight` list, so a line scan is enough, and it preserves the
 * one thing a YAML parser would destroy here: a bare `no` key stays the string `"no"`
 * rather than becoming the boolean `false`.
 * That retyping is the exact bug this file exists partly to surface, so the reader must not reproduce it.
 *
 * @throws when the path names no file.
 * An empty set means the config admits no country, and a caller cannot tell that apart
 * from a config nobody could open once both answer the same value.
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

	// A training config is a few hundred lines, and this reader must stay synchronous: the whole point is to read the
	// block without a YAML parser, so a bare `no` key stays the string it is rather than becoming the boolean YAML 1.1
	// makes of it.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and sync by interface
	for (const line of (await readLocalTextFile(configPath)).split("\n")) {
		if (/^\s*country_weights:\s*$/.test(line)) {
			inBlock = true

			continue
		}

		if (!inBlock) continue

		// Any key at the block's own indent or shallower ends it.
		if (/^\s{0,2}\S/.test(line) && !/^\s*["']?[A-Za-z]{2}["']?\s*:/.test(line)) break

		const match = /^\s*["']?([A-Za-z]{2})["']?\s*:\s*([0-9.eE+-]+)/.exec(line)

		if (match && Number(match[2]) > 0) {
			admitted.add(match[1]!.toUpperCase())
		}
	}

	return admitted
}

/**
 * Board rows per country, and how many of them check.
 *
 * Reads the cases tree the loader reads: two-letter directories only.
 * `generalization/` is excluded by that same filter and holds 279 rows,
 * so a glob over `*\u200B/*.jsonl` overstates the board by 43%.
 */
export async function readBoardCoverage(
	casesRoot: PathBuilderLike
): Promise<Map<string, { rows: number; passed: number }>> {
	const out = new Map<string, { rows: number; passed: number }>()

	if (!(await pathExists(casesRoot))) return out

	for await (const dir of Globerator.from("*", { cwd: casesRoot, onlyFiles: false })) {
		if (!/^[a-z]{2}$/.test(dir)) continue

		const dirPath = join(casesRoot, dir)

		if (!(await isDirectory(dirPath))) continue

		for await (const file of Globerator.files("jsonl", { cwd: dirPath, recursive: false })) {

			// A line that does not parse is skipped rather than failing the census,
			// so a hand-edited fixture never hides the rest of its file.
			for await (const line of TextSpliterator.fromAsync(join(dirPath, file))) {
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
 * Admin places per country in the serving gazetteer.
 */
export async function readGazetteerCoverage(dbPath: PathBuilderLike): Promise<Map<string, number>> {
	const out = new Map<string, number>()

	if (!(await pathExists(dbPath))) return out

	try {
		using db = new DatabaseClient<CandidateDatabase>(dbPath, { readOnly: true })

		const tables = allRows<{ name: string }>(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'"))
		const names = new Set(tables.map((t) => t.name))

		// The serving DB is the candidate table.
		// The older admin build exposes `spr`.
		// Support both rather than hard-coding one, because which is live is expressed in a symlink and changes.
		const sql = names.has("candidate")
			? "SELECT c.code AS cc, COUNT(*) AS n FROM candidate x JOIN country_codes c ON c.id = x.country_id GROUP BY c.code"
			: "SELECT country AS cc, COUNT(*) AS n FROM spr GROUP BY country"

		for (const row of allRows<{ cc: string | null; n: number }>(db.prepare(sql))) {
			if (row.cc) {
				out.set(row.cc.toUpperCase(), row.n)
			}
		}
	} catch {
		// An unreadable gazetteer is a missing column rather than a failed report.
	}

	return out
}

/**
 * Countries whose rooftop address points a consumer can actually obtain.
 *
 * `data-bundles.ts` is the authority and it has four entries — candidate, poi, us, fr.
 * Every other rooftop database on a lab machine is ODbL `build-local` and cannot be shipped,
 * which reads identically to published from inside the repo.
 */
export const ROOFTOP_PUBLISHED = new Set(["US", "FR"])

/**
 * How a report came to read the training config it read.
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
 * A training config a report read, and why that file.
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
 * The training config whose `country_weights` decides admission, resolved from
 * what the caller named or from the register.
 *
 * Discovery does not work here and the register replaced it.
 * Sorting the directory by modification time sorts a total tie, because `git checkout`
 * writes all 225 configs at one timestamp.
 *
 * One run took a config admitting 2 countries and the coverage funnel printed `admitted 2 of 250` (#2349).
 * Sorting by filename fails differently: the version scheme is `v0.9.9-si-bare-village`,
 * `v0.26.0-trailing-region-leftcontext` and `v8-cjk-regs` together,
 * which orders neither lexically nor numerically.
 *
 * Under both sorts the premise is still wrong.
 * Two graphs ship at once from two configs — the Latin config's `country_weights` names
 * 25 countries and the character config's names 4 — so no single file is the newest one.
 *
 * `family` selects among the registered configs and defaults to the Latin family,
 * which is the graph every untiered shipping locale resolves through.
 * Pass `requested` to read any other file. {@linkcode ResolvedTrainingConfig.provenance}
 * then reads `given` or `registered`, so a report can print whether its config
 * was named by a caller or taken from the register.
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
	const gazetteerPath = options.gazetteerPath ?? dataRootPath("db", "wof", "candidate.db")
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
