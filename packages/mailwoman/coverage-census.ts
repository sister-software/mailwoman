/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   WHAT CAN MAILWOMAN DO, PER COUNTRY — parse and geocode kept apart, from primary sources.
 *
 *   This exists because establishing it by hand took a full session and produced four wrong answers on the way. The
 *   question sounds like one question and is five, held in five places that do not agree:
 *
 *   1. **A weights package exists** — `@mailwoman/neural-weights-<locale>`. Says nothing about training: only `en-us`
 *      ships a `model.onnx` at all, the other eight are data-only overlays over it, and `en-nz` / `en-in` ship for
 *      locales the shipped model has never seen a training row from.
 *   2. **The corpus holds rows** — but a country can hold 11 million rows and none of them a street.
 *   3. **The training config ADMITS the country** — `country_weights` is a hard filter (`data_loader.py`: `weight is
 *      None -> continue`), so a country absent from it trains on nothing no matter how many rows exist. That is the
 *      Norway bug's mechanism, and it was still live for every country outside the map.
 *   4. **The gazetteer can resolve it** — 244 countries, which is a different and much wider set than the parser's.
 *   5. **The board measures it** — and a country with rows that are all `improvement_target` has nothing verified.
 *
 *   Conflating any two of those produces a confident wrong answer, which is why the report keeps them in separate
 *   columns and names the mismatches explicitly rather than leaving them to be noticed.
 *
 *   ## The corpus census is CACHED, and says when it was taken
 *
 *   Counting rows means reading every train shard. Column projection makes that ~6 minutes for 681M rows across 705
 *   shards — cheap enough to be exact and far too slow for a tool call, so it is cached to the data root and refreshed
 *   on request. A stale cache is reported with its age rather than silently served as current.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"

/**
 * How well a country can be geocoded, in the three tiers the resolution ladder actually has.
 *
 * `published` means a consumer can get it with `mailwoman data pull`. `build-local` means the artifact exists on a lab
 * machine and cannot be shipped — ODbL sources, mostly — which reads identically to `published` from inside the repo
 * and not at all from outside it.
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
	 * Of those, rows carrying a `street` or `house_number` label — the ones that teach an address rather than a name.
	 */
	corpusStreetRows: number
	/**
	 * Whether the training config's `country_weights` admits it. A false here means the rows train nothing.
	 */
	admitted: boolean
	/**
	 * The locale package serving it, if one ships. Existence is not training — see the file header.
	 */
	weightsPackage?: string
	/**
	 * Admin places in the serving gazetteer.
	 */
	gazetteerPlaces: number
	geocodeTier: GeocodeTier
	/**
	 * Board rows, and how many of them gate rather than merely track.
	 */
	boardRows: number
	boardGatedRows: number
}

/**
 * The four ways the five registers disagree. Each one is a real defect class that has shipped at least once.
 */
export interface CoverageMismatches {
	/**
	 * Rows in the corpus, NOT admitted by `country_weights` — trains on nothing. The Norway shape.
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
	 * Trained (admitted, with rows) but no board row gates it — a locale nothing would catch regressing.
	 */
	trainedButUnmeasured: string[]
	/**
	 * Board rows exist but the country trains on nothing — measured against a capability we never taught.
	 */
	measuredButUntrained: string[]
}

export interface CoverageReport {
	countries: CountryCoverage[]
	mismatches: CoverageMismatches
	corpusVersion: string
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
 * Where the cached corpus census lives. Under the data root rather than the repo: it describes a build artifact, not
 * source, and it is regenerated rather than edited.
 */
export function corpusCensusPath(): string {
	return String(dataRootPath("corpus", "coverage-census.json"))
}

interface CorpusCensus {
	takenAt: string
	corpusVersion: string
	manifest: string
	total: number
	rows: Record<string, number>
	streetRows: Record<string, number>
}

/**
 * Arrow list columns arrive as `{list:[{element:v}]}`. Reading one as a plain array yields nothing and every
 * label-based count comes back zero — a false negative that looks exactly like a real absence.
 */
function unwrapList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value

	const list = (value as { list?: unknown })?.list

	return Array.isArray(list) ? list.map((entry) => (entry as { element?: unknown })?.element ?? entry) : []
}

const STREET_LABEL = /(^|-)street($|_)|house_number/

/**
 * Count every train row in the corpus, per country, and how many carry a street span.
 *
 * Exact rather than sampled: shards are grouped by SOURCE, so a stride over them reads a handful of families and
 * reports their countries as the corpus's. Column projection keeps the full read affordable.
 */
