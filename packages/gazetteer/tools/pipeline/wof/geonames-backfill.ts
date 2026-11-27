// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes a Who's On First locality record into a country's `mailwoman` admin fork for each
 *   GeoNames populated place the fork holds no record of.
 *
 *   GeoNames is CC BY 4.0. Who's On First already lists it as a source, and a record's `gn:id`
 *   concordance with `src:geom` `geonames` is the attribution the license asks for.
 *
 *   A place is skipped when a record of the fork already holds its GeoNames id as `gn:id`, so a
 *   second run writes only the places the first one didn't. The caller chooses the places: the admin
 *   build's list of GeoNames places that matched no WOF record, or GeoNames ids given one by one.
 *
 *   A new record's parent is the innermost current boundary of the fork that contains the place's
 *   point, tried in the order `localadmin`, `county`, `region`. The record copies that parent's
 *   `wof:hierarchy` and adds itself. A place no boundary contains is reported and gets no record.
 *
 *   A section of a city, a historical place and a destroyed or abandoned place are left out by
 *   their GeoNames feature code, because a locality record would misstate each of them.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { sortedGlob } from "@mailwoman/core/fs/readers"
import { isMailwomanWOFID, nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { isPresent } from "@mailwoman/core/values/objects"
import { levenshteinSimilarity } from "@mailwoman/match/comparators"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/labels/street/normalize"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { arealPolygons, pointInPolygon } from "@mailwoman/spatial/geometries/polygon"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"

import { readGeonamesDivisions } from "#tools/pipeline/admin/former-divisions"
import { readMailwomanWOFRecords, writeWOFRecord, type WOFRecordFeature } from "#tools/pipeline/wof/record"
import { concordancesOf, hierarchyOf, loadForkRecords, type LoadedRecord } from "#tools/pipeline/wof/region-reform"
import { wofGeometryHash, wofRecordNames } from "#tools/pipeline/wof/slim"
import { wofRepoName } from "#whosonfirst/extract-repo"

/**
 * The placetypes a new locality's parent is looked for at, innermost first.
 */
const PARENT_LADDER = ["localadmin", "county", "region"] as const

/**
 * The GeoNames feature codes a locality record describes: a populated place
 * and a seat of government at any level.
 *
 * `PPLX` (a section of a place), `PPLH` (historical), `PPLQ` (abandoned),
 * `PPLW` (destroyed) and `PPLCH` (a former capital) are left out.
 */
export const LOCALITY_FEATURE_CODES: ReadonlySet<string> = new Set([
	"PPL",
	"PPLA",
	"PPLA2",
	"PPLA3",
	"PPLA4",
	"PPLA5",
	"PPLC",
	"PPLF",
	"PPLG",
	"PPLL",
	"PPLR",
	"PPLS",
])

/**
 * One GeoNames populated place, as its row in `<CC>.txt` states it.
 */
export interface GeoNamesPlace {
	id: number
	name: string
	/**
	 * The name, its ASCII form and every alternate name of the row.
	 */
	names: string[]
	latitude: number
	longitude: number
	featureCode: string
	/**
	 * The codes of the divisions GeoNames files the place under, levels 1 to 4, each `""` when absent.
	 */
	codes: string[]
	population: number
}

/**
 * Options for {@link backfillGeoNamesPlaces}.
 */
export interface GeoNamesBackfillOptions {
	/**
	 * The ISO 3166-1 alpha-2 code of the country whose fork is changed.
	 */
	country: string
	/**
	 * The GeoNames ids to write records for.
	 */
	geonamesIDs: readonly number[]
	/**
	 * The directory that holds every WOF clone.
	 */
	reposRoot: PathBuilderLike
	/**
	 * The directory that holds `<CC>.txt`.
	 */
	geonamesDir: PathBuilderLike
	/**
	 * Report the records and write no file.
	 */
	dryRun?: boolean
	/**
	 * The id the first new record takes, with each later record taking the next.
	 *
	 * Without it the run reads the mailwoman id range of every fork and mints after the largest.
	 * A caller that runs several countries at once assigns each a block that no other run uses.
	 */
	firstID?: number | null
	/**
	 * The `wof:lastmodified` the new records take, in Unix seconds.
	 */
	lastModified: number
}

/**
 * What {@link backfillGeoNamesPlaces} did, or would do under `dryRun`.
 */
export interface GeoNamesBackfillResult {
	repoDir: string
	/**
	 * The records written, with the parent each was placed under.
	 */
	written: Array<{
		id: number
		geonamesID: number
		name: string
		parent: number
		parentPlacetype: string
		/**
		 * `boundary` when the parent's boundary contains the point, `geonames` when the
		 * parent is the record of the division GeoNames files the place under.
		 */
		parentBy: "boundary" | "geonames"
	}>
	/**
	 * Requested ids a record of the fork already holds as `gn:id`.
	 */
	alreadyHeld: number
	/**
	 * Requested ids with no row in the country's GeoNames file.
	 */
	unknown: number[]
	/**
	 * Requested places left out by feature code, counted per code.
	 */
	leftOut: Record<string, number>
	/**
	 * Requested places no boundary of the fork contains.
	 */
	unlocated: number[]
	/**
	 * Requested places held out because a record within {@link SPELLING_TWIN_KM} has a
	 * name at least {@link SPELLING_TWIN_SIMILARITY} similar, with that record.
	 */
	possibleDuplicates: Array<{
		geonamesID: number
		name: string
		near: number
		nearName: string
		similarity: number
		km: number
	}>
}

/**
 * A record this close to a place is compared with it by name, in kilometers.
 */
export const SPELLING_TWIN_KM = 1

/**
 * A place is held out when a record within {@link SPELLING_TWIN_KM} has a name this similar.
 *
 * Measured on 2026-11-26 over the 81,669 places the admin build's candidate list would
 * add in 152 countries, with each place's GeoNames alternate names compared too. 372
 * places had a neighbor at 0.9 or above, and the rows read as one place spelled two ways,
 * such as `Meinhartschlag` beside `Meinhartsschlag`. 232 had one between 0.8 and 0.9,
 * a mix of respellings (`Ḩīrān` beside `Hayran`) and distinct places. 610 had one between 0.7
 * and 0.8, and those rows read as distinct places, such as `Mato Gege` beside `Santo Gege`.
 * At 0.8 the mixed band is held out, so a held-out place is listed for a reader
 * and a written one has no near twin.
 */
export const SPELLING_TWIN_SIMILARITY = 0.8

/**
 * The WOF placetypes whose records can be the same place as a GeoNames populated place.
 */
const SETTLEMENT_PLACETYPES: ReadonlySet<string> = new Set([
	"locality",
	"localadmin",
	"borough",
	"macrohood",
	"neighbourhood",
	"microhood",
])

/**
 * The side of a grid cell the settlement index files a record under, in degrees.
 *
 * At 0.02 degrees a cell is at most 2.2 km across, so the nine cells around a point
 * hold every record within {@link SPELLING_TWIN_KM} of it.
 */
const TWIN_CELL_DEGREES = 0.02

/**
 * The highest Levenshtein similarity between any name key of one place and any of another.
 */
function highestSimilarity(keys: readonly string[], others: readonly string[]): number {
	let highest = 0

	for (const key of keys) {
		for (const other of others) {
			highest = Math.max(highest, levenshteinSimilarity(key, other))
		}
	}

	return highest
}

function twinCell(latitude: number, longitude: number): string {
	return `${Math.floor(latitude / TWIN_CELL_DEGREES)}:${Math.floor(longitude / TWIN_CELL_DEGREES)}`
}

/**
 * The populated places of a country's GeoNames file, by GeoNames id.
 */
export async function readGeoNamesPlaces(
	geonamesDir: PathBuilderLike,
	country: string
): Promise<Map<number, GeoNamesPlace>> {
	const places = new Map<number, GeoNamesPlace>()

	for await (const fields of readUnquotedTSV(PathBuilder.from(geonamesDir)(`${country.toUpperCase()}.txt`))) {
		if (fields[6] !== "P") continue

		const id = Number(fields[0])

		places.set(id, {
			id,
			name: (fields[1] ?? "").trim(),
			names: [fields[1] ?? "", fields[2] ?? "", ...TextSpliterator.from(fields[3] ?? "", { delimiter: "," })]
				.map((name) => name.trim())
				.filter((name) => name.length > 0),
			latitude: Number(fields[4]),
			longitude: Number(fields[5]),
			featureCode: fields[7] ?? "",
			population: Number(fields[14] ?? 0),
			codes: [fields[10] ?? "", fields[11] ?? "", fields[12] ?? "", fields[13] ?? ""].map((code) => code.trim()),
		})
	}

	return places
}

/**
 * The key of a division's code path in {@link divisionIDsByCodePath}: its codes from
 * the first level down to its own, such as `C` and `C|MW22`.
 */
function codePathKey(codes: readonly string[], level: number): string {
	return codes.slice(0, level).join("|")
}

/**
 * The GeoNames id of each current division of a country at levels 1 to 4, by its code path.
 */
async function divisionIDsByCodePath(geonamesDir: PathBuilderLike, country: string): Promise<Map<string, number>> {
	const { current } = await readGeonamesDivisions(PathBuilder.from(geonamesDir)(`${country.toUpperCase()}.txt`))

	return new Map(
		current
			.filter((division) => CODED_LEVELS.includes(division.level))
			.filter((division) => division.codes.slice(0, division.level).every(Boolean))
			.map((division) => [codePathKey(division.codes, division.level), division.geonamesID] as const)
	)
}

/**
 * Writes a locality record into `options.country`'s admin fork for each requested
 * GeoNames place the fork holds no record of.
 */
export async function backfillGeoNamesPlaces(options: GeoNamesBackfillOptions): Promise<GeoNamesBackfillResult> {
	const reposRoot = PathBuilder.from(options.reposRoot)
	const country = options.country.toUpperCase()
	const repoName = wofRepoName("admin", country)
	const repoDir = reposRoot(repoName)
	const records = await loadForkRecords(repoDir)
	const places = await readGeoNamesPlaces(options.geonamesDir, country)
	const divisions = await divisionIDsByCodePath(options.geonamesDir, country)
	const divisionRecords = new Map<number, LoadedRecord>()
	const held = new Set<number>()

	const settlements = new Map<
		string,
		Array<{ id: number; name: string; latitude: number; longitude: number; keys: string[] }>
	>()

	const boundaries = new Map<
		string,
		Array<{
			record: LoadedRecord
			bbox: WOFRecordFeature["bbox"]
			polygons: NonNullable<ReturnType<typeof arealPolygons>>
		}>
	>()

	for (const record of records.values()) {
		const geonamesID = Number(concordancesOf(record)["gn:id"])

		if (Number.isInteger(geonamesID) && geonamesID > 0) {
			held.add(geonamesID)
		}

		const placetype = String(record.feature.properties["wof:placetype"] ?? "")

		if (SETTLEMENT_PLACETYPES.has(placetype) && record.feature.properties["mz:is_current"] !== 0) {
			const latitude = Number(record.feature.properties["geom:latitude"])
			const longitude = Number(record.feature.properties["geom:longitude"])
			const cell = twinCell(latitude, longitude)

			settlements.set(cell, [
				...(settlements.get(cell) ?? []),
				{
					id: record.feature.id,
					name: String(record.feature.properties["wof:name"] ?? ""),
					latitude,
					longitude,
					keys: [...new Set(wofRecordNames(record.feature.properties).map(normalizeLocalityForKey))].filter(
						(key) => key.length > 0
					),
				},
			])
		}

		if (!PARENT_LADDER.includes(placetype as (typeof PARENT_LADDER)[number])) continue

		if (record.feature.properties["mz:is_current"] === 0) continue

		if (Number.isInteger(geonamesID) && geonamesID > 0) {
			divisionRecords.set(geonamesID, record)
		}

		const polygons = arealPolygons(record.feature.geometry as Parameters<typeof arealPolygons>[0])

		if (!polygons) continue

		boundaries.set(placetype, [...(boundaries.get(placetype) ?? []), { record, bbox: record.feature.bbox, polygons }])
	}

	/**
	 * The record within {@link SPELLING_TWIN_KM} of a place whose name is most similar to one
	 * of the place's names, when that similarity reaches {@link SPELLING_TWIN_SIMILARITY}.
	 */
	const spellingTwin = (place: GeoNamesPlace): GeoNamesBackfillResult["possibleDuplicates"][number] | null => {
		const keys = [...new Set(place.names.map(normalizeLocalityForKey))].filter((key) => key.length > 0)
		const row = Math.floor(place.latitude / TWIN_CELL_DEGREES)
		const column = Math.floor(place.longitude / TWIN_CELL_DEGREES)
		let best: GeoNamesBackfillResult["possibleDuplicates"][number] | null = null

		for (const rowOffset of [-1, 0, 1]) {
			for (const columnOffset of [-1, 0, 1]) {
				for (const settlement of settlements.get(`${row + rowOffset}:${column + columnOffset}`) ?? []) {
					const km = haversine(place.latitude, place.longitude, settlement.latitude, settlement.longitude)

					if (km > SPELLING_TWIN_KM) continue

					const similarity = highestSimilarity(keys, settlement.keys)

					if (similarity >= SPELLING_TWIN_SIMILARITY && similarity > (best?.similarity ?? 0)) {
						best = {
							geonamesID: place.id,
							name: place.name,
							near: settlement.id,
							nearName: settlement.name,
							similarity: Number(similarity.toFixed(3)),
							km: Number(km.toFixed(3)),
						}
					}
				}
			}
		}

		return best
	}

	const containing = (longitude: number, latitude: number): LoadedRecord | null => {
		for (const placetype of PARENT_LADDER) {
			for (const { record, bbox, polygons } of boundaries.get(placetype) ?? []) {
				if (longitude < bbox[0] || longitude > bbox[2] || latitude < bbox[1] || latitude > bbox[3]) continue

				if (polygons.some((rings) => pointInPolygon(longitude, latitude, rings))) return record
			}
		}

		return null
	}

	// A WOF id is unique across every repository, so the minter reads the mailwoman range in all of them.
	// A caller that writes several forks at once gives each run its own block through `firstID`,
	// because two runs that both read the range would mint the same ids.
	const minted = isPresent(options.firstID)
		? null
		: new Set(
				(await readMailwomanWOFRecords(await sortedGlob(reposRoot, "whosonfirst-data-*", { onlyFiles: false }))).map(
					(record) => record.id
				)
			)

	let nextBlockID = options.firstID ?? 0

	if (isPresent(options.firstID) && !isMailwomanWOFID(options.firstID)) {
		throw new RangeError(`geonames backfill: firstID ${options.firstID} is outside the mailwoman WOF id range`)
	}

	const result: GeoNamesBackfillResult = {
		repoDir: repoDir.toString(),
		written: [],
		alreadyHeld: 0,
		unknown: [],
		leftOut: {},
		unlocated: [],
		possibleDuplicates: [],
	}

	const newRecords: WOFRecordFeature[] = []

	for (const geonamesID of new Set(options.geonamesIDs)) {
		if (held.has(geonamesID)) {
			result.alreadyHeld++

			continue
		}

		const place = places.get(geonamesID)

		if (!place) {
			result.unknown.push(geonamesID)

			continue
		}

		if (!LOCALITY_FEATURE_CODES.has(place.featureCode)) {
			result.leftOut[place.featureCode] = (result.leftOut[place.featureCode] ?? 0) + 1

			continue
		}

		const twin = spellingTwin(place)

		if (twin) {
			result.possibleDuplicates.push(twin)

			continue
		}

		const around = containing(place.longitude, place.latitude)

		// A fork whose divisions are points, as Malawi's districts are, contains no place.
		// The parent is then the record that holds the GeoNames id of the lowest division
		// GeoNames files the place under, tried from level 4 up to level 1.
		const filedUnder = around
			? null
			: (CODED_LEVELS.map((level) => divisionRecords.get(divisions.get(codePathKey(place.codes, level)) ?? -1)).find(
					isPresent
				) ?? null)

		const parent = around ?? filedUnder

		if (!parent) {
			result.unlocated.push(geonamesID)

			continue
		}

		const id = minted ? nextMailwomanWOFID(minted) : nextBlockID++

		if (!isMailwomanWOFID(id)) {
			throw new RangeError(`geonames backfill: id ${id} is outside the mailwoman WOF id range`)
		}

		minted?.add(id)
		held.add(geonamesID)

		const parentID = parent.feature.id
		const parentPlacetype = String(parent.feature.properties["wof:placetype"])
		const parentName = String(parent.feature.properties["wof:name"] ?? "")
		const branches = hierarchyOf(parent)

		// The parent's own id is set too: a parent record's hierarchy can omit it,
		// as one Guyanese county's does, and the new record must list its parent either way.
		const hierarchy = (branches.length ? branches : [{}]).map((branch) => ({
			...branch,
			[`${parentPlacetype}_id`]: parentID,
			locality_id: id,
		}))

		const belongsTo = [...new Set(hierarchy.flatMap((branch) => Object.values(branch)))].filter(
			(other) => other !== id && other > 0
		)

		const geometry = { type: "Point", coordinates: [place.longitude, place.latitude] }
		const url = `https://www.geonames.org/${geonamesID}`
		const geonames = `GeoNames populated place ${geonamesID}`

		result.written.push({
			id,
			geonamesID,
			name: place.name,
			parent: parentID,
			parentPlacetype,
			parentBy: around ? "boundary" : "geonames",
		})

		newRecords.push({
			id,
			type: "Feature",
			properties: {
				"edtf:cessation": "uuuu",
				"edtf:inception": "uuuu",
				"geom:area": 0,
				"geom:area_square_m": 0,
				"geom:bbox": `${place.longitude},${place.latitude},${place.longitude},${place.latitude}`,
				"geom:latitude": place.latitude,
				"geom:longitude": place.longitude,
				...(place.population > 0 ? { "gn:population": place.population } : {}),
				"iso:country": country,
				"mailwoman:sources": [
					{ property: "wof:name", citation: `${geonames}: name "${place.name}"`, url },
					{ property: "geometry", citation: `${geonames}: its point`, url },
					{ property: "wof:concordances", citation: `${geonames}: its id`, url },
					{
						property: "wof:hierarchy",
						citation: around
							? `The hierarchy of WOF ${parentPlacetype} ${parentID} (${parentName}), whose boundary contains the GeoNames point.`
							: `The hierarchy of WOF ${parentPlacetype} ${parentID} (${parentName}), the record that holds the GeoNames id of the division GeoNames files this place under. No boundary of the repository contains the point.`,
					},
				],
				"mz:is_current": 1,
				"src:geom": "geonames",
				"wof:belongsto": belongsTo.toSorted((a, b) => a - b),
				"wof:breaches": [],
				"wof:concordances": { "gn:id": geonamesID },
				"wof:country": country,
				"wof:geomhash": wofGeometryHash(geometry),
				"wof:hierarchy": hierarchy,
				"wof:id": id,
				"wof:lastmodified": options.lastModified,
				"wof:name": place.name,
				"wof:parent_id": parentID,
				"wof:placetype": "locality",
				"wof:repo": repoName,
				"wof:superseded_by": [],
				"wof:supersedes": [],
				"wof:tags": [],
			},
			bbox: [place.longitude, place.latitude, place.longitude, place.latitude],
			geometry,
		})
	}

	if (!options.dryRun) {
		for (const record of newRecords.filter(isPresent)) {
			await writeWOFRecord(repoDir, record)
		}
	}

	return result
}
