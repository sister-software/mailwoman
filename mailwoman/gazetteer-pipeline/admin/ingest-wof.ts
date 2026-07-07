/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   WOF GeoJSON ingest — Phase 1 (enumerate) + Phase 2 (parallel reads, single-thread writer) of the
 *   admin-gazetteer build. Moved from `scripts/build-unified-wof.ts` (the WAL + Freeze design brief,
 *   docs/articles/reviews/2026-05-28-sqlite-wal-strategy.md). The caller owns the staging DB (WAL
 *   pragmas + `createUnifiedSchema`); this function only enumerates + ingests.
 */

import { readFile } from "node:fs/promises"
import type { DatabaseSync } from "node:sqlite"

import { isOfficialLanguage } from "@mailwoman/codex/country"
import FastGlob from "fast-glob"
import { asyncParallelIterator } from "spliterator"

/** The admin placetype allowlist (postalcode builds pass their own set). */
export const ADMIN_PLACETYPES: ReadonlySet<string> = new Set([
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"macroregion",
	"macrocounty",
])

interface ParsedFeature {
	id: number
	parent_id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	minLatitude: number
	minLongitude: number
	maxLatitude: number
	maxLongitude: number
	population: number
	isCurrent: number
	isDeprecated: number
	isCeased: number
	isSuperseded: number
	isSuperseding: number
	lastmodified: number
	concordances: Record<string, string | number>
	names: Array<{ name: string; language: string; privateuse: string; official: number }>
}

function parseFeature(text: string, placetypes: ReadonlySet<string>): ParsedFeature | null {
	const feature = JSON.parse(text)
	const props = feature.properties

	if (!props) return null

	const supersededBy = props["wof:superseded_by"]

	if (supersededBy && supersededBy.length > 0) return null

	const placetype = props["wof:placetype"]

	if (!placetypes.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

	const lat = typeof props["geom:latitude"] === "number" ? props["geom:latitude"] : 0
	const lon = typeof props["geom:longitude"] === "number" ? props["geom:longitude"] : 0
	// WOF `geom:bbox` is "minLon,minLat,maxLon,maxLat". Fall back to the centroid (a point bbox) when
	// absent — still correct for point-in-box proximity, the resolver's main bbox use.
	let [minLon, minLat, maxLon, maxLat] = [lon, lat, lon, lat]
	const bboxStr = props["geom:bbox"]

	if (typeof bboxStr === "string") {
		const parts = bboxStr.split(",").map(Number)

		if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
			;[minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]
		}
	}

	const names: Array<{ name: string; language: string; privateuse: string; official: number }> = []
	const country = props["wof:country"] ?? ""

	for (const [key, value] of Object.entries(props)) {
		const match = key.match(/^name:([a-z]{3})_x_(preferred|variant)$/)

		if (!match || !value) continue
		const lang = match[1]!
		const privateuse = match[2]!
		// #936: only PREFERRED forms in an official language are official names — x_variant rows
		// tagged with an official language are abbreviations/codes ("MSP", "Frisco"), and marking
		// them official scored 13× the collision count in the risk probe.
		const official = privateuse === "preferred" && isOfficialLanguage(country, lang) ? 1 : 0
		const vals = Array.isArray(value) ? value : [value]

		for (const v of vals) {
			if (typeof v === "string" && v.length > 0) {
				names.push({ name: v, language: lang, privateuse, official })
			}
		}
	}

	return {
		id: props["wof:id"],
		parent_id: props["wof:parent_id"] ?? -1,
		name: props["wof:name"] ?? "",
		placetype,
		country: props["wof:country"] ?? "",
		latitude: lat,
		longitude: lon,
		minLatitude: minLat,
		minLongitude: minLon,
		maxLatitude: maxLat,
		maxLongitude: maxLon,
		population: props["wof:population"] ?? props["gn:population"] ?? 0,
		isCurrent: mzIsCurrent === 0 || mzIsCurrent === "0" ? 0 : 1,
		isDeprecated: props["edtf:deprecated"] ? 1 : 0,
		isCeased: props["edtf:cessation"] ? 1 : 0,
		isSuperseded: (props["wof:superseded_by"]?.length ?? 0) > 0 ? 1 : 0,
		isSuperseding: (props["wof:supersedes"]?.length ?? 0) > 0 ? 1 : 0,
		lastmodified: typeof props["wof:lastmodified"] === "number" ? props["wof:lastmodified"] : 0,
		concordances: props["wof:concordances"] ?? {},
		names,
	}
}