export async function buildCorpusCensus(manifestPath: string): Promise<CorpusCensus> {
	const { ParquetReader } = (await import("@mailwoman/corpus/parquet-wrapper")) as {
		ParquetReader: { openFile(path: string): Promise<ParquetLike> }
	}

	const manifest = parseJSONStrict<{
		corpus_version?: string
		shards?: Array<{ split?: string; path?: string }>
	}>(readFileSync(manifestPath, "utf8"))

	const shards = (manifest.shards ?? [])
		.filter((s) => s.split === "train" && s.path)
		.map((s) => s.path!.replace("/data/", `${String(dataRootPath())}/`))

	const rows: Record<string, number> = {}
	const streetRows: Record<string, number> = {}
	let total = 0

	for (const path of shards) {
		let reader: ParquetLike

		try {
			reader = await ParquetReader.openFile(path)
		} catch {
			continue
		}

		try {
			const cursor = reader.getCursor(["country", "labels"])
			let record: Record<string, unknown> | null

			while ((record = await cursor.next())) {
				total++

				const country = String(record["country"] ?? "").toUpperCase() || "??"

				rows[country] = (rows[country] ?? 0) + 1

				if (unwrapList(record["labels"]).some((label) => STREET_LABEL.test(String(label)))) {
					streetRows[country] = (streetRows[country] ?? 0) + 1
				}
			}
		} finally {
			await reader.close?.()
		}
	}

	return {
		takenAt: new Date().toISOString(),
		corpusVersion: manifest.corpus_version ?? "unknown",
		manifest: manifestPath,
		total,
		rows,
		streetRows,
	}
}

interface ParquetLike {
	getCursor(columns?: string[]): { next(): Promise<Record<string, unknown> | null> }
	close?(): Promise<void>
}

/**
 * Read `country_weights` out of a training config without a YAML dependency.
 *
 * The block is a flat `CC: weight` list, so a line scan is enough — and it preserves the one thing a YAML parser would
 * destroy here: a bare `NO` key stays the string `"NO"` rather than becoming the boolean `false`. That retyping is the
 * exact bug this file exists partly to surface, so the reader must not reproduce it.
 */
