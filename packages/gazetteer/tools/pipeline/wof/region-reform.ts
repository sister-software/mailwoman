// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Applies a reform of a country's first-level divisions to its `mailwoman` admin fork.
 *
 *   A reform replaces the divisions Who's On First holds as current regions with new ones.
 *   A {@link RegionReformSpec} states the new units and, for each, the WOF records of the tier below
 *   that lie inside it. The tool then makes four kinds of change:
 *
 *   - It writes a region record for each unit. The geometry is the union of the unit's member
 *       records, so it comes from Who's On First's own boundaries and brings no new source.
 *   - It marks each replaced region ceased and lists its successors in `wof:superseded_by`.
 *       The admin build keeps such a record as a former division.
 *   - A unit that an existing record already describes keeps that record. The record gains the unit's code.
 *   - It moves every record below a replaced region to its unit: `wof:hierarchy`, `wof:belongsto`
 *       and, where the region was the parent, `wof:parent_id`.
 *
 *   A record below a replaced region takes the unit GeoNames files it under, read through the record's
 *   `gn:id` concordance and the GeoNames row's first-level code. A record without that concordance takes
 *   the unit of its member ancestor, and one without a member ancestor takes the unit of the member whose
 *   boundary contains its point. A member record always takes the unit the specification gives it.
 *
 *   A second run finds each unit's record by its `iso:id` concordance and writes the same ids.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { isPresent } from "@mailwoman/core/values/objects"
import { escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { arealPolygons, pointInPolygon } from "@mailwoman/spatial/geometries/polygon"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import {
	patchWOFRecordText,
	readMailwomanWOFRecords,
	wofRecordPath,
	writeWOFRecord,
	type WOFRecordFeature,
} from "#tools/pipeline/wof/record"
import { DEFAULT_COORDINATE_DECIMALS, wofGeometryHash, wofGeometryJSON } from "#tools/pipeline/wof/slim"
import { wofRepoName } from "#whosonfirst/extract-repo"

/**
 * A document a reform's facts are read from.
 */
export interface ReformCitation {
	citation: string
	url?: string
}

/**
 * One division the reform creates.
 */
export interface RegionReformUnit {
	/**
	 * The unit's ISO 3166-2 code, `KE-01`.
	 */
	iso: string
	/**
	 * The unit's name without its designator, `Baringo`.
	 */
	name: string
	/**
	 * The unit's English name when `name` is in another language, `South Papua` for `Papua Selatan`.
	 */
	english?: string
	/**
	 * Other English spellings of the name, `Elgeyo-Marakwet` beside `Elgeyo/Marakwet`.
	 */
	variants?: string[]
	/**
	 * Names in other languages, keyed by WOF name property: `{ "name:ind_x_preferred": ["Papua Selatan"] }`.
	 */
	names?: Record<string, string[]>
	/**
	 * The unit's Wikidata item, `Q808201`.
	 */
	wikidata: string
	/**
	 * The unit's GeoNames id, the id of its first-level row.
	 */
	geonames: number
	/**
	 * The WOF ids of the records of {@link RegionReformSpec.memberPlacetype} inside the unit.
	 */
	members: number[]
	/**
	 * The WOF id of a current region record that already describes this unit and is kept.
	 */
	existing?: number
	/**
	 * A sentence on a member whose boundary crosses into another unit.
	 */
	note?: string
}

/**
 * A reform of one country's first-level divisions.
 */
export interface RegionReformSpec {
	/**
	 * The ISO 3166-1 alpha-2 code of the country whose fork is changed.
	 */
	country: string
	/**
	 * The WOF placetype of the member records, `county`.
	 */
	memberPlacetype: string
	/**
	 * The designator the long label adds after a unit's English name, `County`.
	 * An empty string writes no long label.
	 */
	designator: string
	/**
	 * The EDTF date the units came into being.
	 */
	inception: string
	/**
	 * The EDTF date the replaced regions ceased.
	 */
	cessation: string
	/**
	 * The WOF ids of the replaced regions.
	 */
	ceased: number[]
	/**
	 * The WOF ids of regions that stay current and lost part of their area to a new unit.
	 *
	 * Each is also a unit with `existing` set, and takes the union of its remaining members as its boundary.
	 */
	split?: number[]
	sources: {
		/**
		 * The law that creates the units.
		 */
		law: ReformCitation
		/**
		 * Where each unit's name, code and identifiers were read.
		 */
		units: ReformCitation
		/**
		 * How each member was assigned to its unit.
		 */
		membership: ReformCitation
	}
	units: RegionReformUnit[]
}

/**
 * Options for {@link applyRegionReform}.
 */
export interface RegionReformOptions {
	/**
	 * The directory that holds every WOF clone.
	 */
	reposRoot: PathBuilderLike
	/**
	 * The directory that holds `<CC>.txt` and `admin1CodesASCII.txt`.
	 */
	geonamesDir: PathBuilderLike
	/**
	 * Report the changes and write no file.
	 */
	dryRun?: boolean
	/**
	 * The `wof:lastmodified` the changed records take, in Unix seconds.
	 */
	lastModified: number
}

/**
 * What {@link applyRegionReform} did, or would do under `dryRun`.
 */
export interface RegionReformResult {
	repoDir: string
	/**
	 * Each unit with its record's id, whether the record was written by this run, and its member count.
	 */
	units: Array<{ iso: string; name: string; id: number; written: boolean; members: number }>
	/**
	 * The replaced regions marked ceased, with their successor ids.
	 */
	ceased: Array<{ id: number; name: string; supersededBy: number[] }>
	/**
	 * Records moved to a unit, by the evidence that chose the unit.
	 */
	moved: { byMembership: number; byGeoNames: number }
	/**
	 * Moved records whose GeoNames unit differs from their member ancestor's unit.
	 */
	geonamesOverrides: number
	/**
	 * Records below a replaced region that no evidence places in a unit, left unchanged.
	 */
	unplaced: Array<{ id: number; name: string; placetype: string }>
}

interface LoadedRecord {
	path: string
	text: string
	feature: WOFRecordFeature
}

type Hierarchy = Array<Record<string, number>>

function properties(record: LoadedRecord): Record<string, unknown> {
	return record.feature.properties
}

function hierarchyOf(record: LoadedRecord): Hierarchy {
	const hierarchy = properties(record)["wof:hierarchy"]

	return Array.isArray(hierarchy) ? (hierarchy as Hierarchy) : []
}

function concordancesOf(record: LoadedRecord): Record<string, unknown> {
	const concordances = properties(record)["wof:concordances"]

	return concordances && typeof concordances === "object" ? (concordances as Record<string, unknown>) : {}
}

/**
 * Rounds every coordinate of a geometry to the forks' coordinate precision.
 */
function roundCoordinates(value: unknown): unknown {
	if (typeof value === "number") return Number(value.toFixed(DEFAULT_COORDINATE_DECIMALS))

	return Array.isArray(value) ? value.map(roundCoordinates) : value
}

/**
 * The union of the member geometries of each unit, with its centroid and bounding box.
 */
async function unionGeometries(
	members: ReadonlyMap<string, readonly LoadedRecord[]>
): Promise<
	Map<string, { geometry: WOFRecordFeature["geometry"]; bbox: WOFRecordFeature["bbox"]; centroid: [number, number] }>
> {
	using db = await openDuckDB()

	await db.run(/* sql */ `INSTALL spatial; LOAD spatial;`)
	await db.run(/* sql */ `CREATE TABLE member (unit VARCHAR, geometry GEOMETRY)`)

	for (const [unit, records] of members) {
		for (const record of records) {
			const geometry = escapeSQLString(wofGeometryJSON(record.feature.geometry))

			await db.run(
				/* sql */ `INSERT INTO member VALUES ('${escapeSQLString(unit)}', ST_MakeValid(ST_GeomFromGeoJSON('${geometry}')))`
			)
		}
	}

	const reader = await db.runAndReadAll(/* sql */ `
		SELECT unit, ST_AsGeoJSON(u) AS geometry, ST_X(ST_Centroid(u)) AS x, ST_Y(ST_Centroid(u)) AS y,
		       ST_XMin(u) AS min_x, ST_YMin(u) AS min_y, ST_XMax(u) AS max_x, ST_YMax(u) AS max_y
		FROM (SELECT unit, ST_Union_Agg(geometry) AS u FROM member GROUP BY unit)
	`)

	const unions = new Map<
		string,
		{ geometry: WOFRecordFeature["geometry"]; bbox: WOFRecordFeature["bbox"]; centroid: [number, number] }
	>()

	for (const row of reader.getRowObjects()) {
		const parsed = parseJSONStrict<WOFRecordFeature["geometry"]>(String(row.geometry))
		const round = (value: unknown) => Number(Number(value).toFixed(DEFAULT_COORDINATE_DECIMALS))

		unions.set(String(row.unit), {
			geometry: { type: parsed.type, coordinates: roundCoordinates(parsed.coordinates) },
			bbox: [round(row.min_x), round(row.min_y), round(row.max_x), round(row.max_y)],
			centroid: [round(row.x), round(row.y)],
		})
	}

	return unions
}

/**
 * Each GeoNames id of the country mapped to the GeoNames id of the first-level division it is filed under.
 */
async function geonamesFirstLevel(geonamesDir: PathBuilder, country: string): Promise<Map<number, number>> {
	const divisionOfCode = new Map<string, number>()

	for await (const fields of readUnquotedTSV(geonamesDir("admin1CodesASCII.txt"))) {
		const code = fields[0]

		if (code?.startsWith(`${country}.`)) {
			divisionOfCode.set(code.slice(country.length + 1), Number(fields[3]))
		}
	}

	const divisionOf = new Map<number, number>()

	for await (const fields of readUnquotedTSV(geonamesDir(`${country}.txt`))) {
		const division = divisionOfCode.get((fields[10] ?? "").trim())

		if (isPresent(division)) {
			divisionOf.set(Number(fields[0]), division)
		}
	}

	return divisionOf
}

function wikidataURL(item: string): string {
	return `https://www.wikidata.org/wiki/${item}`
}

/**
 * The properties a rename cites.
 *
 * A second run replaces their citations rather than adding to them.
 */
const RENAMED_PROPERTIES: ReadonlySet<string> = new Set(["wof:name", "wof:concordances"])

function sourcesOf(record: LoadedRecord): Array<Record<string, unknown>> {
	const sources = properties(record)["mailwoman:sources"]

	return Array.isArray(sources) ? (sources as Array<Record<string, unknown>>) : []
}

/**
 * A record that keeps its id and boundary and takes the name its government adopted.
 */
export interface RegionRename {
	/**
	 * The WOF id of the record.
	 */
	id: number
	/**
	 * The adopted name without its designator, `Koshi`.
	 */
	name: string
	/**
	 * The adopted name with its designator, `Koshi Province`.
	 */
	longName: string
	/**
	 * The record's Wikidata item.
	 */
	wikidata: string
	/**
	 * Names in other languages, keyed by WOF name property: `{ "name:nep_x_preferred": ["कोशी प्रदेश"] }`.
	 */
	names?: Record<string, string[]>
}

/**
 * The renames of one country's records.
 */
export interface RegionRenameSpec {
	country: string
	/**
	 * Where each adopted name was read.
	 */
	source: ReformCitation
	renames: RegionRename[]
}

/**
 * Gives each record in `spec` its adopted name, and returns each record's former name.
 *
 * The former `wof:name` and long label stay as English variants, because addresses
 * written before the adoption still use them.
 * The former `name:eng_x_preferred` is dropped: Who's On First held a bare numeral there,
 * such as `Seven`, and a numeral without the word Province identifies no place.
 *
 * @throws When a record has no file in the fork.
 */
export async function applyRegionRenames(
	spec: RegionRenameSpec,
	options: Pick<RegionReformOptions, "reposRoot" | "dryRun" | "lastModified">
): Promise<Array<{ id: number; from: string; to: string }>> {
	const repoDir = PathBuilder.from(options.reposRoot)(wofRepoName("admin", spec.country))
	const renamed: Array<{ id: number; from: string; to: string }> = []

	for (const rename of spec.renames) {
		const path = wofRecordPath(repoDir, rename.id)
		const text = await readLocalTextFile(path)
		const record: LoadedRecord = { path: path.toString(), text, feature: parseJSONStrict<WOFRecordFeature>(text) }
		const former = String(properties(record)["wof:name"] ?? "")

		const list = (key: string) => {
			const value = properties(record)[key]

			return Array.isArray(value) ? (value as string[]) : []
		}

		const variants = [
			...new Set([rename.longName, ...list("name:eng_x_variant"), former, ...list("label:eng_x_preferred_longname")]),
		].filter((variant) => variant && variant !== rename.name)

		renamed.push({ id: rename.id, from: former, to: rename.name })

		if (options.dryRun) continue

		await writeLocalTextFile(
			patchWOFRecordText(text, {
				...rename.names,
				"label:eng_x_preferred_longname": [rename.longName],
				"mailwoman:sources": [
					...sourcesOf(record).filter((source) => !RENAMED_PROPERTIES.has(String(source.property))),
					{ property: "wof:name", citation: spec.source.citation, url: wikidataURL(rename.wikidata) },
					{ property: "wof:concordances", citation: spec.source.citation, url: wikidataURL(rename.wikidata) },
				],
				"name:eng_x_preferred": [rename.name],
				"name:eng_x_variant": variants,
				"wof:concordances": { ...concordancesOf(record), "wd:id": rename.wikidata },
				"wof:lastmodified": options.lastModified,
				"wof:name": rename.name,
			}),
			path
		)
	}

	return renamed
}

/**
 * Applies `spec` to the country's admin fork under `options.reposRoot`.
 *
 * @throws When a member, an existing unit record or a replaced region has no record
 * in the fork, or a member is listed under two units.
 */
export async function applyRegionReform(
	spec: RegionReformSpec,
	options: RegionReformOptions
): Promise<RegionReformResult> {
	const reposRoot = PathBuilder.from(options.reposRoot)
	const repoName = wofRepoName("admin", spec.country)
	const repoDir = reposRoot(repoName)
	const records = new Map<number, LoadedRecord>()

	for (const path of await sortedGlob(repoDir("data"), "**/[0-9]*[0-9].geojson")) {
		const text = await readLocalTextFile(path)
		const feature = parseJSONStrict<WOFRecordFeature>(text)

		records.set(feature.id, { path, text, feature })
	}

	const required = (id: number, role: string): LoadedRecord => {
		const record = records.get(id)

		if (!record) throw new Error(`region reform ${spec.country}: ${role} ${id} has no record in ${repoDir}`)

		return record
	}

	const ceased = new Set(spec.ceased)
	const affected = new Set([...spec.ceased, ...(spec.split ?? [])])
	const unitOfMember = new Map<number, RegionReformUnit>()

	for (const unit of spec.units) {
		for (const member of unit.members) {
			required(member, `member of ${unit.iso}`)

			if (unitOfMember.has(member)) {
				throw new Error(`region reform ${spec.country}: member ${member} is listed under two units`)
			}

			unitOfMember.set(member, unit)
		}
	}

	// A WOF id is unique across every repository, so the minter reads the mailwoman range in all of them.
	const forks = await sortedGlob(reposRoot, "whosonfirst-data-*", { onlyFiles: false })
	const minted = await readMailwomanWOFRecords(forks)
	const mintedIDs = new Set(minted.map((record) => record.id))

	const writtenBefore = new Map(
		minted
			.map((record) => {
				const concordances = record.properties["wof:concordances"]

				const iso =
					concordances && typeof concordances === "object" ? (concordances as Record<string, unknown>)["iso:id"] : null

				return typeof iso === "string" ? ([iso, record.id] as const) : null
			})
			.filter(isPresent)
	)

	const idOfUnit = new Map<string, number>()

	for (const unit of spec.units) {
		let id = unit.existing ?? writtenBefore.get(unit.iso)

		if (!isPresent(id)) {
			id = nextMailwomanWOFID(mintedIDs)
			mintedIDs.add(id)
		}

		idOfUnit.set(unit.iso, id)
	}

	const unitOfGeoNames = new Map(spec.units.map((unit) => [unit.geonames, unit] as const))
	const divisionOf = await geonamesFirstLevel(PathBuilder.from(options.geonamesDir), spec.country)

	const result: RegionReformResult = {
		repoDir: repoDir.toString(),
		units: [],
		ceased: [],
		moved: { byMembership: 0, byGeoNames: 0 },
		geonamesOverrides: 0,
		unplaced: [],
	}

	/**
	 * The unit of the member whose boundary contains a record's point.
	 */
	const containing = (record: LoadedRecord): RegionReformUnit | undefined => {
		const longitude = Number(properties(record)["geom:longitude"])
		const latitude = Number(properties(record)["geom:latitude"])

		for (const [id, unit] of unitOfMember) {
			const polygons = arealPolygons(records.get(id)!.feature.geometry as Parameters<typeof arealPolygons>[0]) ?? []

			if (polygons.some((rings) => pointInPolygon(longitude, latitude, rings))) return unit
		}

		return undefined
	}

	const writes = new Map<string, string>()
	const successors = new Map<number, Set<number>>()

	// Move every record below a replaced region to its unit.
	for (const record of records.values()) {
		if (affected.has(record.feature.id)) continue

		const hierarchy = hierarchyOf(record)

		if (!hierarchy.some((branch) => affected.has(branch.region_id ?? -1))) continue

		const member = unitOfMember.get(record.feature.id)

		const ancestor = hierarchy
			.map((branch) => unitOfMember.get(branch[`${spec.memberPlacetype}_id`] ?? -1))
			.find(isPresent)

		const filed = unitOfGeoNames.get(divisionOf.get(Number(concordancesOf(record)["gn:id"])) ?? -1)
		const unit = member ?? filed ?? ancestor ?? containing(record)

		if (!unit) {
			result.unplaced.push({
				id: record.feature.id,
				name: String(properties(record)["wof:name"] ?? ""),
				placetype: String(properties(record)["wof:placetype"] ?? ""),
			})

			continue
		}

		const unitID = idOfUnit.get(unit.iso)!
		const replaced = new Set<number>()

		const moved = hierarchy.map((branch) => {
			if (!affected.has(branch.region_id ?? -1) || branch.region_id === unitID) return branch

			replaced.add(branch.region_id!)

			return { ...branch, region_id: unitID }
		})

		// A record below a split region that stays in it keeps its file as it is.
		if (!replaced.size) continue

		if (member || !filed) {
			result.moved.byMembership++
		} else {
			result.moved.byGeoNames++
		}

		if (!member && filed && ancestor && filed !== ancestor) {
			result.geonamesOverrides++
		}

		for (const old of replaced) {
			if (member && ceased.has(old)) {
				successors.set(old, (successors.get(old) ?? new Set()).add(unitID))
			}
		}

		const belongsTo = properties(record)["wof:belongsto"]
		const parent = properties(record)["wof:parent_id"]

		writes.set(
			record.path,
			patchWOFRecordText(record.text, {
				"wof:hierarchy": moved,
				...(Array.isArray(belongsTo)
					? { "wof:belongsto": [...new Set(belongsTo.map((id) => (replaced.has(id) ? unitID : id)))] }
					: {}),
				...(typeof parent === "number" && replaced.has(parent) ? { "wof:parent_id": unitID } : {}),
				"wof:lastmodified": options.lastModified,
			})
		)
	}

	// Mark each replaced region ceased.
	for (const id of spec.ceased) {
		const record = required(id, "replaced region")
		const name = String(properties(record)["wof:name"] ?? "")

		// A region an earlier run marked ceased keeps its successors: its members have moved
		// since, so this run can no longer read them.
		if (properties(record)["mz:is_current"] === 0 && properties(record)["edtf:cessation"] === spec.cessation) {
			const before = properties(record)["wof:superseded_by"]

			result.ceased.push({ id, name, supersededBy: Array.isArray(before) ? (before as number[]) : [] })

			continue
		}

		const supersededBy = [...(successors.get(id) ?? [])].toSorted((a, b) => a - b)

		result.ceased.push({ id, name, supersededBy })

		writes.set(
			record.path,
			patchWOFRecordText(record.text, {
				"edtf:cessation": spec.cessation,
				"mz:is_current": 0,
				"wof:superseded_by": supersededBy,
				"wof:lastmodified": options.lastModified,
			})
		)
	}

	// Write or keep each unit's record.
	const membersOfUnit = new Map(
		spec.units
			.filter((unit) => unit.members.length > 0)
			.map((unit) => [unit.iso, unit.members.map((id) => required(id, "member"))] as const)
	)

	const unions = await unionGeometries(membersOfUnit)
	const newRecords: WOFRecordFeature[] = []

	/**
	 * The citation of a geometry drawn as the union of a unit's members.
	 */
	const geometrySource = (unit: RegionReformUnit, members: readonly LoadedRecord[]) => ({
		property: "geometry",
		citation:
			`The union of the Who's On First ${spec.memberPlacetype} records ` +
			`${members.map((member) => `${properties(member)["wof:name"]} (${member.feature.id})`).join(", ")}. ` +
			spec.sources.membership.citation +
			(unit.note ? ` ${unit.note}` : ""),
		...(spec.sources.membership.url ? { url: spec.sources.membership.url } : {}),
	})

	for (const unit of spec.units) {
		const id = idOfUnit.get(unit.iso)!
		const english = unit.english ?? unit.name
		const longName = spec.designator ? `${english} ${spec.designator}` : null

		result.units.push({
			iso: unit.iso,
			name: unit.name,
			id,
			written: !isPresent(unit.existing),
			members: unit.members.length,
		})

		if (isPresent(unit.existing)) {
			const record = required(unit.existing, `existing record of ${unit.iso}`)
			const remaining = unions.get(unit.iso)
			const kept = membersOfUnit.get(unit.iso) ?? []
			const total = (key: string) => kept.reduce((all, member) => all + Number(properties(member)[key] ?? 0), 0)

			writes.set(
				record.path,
				patchWOFRecordText(
					record.text,
					{
						"wof:concordances": { ...concordancesOf(record), "iso:code": unit.iso, "iso:id": unit.iso },
						"wof:concordances_official": "iso:code",
						"wof:lastmodified": options.lastModified,
						...(remaining
							? {
									"mailwoman:sources": [
										...sourcesOf(record).filter((source) => source.property !== "geometry"),
										geometrySource(unit, kept),
									],
									"geom:area": Number(total("geom:area").toFixed(6)),
									"geom:area_square_m": total("geom:area_square_m"),
									"geom:bbox": remaining.bbox.join(","),
									"geom:latitude": remaining.centroid[1],
									"geom:longitude": remaining.centroid[0],
									"wof:geomhash": wofGeometryHash(remaining.geometry),
								}
							: {}),
					},
					remaining
				)
			)

			continue
		}

		const members = membersOfUnit.get(unit.iso)!
		const union = unions.get(unit.iso)

		if (!union) throw new Error(`region reform ${spec.country}: ${unit.iso} has no member geometry`)

		const branch = hierarchyOf(members[0]!)[0] ?? {}
		const country = branch.country_id

		const supersedes = [
			...new Set(
				members.flatMap((member) =>
					hierarchyOf(member)
						.map((b) => b.region_id)
						.filter(isPresent)
				)
			),
		]
			.filter((region) => ceased.has(region))
			.toSorted((a, b) => a - b)

		const sum = (key: string) => members.reduce((total, member) => total + Number(properties(member)[key] ?? 0), 0)
		const [longitude, latitude] = union.centroid

		// A second run keeps a unit's record as the first run wrote it.
		// Its members have moved since, so the province they came from can no longer be read from them.
		if (writtenBefore.has(unit.iso)) {
			result.units.at(-1)!.written = false

			continue
		}

		newRecords.push({
			id,
			type: "Feature",
			properties: {
				"edtf:cessation": "uuuu",
				"edtf:inception": spec.inception,
				"geom:area": Number(sum("geom:area").toFixed(6)),
				"geom:area_square_m": sum("geom:area_square_m"),
				"geom:bbox": union.bbox.join(","),
				"geom:latitude": latitude,
				"geom:longitude": longitude,
				"iso:country": spec.country,
				...unit.names,
				...(longName ? { "label:eng_x_preferred_longname": [longName] } : {}),
				"mailwoman:sources": [
					{ property: "wof:placetype", ...spec.sources.law },
					{ property: "wof:name", ...spec.sources.units },
					{ property: "wof:concordances", ...spec.sources.units },
					geometrySource(unit, members),
				],
				"mz:hierarchy_label": 1,
				"mz:is_current": 1,
				"name:eng_x_preferred": [english],
				"name:eng_x_variant": [longName, ...(unit.variants ?? [])].filter(isPresent),
				"src:geom": String(properties(members[0]!)["src:geom"] ?? "whosonfirst"),
				"wof:belongsto": [branch.continent_id, country].filter(isPresent),
				"wof:breaches": [],
				"wof:concordances": {
					"gn:id": unit.geonames,
					"iso:code": unit.iso,
					"iso:id": unit.iso,
					"wd:id": unit.wikidata,
				},
				"wof:concordances_official": "iso:code",
				"wof:country": spec.country,
				"wof:geomhash": wofGeometryHash(union.geometry),
				"wof:hierarchy": [
					{
						...(isPresent(branch.continent_id) ? { continent_id: branch.continent_id } : {}),
						...(isPresent(country) ? { country_id: country } : {}),
						region_id: id,
					},
				],
				"wof:id": id,
				"wof:lastmodified": options.lastModified,
				"wof:name": unit.name,
				"wof:parent_id": country ?? -1,
				"wof:placetype": "region",
				"wof:repo": repoName,
				"wof:superseded_by": [],
				"wof:supersedes": supersedes,
				"wof:tags": [],
			},
			bbox: union.bbox,
			geometry: union.geometry,
		})
	}

	if (!options.dryRun) {
		for (const [path, text] of writes) {
			await writeLocalTextFile(text, path)
		}

		for (const record of newRecords) {
			await writeWOFRecord(repoDir, record)
		}
	}

	return result
}