export interface IngestWOFOptions {
	/** WOF repos root (a parent of `whosonfirst-data*` subrepos, or a single repo directory). */
	dataDir: string
	/** Placetype allowlist. Default {@link ADMIN_PLACETYPES}. */
	placetypes?: ReadonlySet<string>
	/** Parallel file reads. Default 64. */
	concurrency?: number
	/** Files per write transaction. Default 500. */
	batchCommitSize?: number
	/** Progress callback — invoked every 25,000 processed files. */
	onProgress?: (processed: number, skipped: number, total: number) => void
}

export interface IngestWOFResult {
	filesFound: number
	placesIngested: number
	skipped: number
}

/**
 * Enumerate + ingest WOF GeoJSON into an already-open unified staging DB (parallel reads, single-thread writer, batched
 * transactions). The `whosonfirst-data-postalcode-*` repos are excluded unless the placetype set asks for `postalcode`
 * — enumerating + reading millions of postcode files the admin build filters out anyway was the bulk of the ingest time
 * (#1015/#1021).
 */
export async function ingestWOF(db: DatabaseSync, opts: IngestWOFOptions): Promise<IngestWOFResult> {
	const placetypes = opts.placetypes ?? ADMIN_PLACETYPES
	const concurrency = opts.concurrency ?? 64
	const batchCommitSize = opts.batchCommitSize ?? 500

	const ignore = ["**/*-alt-*"]

	if (!placetypes.has("postalcode")) {
		ignore.push("**/whosonfirst-data-postalcode-*/**")
	}
	const filePaths = await FastGlob("**/data/**/*.geojson", {
		cwd: opts.dataDir,
		absolute: true,
		ignore,
	})

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, privateuse, official, lastmodified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
	const concordancesInsert = db.prepare(
		`INSERT INTO concordances (id, other_id, other_source, lastmodified) VALUES (?, ?, ?, ?)`
	)
	const populationInsert = db.prepare(`INSERT OR REPLACE INTO place_population (id, population) VALUES (?, ?)`)

	let processed = 0
	let skipped = 0
	let inTransaction = false

	const beginIfNeeded = () => {
		if (!inTransaction) {
			db.exec("BEGIN TRANSACTION")
			inTransaction = true
		}
	}

	const commitIfNeeded = (force = false) => {
		if (inTransaction && (force || processed % batchCommitSize === 0)) {
			db.exec("COMMIT")
			inTransaction = false
		}
	}

	const readResults = asyncParallelIterator(filePaths, concurrency, (filePath) => readFile(filePath, "utf8"))

	for await (const text of readResults) {
		const feature = parseFeature(text, placetypes)

		if (!feature) {
			skipped++
			continue
		}

		beginIfNeeded()

		sprInsert.run(
			feature.id,
			feature.parent_id,
			feature.name,
			feature.placetype,
			feature.country,
			feature.latitude,
			feature.longitude,
			feature.minLatitude,
			feature.minLongitude,
			feature.maxLatitude,
			feature.maxLongitude,
			feature.isCurrent,
			feature.isDeprecated,
			feature.isCeased,
			feature.isSuperseded,
			feature.isSuperseding,
			feature.lastmodified
		)

		for (const n of feature.names) {
			namesInsert.run(
				feature.id,
				n.name,
				feature.placetype,
				feature.country,
				n.language,
				n.privateuse,
				n.official,
				feature.lastmodified
			)
		}

		for (const [source, value] of Object.entries(feature.concordances)) {
			concordancesInsert.run(feature.id, String(value), source, feature.lastmodified)
		}

		if (feature.population > 0) {
			populationInsert.run(feature.id, feature.population)
		}

		processed++
		commitIfNeeded()

		if (processed % 25_000 === 0) {
			opts.onProgress?.(processed, skipped, filePaths.length)
		}
	}

	commitIfNeeded(true)

	return { filesFound: filePaths.length, placesIngested: processed, skipped }
}