export function readAdmittedCountries(configPath: string): Set<string> {
	if (!existsSync(configPath)) return new Set()

	const admitted = new Set<string>()
	let inBlock = false

	// A training config is a few hundred lines, and this reader must stay SYNCHRONOUS: the whole point is to read the
	// block WITHOUT a YAML parser, so a bare `NO` key stays the string it is rather than becoming the boolean YAML 1.1
	// makes of it.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and sync by contract
	for (const line of readFileSync(configPath, "utf8").split("\n")) {
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
 * Board rows per country, and how many of them gate.
 *
 * Reads the cases tree the loader reads: two-letter directories only. `generalization/` is excluded by that same filter
 * and holds 279 rows, so a glob over `*​/*.jsonl` overstates the board by 43%.
 */
export function readBoardCoverage(casesRoot: string): Map<string, { rows: number; gated: number }> {
	const out = new Map<string, { rows: number; gated: number }>()

	if (!existsSync(casesRoot)) return out

	for (const dir of readdirSync(casesRoot)) {
		if (!/^[a-z]{2}$/.test(dir)) continue

		const dirPath = join(casesRoot, dir)

		if (!statSync(dirPath).isDirectory()) continue

		for (const file of readdirSync(dirPath)) {
			if (!file.endsWith(".jsonl")) continue

			// One board case file: tens to hundreds of rows, and the whole 649-row board across every file is under a
			// megabyte.
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- small, bounded, and sync by contract
			for (const line of readFileSync(join(dirPath, file), "utf8").split("\n")) {
				if (!line.trim()) continue

				const row = tryParsingJSON<{ country?: string; status?: string }>(line)

				if (row === null) continue

				const country = String(row.country ?? dir).toUpperCase()
				const entry = out.get(country) ?? { rows: 0, gated: 0 }

				entry.rows++

				if (row.status === "pass") {
					entry.gated++
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
export function readGazetteerCoverage(dbPath: string): Map<string, number> {
	const out = new Map<string, number>()

	if (!existsSync(dbPath)) return out

	const db = new DatabaseSync(dbPath, { readOnly: true })

	try {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
		const names = new Set(tables.map((t) => t.name))

		// The serving DB is the candidate table; the older admin build exposes `spr`. Support both rather than
		// hard-coding one, because which is live is expressed in a symlink and changes.
		const sql = names.has("candidate")
			? "SELECT c.code AS cc, COUNT(*) AS n FROM candidate x JOIN country_codes c ON c.id = x.country_id GROUP BY c.code"
			: "SELECT country AS cc, COUNT(*) AS n FROM spr GROUP BY country"

		for (const row of db.prepare(sql).all() as Array<{ cc: string | null; n: number }>) {
			if (row.cc) {
				out.set(row.cc.toUpperCase(), row.n)
			}
		}
	} catch {
		// An unreadable gazetteer is a missing column, not a failed report.
	} finally {
		db.close()
	}

	return out
}

/**
 * Countries whose rooftop address points a CONSUMER can actually obtain.
 *
 * `data-bundles.ts` is the authority and it has four entries — candidate, poi, us, fr. Every other rooftop shard on a
 * lab machine is ODbL `build-local` and cannot be shipped, which reads identically to published from inside the repo.
 */
export const ROOFTOP_PUBLISHED = new Set(["US", "FR"])

/**
 * Locale packages that ship, mapped to the country they scope. Existence is not training — see the file header.
 */
export const WEIGHTS_PACKAGE_BY_COUNTRY: ReadonlyMap<string, string> = new Map([
	["US", "en-us"],
	["FR", "fr-fr"],
	["GB", "en-gb"],
	["AU", "en-au"],
	["NZ", "en-nz"],
	["DE", "de-de"],
	["ES", "es-es"],
	["IT", "it-it"],
	["IN", "en-in"],
])

export interface CensusCoverageOptions {
	/**
	 * Training config whose `country_weights` decides admission.
	 */
	configPath: string
	/**
	 * Corpus MANIFEST.json to census. Only read when the cache is missing or `refresh` is set.
	 */
	manifestPath: string
	/**
	 * The gauntlet cases tree.
	 */
	casesRoot: string
	/**
	 * Serving gazetteer. Defaults to the data root's `wof/candidate.db`.
	 */
	gazetteerPath?: string
	/**
	 * Recount the corpus rather than reading the cache. Costs minutes.
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

	if (!options.refresh && existsSync(cachePath)) {
		census = parseJSONStrict<CorpusCensus>(readFileSync(cachePath, "utf8"))
		takenAt = census.takenAt
	} else {
		census = await buildCorpusCensus(options.manifestPath)
		writeFileSync(cachePath, JSON.stringify(census, null, 1))
		takenAt = null
	}

	const admitted = readAdmittedCountries(options.configPath)
	const board = readBoardCoverage(options.casesRoot)
	const gazetteerPath = options.gazetteerPath ?? String(dataRootPath("wof", "candidate.db"))
	const gazetteer = readGazetteerCoverage(gazetteerPath)

	const all = new Set<string>([
		...Object.keys(census.rows),
		...admitted,
		...board.keys(),
		...gazetteer.keys(),
		...WEIGHTS_PACKAGE_BY_COUNTRY.keys(),
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
			...(WEIGHTS_PACKAGE_BY_COUNTRY.has(cc) ? { weightsPackage: WEIGHTS_PACKAGE_BY_COUNTRY.get(cc) } : {}),
			gazetteerPlaces,
			geocodeTier: ROOFTOP_PUBLISHED.has(cc) ? "rooftop-published" : gazetteerPlaces > 0 ? "locality" : "none",
			boardRows: boardEntry?.rows ?? 0,
			boardGatedRows: boardEntry?.gated ?? 0,
		}
	})

	const trains = (c: CountryCoverage): boolean => c.admitted && c.corpusRows > 0

	return {
		countries,
		mismatches: {
			presentButDropped: countries.filter((c) => c.corpusRows > 0 && !c.admitted).map((c) => c.country),
			admittedButEmpty: countries.filter((c) => c.admitted && c.corpusRows === 0).map((c) => c.country),
			packageWithoutTraining: countries.filter((c) => c.weightsPackage && !trains(c)).map((c) => c.country),
			trainedButUnmeasured: countries.filter((c) => trains(c) && c.boardGatedRows === 0).map((c) => c.country),
			measuredButUntrained: countries.filter((c) => c.boardRows > 0 && !trains(c)).map((c) => c.country),
		},
		corpusVersion: census.corpusVersion,
		corpusRowsTotal: census.total,
		corpusCensusTakenAt: takenAt,
		configPath: options.configPath,
		gazetteerPath,
		notes: [
			"A weights package is not training. Only `en-us` ships a model.onnx; the other eight locale packages are " +
				"data-only overlays over it, and every locale resolves the identical weights file.",
			"`country_weights` is a HARD admission filter (data_loader.py: `weight is None -> continue`). A country " +
				"absent from it trains on nothing regardless of how many corpus rows exist — the Norway bug's mechanism.",
			"Rooftop geocoding is `published` for US and FR only. `data-bundles.ts` has four entries and every other " +
				"rooftop shard is ODbL build-local, which looks identical from inside the repo and is unobtainable outside it.",
			"A board row that is not `status: pass` tracks rather than gates, so `boardGatedRows: 0` means nothing about " +
				"that country is verified.",
		],
	}
}
