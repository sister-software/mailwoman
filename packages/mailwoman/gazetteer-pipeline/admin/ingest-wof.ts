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
import { parseJSONStrict } from "@mailwoman/core/objects"
import type { WOFFeature, WOFProperties } from "@mailwoman/core/resources/whosonfirst"
import FastGlob from "fast-glob"
import { parallelMap } from "spliterator"

import { choosePoint, type GeoNamesAnchorLookup, type PointChoice } from "./label-point-adjudicator.ts"

/**
 * Arity of a 2D bounding box: `[west, south, east, north]`.
 */
const BBOX_2D_LENGTH = 4

/**
 * The admin placetype allowlist (postalcode builds pass their own set).
 *
 * `macrohood`/`microhood` are the nesting-depth siblings of `neighbourhood` and map to the same `dependent_locality`
 * ComponentTag (`docs/engineering/reference/placetype-evidence.mdx`). WOF stocks them in quantity — a 20,000-file
 * sample of `whosonfirst-data-admin-us` holds 561 microhood and 99 macrohood against 1,532 neighbourhood.
 *
 * They are ingested without being reachable by name. No `PLACETYPE_FILTER_GROUPS` entry lists either, and placetypes
 * absent from that table pass through unfiltered, so a `locality` query expands to exactly `[locality, borough,
 * localadmin]`. Those rows answer only an UNFILTERED query, which ranks population-first and sorts a hood carrying no
 * population last.
 *
 * `campus` is deliberately NOT here despite being commoner than macrohood in the same sample (1,368). It is a venue
 * tier — universities, hospitals, airports — not an admin one, and it belongs to the sub-venue work, where its
 * terminals and wings are the point.
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

function parseFeature(
	text: string,
	placetypes: ReadonlySet<string>,
	anchorLookup?: GeoNamesAnchorLookup
): ParsedFeature | null {
	// Typed against the schema `@mailwoman/core/resources/whosonfirst` already owns (`WOFFeature`/`WOFProperties`,
	// admin.ts) rather than reading `any`. This file used to name all seventeen `wof:`/`geom:`/`edtf:`/`mz:` keys as
	// bare strings, which meant a typo — `wof:superceded_by` — would have compiled, read `undefined`, and silently
	// ingested every superseded record in the corpus. A type-only import: erased at build, zero runtime cost.
	const feature = parseJSONStrict<WOFFeature>(text)
	const props: WOFProperties | undefined = feature.properties

	if (!props) return null

	const supersededBy = props["wof:superseded_by"]

	if (supersededBy && supersededBy.length) return null

	const placetype = props["wof:placetype"]

	if (!placetypes.has(placetype)) return null

	const mzIsCurrent = props["mz:is_current"]

	// Label centroid first, math centroid as the fallback — same preference the postcode-locality builder applies.
	// The math centroid is wrong exactly where it matters most: a multipolygon spanning overseas territories pulls it
	// off the mainland entirely (France's geom: point is in Spain; lbl: is metropolitan France). Both coordinates are
	// taken from the SAME source or neither: a lbl:latitude paired with a geom:longitude would be a point on neither
	// centroid.
	//
	// The label point carries its own upstream defects (#1905: WOF's lbl: for Washington DC is 7.8 km out), so when
	// BOTH pairs exist and disagree widely, the record's GeoNames concordance adjudicates — see choosePoint's rule
	// and the census in label-point-adjudicator.ts. No anchor, no disagreement, or no decisive separation → the
	// label preference, byte-identical to before.
	const hasLbl = typeof props["lbl:latitude"] === "number" && typeof props["lbl:longitude"] === "number"
	const hasGeom = typeof props["geom:latitude"] === "number" && typeof props["geom:longitude"] === "number"

	let lat = hasLbl ? props["lbl:latitude"]! : hasGeom ? props["geom:latitude"]! : 0
	let lon = hasLbl ? props["lbl:longitude"]! : hasGeom ? props["geom:longitude"]! : 0
	let pointChoice: PointChoice | undefined

	if (hasLbl && hasGeom && anchorLookup) {
		const gnID = props["wof:concordances"]?.["gn:id"]
		const anchor = gnID !== undefined && props["wof:country"] ? anchorLookup(props["wof:country"], gnID) : undefined

		const chosen = choosePoint(
			{ latitude: props["geom:latitude"]!, longitude: props["geom:longitude"]! },
			{ latitude: props["lbl:latitude"]!, longitude: props["lbl:longitude"]! },
			anchor
		)

		lat = chosen.latitude
		lon = chosen.longitude
		pointChoice = chosen.choice
	}

	// WOF `geom:bbox` is "minLon,minLat,maxLon,maxLat". Fall back to the centroid (a point bbox) when
	// absent — still correct for point-in-box proximity, the resolver's main bbox use.
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
		// #936: only PREFERRED forms in an official language are official names — x_variant rows
		// tagged with an official language are abbreviations/codes ("MSP", "Frisco"), and marking
		// them official scored 13× the collision count in the risk probe.
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

export interface IngestWOFOptions {
	/**
	 * WOF repos root (a parent of `whosonfirst-data*` subrepos, or a single repo directory).
	 */
	dataDir: string
	/**
	 * Placetype allowlist. Default {@link ADMIN_PLACETYPES}.
	 */
	placetypes?: ReadonlySet<string>
	/**
	 * Parallel file reads. Default 64.
	 */
	concurrency?: number
	/**
	 * Files per write transaction. Default 500.
	 */
	batchCommitSize?: number
	/**
	 * Progress callback — invoked every 25,000 processed files.
	 */
	onProgress?: (processed: number, skipped: number, total: number) => void
	/**
	 * GeoNames anchor lookup for the label-point adjudication (#1905) — see `label-point-adjudicator.ts`. Absent = the
	 * plain label preference, byte-identical to a build before the adjudicator existed.
	 */
	anchorLookup?: GeoNamesAnchorLookup
}

export interface IngestWOFResult {
	filesFound: number
	placesIngested: number
	skipped: number
	/**
	 * Records whose stored point is the GEOMETRIC centroid because the GeoNames anchor overrode the label preference
	 * (`choice === "geom-by-anchor"`). Zero with no anchor lookup configured; a build that expected the adjudicator to
	 * run reads this instead of assuming.
	 */
	labelPointOverrides: number
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

	const readResults = parallelMap(filePaths, (filePath) => readFile(filePath, "utf8"), { concurrency })

	for await (const text of readResults) {
		const feature = parseFeature(text, placetypes, opts.anchorLookup)

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
