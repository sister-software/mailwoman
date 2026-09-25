/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ingests WOF GeoJSON files into the admin-gazetteer staging database.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import type { WOFFeature, WOFProperties } from "@mailwoman/core/resources/whosonfirst"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import {
	choosePoint,
	type GeoNamesAnchorLookup,
	type PointChoice,
} from "#gazetteer-pipeline/admin/label-point-adjudicator"

/**
 * The number of values in a 2D bounding box: `[west, south, east, north]`.
 */
const BBOX_2D_LENGTH = 4

/**
 * The default admin placetypes to ingest.
 *
 * Postalcode builds pass their own list.
 * Venue placetypes such as `campus` belong to the sub-venue layer.
 */
export const ADMIN_PLACETYPES: ReadonlySet<string> = new Set([
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"macrohood",
	"microhood",
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
	pointChoice?: PointChoice
	names: Array<{ name: string; language: string; privateuse: string; official: number }>
}

async function parseFeature(
	text: string,
	placetypes: ReadonlySet<string>,
	anchorLookup?: GeoNamesAnchorLookup
): Promise<ParsedFeature | null> {
	const feature = parseJSONStrict<WOFFeature>(text)
	const props: WOFProperties | undefined = feature.properties

	if (!props) return null

	const supersededBy = props["wof:superseded_by"]

	if (supersededBy && supersededBy.length) return null

	const placetype = props["wof:placetype"]

	if (!placetypes.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

	// The label point is preferred over the geometry point, and each counts only with both coordinates.
	const hasLbl = typeof props["lbl:latitude"] === "number" && typeof props["lbl:longitude"] === "number"
	const hasGeom = typeof props["geom:latitude"] === "number" && typeof props["geom:longitude"] === "number"

	let lat = hasLbl ? props["lbl:latitude"]! : hasGeom ? props["geom:latitude"]! : 0
	let lon = hasLbl ? props["lbl:longitude"]! : hasGeom ? props["geom:longitude"]! : 0
	let pointChoice: PointChoice | undefined

	// Only localities use GeoNames adjudication.
	// GeoNames anchors for regions and counties are centroids.
	if (placetype === "locality" && hasLbl && hasGeom && anchorLookup) {
		const gnID = props["wof:concordances"]?.["gn:id"]

		const anchor =
			gnID !== undefined && props["wof:country"] ? await anchorLookup(props["wof:country"], gnID) : undefined

		const chosen = choosePoint(
			{ latitude: props["geom:latitude"]!, longitude: props["geom:longitude"]! },
			{ latitude: props["lbl:latitude"]!, longitude: props["lbl:longitude"]! },
			anchor
		)

		lat = chosen.latitude
		lon = chosen.longitude
		pointChoice = chosen.choice
	}

	// WOF orders the bbox as west, south, east, north.
	// Without one, the bbox is the point itself.
	let [minLon, minLat, maxLon, maxLat] = [lon, lat, lon, lat]
	const bboxStr = props["geom:bbox"]

	if (typeof bboxStr === "string") {
		const parts = bboxStr.split(",").map(Number)

		if (parts.length === BBOX_2D_LENGTH && parts.every((n) => Number.isFinite(n))) {
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
		// A name is official only when it is a preferred form in an official language.
		const official = privateuse === "preferred" && isOfficialLanguage(country, lang) ? 1 : 0
		const vals = Array.isArray(value) ? value : [value]

		for (const v of vals) {
			if (typeof v === "string" && v.length) {
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
		...(pointChoice ? { pointChoice } : {}),
		names,
	}
}

/**
 * Options for {@link ingestWOF}.
 */
export interface IngestWOFOptions {
	/**
	 * The WOF data root.
	 *
	 * It can be a parent of `whosonfirst-data*` repositories or a single repository.
	 */
	dataDir: PathBuilderLike
	/**
	 * The placetypes to ingest.
	 * Defaults to {@link ADMIN_PLACETYPES}.
	 */
	placetypes?: ReadonlySet<string>
	/**
	 * The number of parallel file reads.
	 * Defaults to 64.
	 */
	concurrency?: number
	/**
	 * The number of ingested records per write transaction.
	 * Defaults to 500.
	 */
	batchCommitSize?: number
	/**
	 * Called after every 25,000 ingested records.
	 */
	onProgress?: (processed: number, skipped: number, total: number) => void
	/**
	 * The GeoNames anchor lookup for label-point adjudication.
	 */
	anchorLookup?: GeoNamesAnchorLookup
}

/**
 * Counts from one {@link ingestWOF} run.
 */
export interface IngestWOFResult {
	filesFound: number
	placesIngested: number
	skipped: number
	/**
	 * The number of records where GeoNames adjudication chose the geometry point over the label point.
	 */
	labelPointOverrides: number
}

/**
 * Ingests WOF GeoJSON into an open staging database.
 *
 * Files are read in parallel and written serially in batched transactions.
 * Postalcode repositories are skipped unless `placetypes` includes `postalcode`.
 */
export async function ingestWOF(db: DatabaseClient<WOFDatabase>, opts: IngestWOFOptions): Promise<IngestWOFResult> {
	const placetypes = opts.placetypes ?? ADMIN_PLACETYPES
	const concurrency = opts.concurrency ?? 64
	const batchCommitSize = opts.batchCommitSize ?? 500

	const exclude = ["**/*-alt-*"]

	if (!placetypes.has("postalcode")) {
		exclude.push("**/whosonfirst-data-postalcode-*/**")
	}

	const filePaths = await Globerator.from("**/data/**/*.geojson", {
		cwd: opts.dataDir,
		absolute: true,
		exclude,
		// A data root can expose one checkout both directly and through a symlink.
		// Skipping symlinks ingests each record once.
		followSymlinks: false,
	}).toArray()

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
	let labelPointOverrides = 0
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

	const readResults = parallelMap(filePaths, (filePath) => readLocalTextFile(filePath), { concurrency })

	for await (const text of readResults) {
		const feature = await parseFeature(text, placetypes, opts.anchorLookup)

		if (!feature) {
			skipped++

			continue
		}

		if (feature.pointChoice === "geom-by-anchor") {
			labelPointOverrides++
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

	return { filesFound: filePaths.length, placesIngested: processed, skipped, labelPointOverrides }
}
