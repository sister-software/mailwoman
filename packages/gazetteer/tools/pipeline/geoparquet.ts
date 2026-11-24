// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Exports the Who's On First clones to GeoParquet, one row per record, for the overlay tile build.
 *
 *   The files follow the layout `hrt-sources` reads from an Overture theme:
 *   a WKB `geometry` column, a `bbox` struct, scalar columns that become feature tags,
 *   and hive directories that become tags too.
 *   A record's boundary goes under `type=boundary` and its label point under `type=point`.
 *
 *   Geometry is written at the record's full resolution, because the tile build simplifies per zoom.
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import {
	GEONAMES_ID_BASE,
	MAILWOMAN_WOF_ID_BASE,
	MAILWOMAN_WOF_ID_END,
	OVERTURE_ID_BASE,
	SYNTHETIC_ID_RANGES,
} from "@mailwoman/core/resolver/synthetic-id-ranges"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { type DisposableDuckDB, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { geometryToWKB } from "@mailwoman/spatial/well-known-text"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { repositoryPatterns } from "#tools/pipeline/admin/polygons"
import {
	assignSyntheticIDs,
	overtureCountryList,
	overtureDivisionCondition,
	overtureDivisionsGlob,
} from "#tools/pipeline/admin/sources/overture"
import { DEFAULT_RELEASE } from "#tools/pipeline/poi/defaults"
import { DEFAULT_ADMIN_DB, DEFAULT_OVERTURE_COUNTRIES } from "#tools/pipeline/recipe/defaults"
import type { WOFFeature } from "#whosonfirst"

export interface ExportWOFGeoParquetOptions {
	/**
	 * The directory the export writes its `rowset=wof/` tree under.
	 */
	out: PathBuilderLike
	/**
	 * The directory that holds the `whosonfirst-data-*` clones.
	 *
	 * @defaultValue `$MAILWOMAN_CACHE_ROOT/sources/wof-repos`
	 */
	reposDir?: PathBuilderLike
	/**
	 * Lower-case country codes to read, or every country when absent.
	 */
	countries?: readonly string[]
	/**
	 * Reads each country's postcode repository as well as its admin repository.
	 */
	postcodes?: boolean
	concurrency?: number
	onProgress?: (counts: WOFGeoParquetCounts) => void
}

/**
 * What an export read and wrote.
 */
export interface WOFGeoParquetCounts {
	read: number
	/**
	 * Records whose geometry is a polygon or multipolygon.
	 */
	boundaries: number
	/**
	 * Records with a label point or a point geometry.
	 */
	points: number
	/**
	 * Records with neither a label point, a centroid property nor a point geometry.
	 */
	withoutPoint: number
	superseded: number
	deprecated: number
	unreadable: number
	/**
	 * Parquet files written, across both types.
	 */
	files: number
	geometryBytes: number
}

/**
 * The rows one Parquet file holds at most.
 */
const FILE_ROW_LIMIT = 50_000

/**
 * The WKB bytes one Parquet file holds at most, so a batch of country boundaries stays within memory.
 */
const FILE_GEOMETRY_BYTE_LIMIT = 256 * 1024 * 1024

/**
 * The rows per Parquet row group.
 *
 * The tile build skips a row group whose `bbox` statistics lie outside its bounds, and records
 * arrive in repository order, so a small group keeps one group to one part of one country.
 */
const ROW_GROUP_SIZE = 2000

const STAGING_COLUMNS = /* sql */ `
	id BIGINT, parent_id BIGINT, name VARCHAR, placetype VARCHAR, country VARCHAR, source VARCHAR,
	is_current BOOLEAN, is_deprecated BOOLEAN, is_superseded BOOLEAN,
	xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE, wkb BLOB`

/**
 * The two row types an export writes, each to its own hive directory.
 */
const ROW_TYPES = ["boundary", "point"] as const

type RowType = (typeof ROW_TYPES)[number]

/**
 * A staged row, in the order of {@linkcode STAGING_COLUMNS}.
 */
interface PlaceRow {
	id: number
	parentID: number
	name: string
	placetype: string
	country: string
	isCurrent: boolean | null
	isDeprecated: boolean
	isSuperseded: boolean
	bounds: readonly [xmin: number, ymin: number, xmax: number, ymax: number]
	wkb: Uint8Array
}

/**
 * The extent of a geometry's positions as west, south, east and north.
 */
function boundsOf(coordinates: unknown, bounds: [number, number, number, number]): [number, number, number, number] {
	if (!Array.isArray(coordinates)) return bounds

	if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
		bounds[0] = Math.min(bounds[0], coordinates[0])
		bounds[1] = Math.min(bounds[1], coordinates[1])
		bounds[2] = Math.max(bounds[2], coordinates[0])
		bounds[3] = Math.max(bounds[3], coordinates[1])

		return bounds
	}

	for (const member of coordinates) {
		boundsOf(member, bounds)
	}

	return bounds
}

/**
 * The record's label point as longitude and latitude.
 *
 * A curated label point outranks the computed centroid, and a point geometry stands in
 * when the record states neither.
 */
function labelPointOf(feature: WOFFeature): [longitude: number, latitude: number] | null {
	const properties = feature.properties

	for (const prefix of ["lbl", "geom"] as const) {
		const latitude = properties?.[`${prefix}:latitude`]
		const longitude = properties?.[`${prefix}:longitude`]

		if (typeof latitude === "number" && typeof longitude === "number") return [longitude, latitude]
	}

	const { geometry } = feature

	if (geometry?.type === "Point") {
		const [longitude, latitude] = geometry.coordinates as number[]

		if (typeof latitude === "number" && typeof longitude === "number") return [longitude, latitude]
	}

	return null
}

/**
 * The staging tables of one export, flushed to a Parquet file per type when either limit is reached.
 */
class ParquetStage {
	private readonly db: DisposableDuckDB
	private readonly out: string
	private rows: Record<RowType, PlaceRow[]> = { boundary: [], point: [] }
	private geometryBytes = 0
	private part = 0
	files = 0

	constructor(db: DisposableDuckDB, out: string) {
		this.db = db
		this.out = out
	}

	add(type: RowType, row: PlaceRow): void {
		this.rows[type].push(row)
		this.geometryBytes += row.wkb.byteLength
	}

	get full(): boolean {
		return (
			this.rows.boundary.length + this.rows.point.length >= FILE_ROW_LIMIT ||
			this.geometryBytes >= FILE_GEOMETRY_BYTE_LIMIT
		)
	}

	async flush(): Promise<void> {
		const part = String(this.part++).padStart(5, "0")

		for (const type of ROW_TYPES) {
			const rows = this.rows[type]

			if (!rows.length) continue

			await this.db.run(/* sql */ `CREATE OR REPLACE TEMP TABLE staged (${STAGING_COLUMNS})`)

			const appender = await this.db.createAppender("staged")

			for (const row of rows) {
				appender.appendBigInt(BigInt(row.id))
				appender.appendBigInt(BigInt(row.parentID))
				appender.appendVarchar(row.name)
				appender.appendVarchar(row.placetype)
				appender.appendVarchar(row.country)
				appender.appendVarchar("whosonfirst")

				if (row.isCurrent == null) {
					appender.appendNull()
				} else {
					appender.appendBoolean(row.isCurrent)
				}

				appender.appendBoolean(row.isDeprecated)
				appender.appendBoolean(row.isSuperseded)

				for (const edge of row.bounds) {
					appender.appendDouble(edge)
				}

				appender.appendBlob(row.wkb)
				appender.endRow()
			}

			appender.closeSync()

			const directory = PathBuilder.from(this.out, "rowset=wof", `type=${type}`)

			await makeDirectories(directory)

			const file = PathBuilder.from(directory, `part-${part}.parquet`).toString()

			await this.db.run(/* sql */ `
				COPY (
					SELECT id, parent_id, name, placetype, country, source, is_current, is_deprecated, is_superseded,
						{'xmin': xmin, 'xmax': xmax, 'ymin': ymin, 'ymax': ymax} AS bbox,
						ST_GeomFromWKB(wkb) AS geometry
					FROM staged
				) TO '${escapeSQLString(file)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})
			`)

			this.files++
		}

		this.rows = { boundary: [], point: [] }
		this.geometryBytes = 0
	}
}

export interface ExportGazetteerGeoParquetOptions {
	/**
	 * The directory the export writes its `rowset=gazetteer/` tree under.
	 */
	out: PathBuilderLike
	/**
	 * The export directory whose `rowset=wof/type=boundary` files supply Who's On First boundaries.
	 *
	 * @defaultValue `out`
	 */
	wofExport?: PathBuilderLike
	/**
	 * The admin database whose `spr` rows are the row set.
	 *
	 * @defaultValue `<data-root>/db/wof/admin-global-priority.db`
	 */
	adminPath?: PathBuilderLike
	/**
	 * The countries the admin build folded from Overture.
	 * A division's synthetic id depends on the whole list.
	 *
	 * @defaultValue `DEFAULT_OVERTURE_COUNTRIES`
	 */
	overtureCountries?: readonly string[]
	/**
	 * The Overture release the admin build folded.
	 *
	 * @defaultValue the gazetteer's pinned release
	 */
	overtureRelease?: string
	/**
	 * Leaves Overture unread, for a run without network access.
	 * Overture places then have no boundary.
	 */
	skipOverture?: boolean
	/**
	 * Lower-case country codes whose places are written, or every country when absent.
	 */
	countries?: readonly string[]
	onPhase?: (phase: string, detail?: string) => void
}

/**
 * What a gazetteer export wrote.
 */
export interface GazetteerGeoParquetCounts {
	places: number
	/**
	 * Boundary rows by the dataset the boundary came from.
	 */
	boundaries: Record<string, number>
	extents: number
	/**
	 * Places whose id lies in the Overture range.
	 */
	overturePlaces: number
	/**
	 * The count of those places whose id matched a division of the release.
	 */
	overturePlacesMapped: number
}

/**
 * An SQL expression giving the dataset a place id belongs to, read from the `id` column.
 */
function sourceOfIDExpression(): string {
	const ranges = SYNTHETIC_ID_RANGES.toSorted((a, b) => b.base - a.base)
		.map(({ name, base }) => `WHEN id >= ${base} THEN '${name}'`)
		.join(" ")

	return /* sql */ `CASE ${ranges}
		WHEN id >= ${MAILWOMAN_WOF_ID_BASE} AND id < ${MAILWOMAN_WOF_ID_END} THEN 'mailwoman-wof'
		ELSE 'whosonfirst' END`
}

/**
 * Writes the combined gazetteer's places to GeoParquet: every `spr` row of the admin database
 * as a point and as its stored extent, and each place's boundary where a source holds one.
 *
 * A Who's On First place takes its boundary from the `wof` export by id.
 * An Overture place takes the union of its division's land areas.
 * A place from another dataset has no boundary to read.
 *
 * @throws When the admin database holds Overture places and none of them maps to a division.
 * The countries or release then differ from the ones the admin build folded.
 */
export async function exportGazetteerGeoParquet(
	options: ExportGazetteerGeoParquetOptions
): Promise<{ out: string; counts: GazetteerGeoParquetCounts }> {
	const out = PathBuilder.from(options.out).toString()
	const target = PathBuilder.from(out, "rowset=gazetteer")
	const adminPath = PathBuilder.from(options.adminPath ?? wofDatabasePath(DEFAULT_ADMIN_DB)).toString()

	const wofBoundaries = PathBuilder.from(
		options.wofExport ?? out,
		"rowset=wof",
		"type=boundary",
		"*.parquet"
	).toString()

	const countries = options.overtureCountries ?? DEFAULT_OVERTURE_COUNTRIES
	const release = options.overtureRelease ?? DEFAULT_RELEASE
	const phase = options.onPhase ?? (() => {})

	using db = await openDuckDB()

	await db.run(/* sql */ `
		INSTALL spatial; LOAD spatial; INSTALL sqlite; LOAD sqlite; INSTALL httpfs; LOAD httpfs;
		SET s3_region='us-west-2';
		ATTACH '${escapeSQLString(adminPath)}' AS admin (TYPE sqlite, READ_ONLY);
		CREATE TEMP TABLE overture_area (id BIGINT, geometry GEOMETRY);
		CREATE TEMP TABLE overture_ids (gers VARCHAR, id BIGINT);
	`)

	const scalar = async (sql: string): Promise<number> => Number((await db.runAndReadAll(sql)).getRows()[0]?.[0] ?? 0)

	const overturePlaces = await scalar(
		/* sql */ `SELECT count(*) FROM admin.spr WHERE id >= ${OVERTURE_ID_BASE} AND id < ${GEONAMES_ID_BASE}`
	)

	let overturePlacesMapped = 0

	if (overturePlaces && !options.skipOverture) {
		phase("overture-ids", `${countries.length} countries @ ${release}`)

		const divisions = await db.runAndReadAll(/* sql */ `
			SELECT d.id FROM read_parquet('${overtureDivisionsGlob(release, "division")}') d
			WHERE ${overtureDivisionCondition(countries)}
		`)

		const ids = assignSyntheticIDs(divisions.getRows().map(([gers]) => String(gers)))
		const appender = await db.createAppender("overture_ids")

		for (const [gers, id] of ids) {
			appender.appendVarchar(gers)
			appender.appendBigInt(BigInt(id))
			appender.endRow()
		}

		appender.closeSync()

		overturePlacesMapped = await scalar(/* sql */ `SELECT count(*) FROM admin.spr s JOIN overture_ids m ON m.id = s.id`)

		if (!overturePlacesMapped) {
			throw new Error(
				`None of the ${overturePlaces} Overture places in ${adminPath} maps to a division of release ${release}. ` +
					`The admin build folded other countries or another release.`
			)
		}

		phase("overture-areas", `${overturePlacesMapped} of ${overturePlaces} places mapped`)

		await db.run(/* sql */ `
			INSERT INTO overture_area
			SELECT m.id, ST_Union_Agg(a.geometry)
			FROM read_parquet('${overtureDivisionsGlob(release, "division_area")}') a
			JOIN overture_ids m ON m.gers = a.division_id
			JOIN admin.spr s ON s.id = m.id
			WHERE a.country IN (${overtureCountryList(countries)}) AND a.class = 'land'
			GROUP BY m.id
		`)
	}

	await makeDirectories(target)

	const place = /* sql */ `
		SELECT id, parent_id, name, placetype, country, ${sourceOfIDExpression()} AS source,
			is_current = 1 AS is_current, is_deprecated = 1 AS is_deprecated, is_superseded = 1 AS is_superseded,
			latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude
		FROM admin.spr
		${options.countries ? `WHERE upper(country) IN (${overtureCountryList(options.countries.map((code) => code.toUpperCase()))})` : ""}`

	const columns = "id, parent_id, name, placetype, country, source, is_current, is_deprecated, is_superseded"
	const copyOptions = `(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`

	const fileOf = (type: string) =>
		escapeSQLString(PathBuilder.from(target, `type=${type}`, "part-00000.parquet").toString())

	for (const type of ["point", "extent", "boundary"]) {
		await makeDirectories(PathBuilder.from(target, `type=${type}`))
	}

	phase("points")

	await db.run(/* sql */ `
		COPY (
			SELECT ${columns},
				{'xmin': longitude, 'xmax': longitude, 'ymin': latitude, 'ymax': latitude} AS bbox,
				ST_Point(longitude, latitude) AS geometry
			FROM (${place}) ORDER BY country, id
		) TO '${fileOf("point")}' ${copyOptions}
	`)

	phase("extents")

	await db.run(/* sql */ `
		COPY (
			SELECT ${columns},
				{'xmin': min_longitude, 'xmax': max_longitude, 'ymin': min_latitude, 'ymax': max_latitude} AS bbox,
				ST_MakeEnvelope(min_longitude, min_latitude, max_longitude, max_latitude) AS geometry
			FROM (${place})
			WHERE min_longitude < max_longitude AND min_latitude < max_latitude
			ORDER BY country, id
		) TO '${fileOf("extent")}' ${copyOptions}
	`)

	phase("boundaries")

	await db.run(/* sql */ `
		COPY (
			SELECT ${columns.replaceAll(/(\w+)/g, "p.$1")}, boundary_source,
				{'xmin': ST_XMin(b.geometry), 'xmax': ST_XMax(b.geometry),
				 'ymin': ST_YMin(b.geometry), 'ymax': ST_YMax(b.geometry)} AS bbox,
				b.geometry
			FROM (${place}) p
			JOIN (
				SELECT id, geometry, 'whosonfirst' AS boundary_source FROM read_parquet('${escapeSQLString(wofBoundaries)}')
				UNION ALL
				SELECT id, geometry, 'overture' AS boundary_source FROM overture_area
			) b ON b.id = p.id
			ORDER BY p.country, p.id
		) TO '${fileOf("boundary")}' ${copyOptions}
	`)

	phase("counts")

	const counted = async (type: string, group: string) =>
		(
			await db.runAndReadAll(/* sql */ `SELECT ${group}, count(*) FROM read_parquet('${fileOf(type)}') GROUP BY 1`)
		).getRows()

	const boundaries: Record<string, number> = {}

	for (const [source, count] of await counted("boundary", "boundary_source")) {
		boundaries[String(source)] = Number(count)
	}

	return {
		out,
		counts: {
			places: await scalar(/* sql */ `SELECT count(*) FROM read_parquet('${fileOf("point")}')`),
			boundaries,
			extents: await scalar(/* sql */ `SELECT count(*) FROM read_parquet('${fileOf("extent")}')`),
			overturePlaces,
			overturePlacesMapped,
		},
	}
}

/**
 * The record's `mz:is_current` as a boolean, or null when the record leaves it unknown.
 */
function isCurrentOf(value: unknown): boolean | null {
	const flag = Number(value)

	return flag === 1 ? true : flag === 0 ? false : null
}

/**
 * Writes every record of the clones to GeoParquet and reports what it read.
 *
 * A superseded or deprecated record is written with its flag set, so the tiles can show it.
 */
export async function exportWOFGeoParquet(
	options: ExportWOFGeoParquetOptions
): Promise<{ out: string; counts: WOFGeoParquetCounts }> {
	const out = PathBuilder.from(options.out).toString()

	const counts: WOFGeoParquetCounts = {
		read: 0,
		boundaries: 0,
		points: 0,
		withoutPoint: 0,
		superseded: 0,
		deprecated: 0,
		unreadable: 0,
		files: 0,
		geometryBytes: 0,
	}

	const paths = Globerator.from(repositoryPatterns(options), {
		cwd: options.reposDir ?? wofReposPath,
		absolute: true,
		exclude: ["**/*-alt-*"],
		// A clone can be a symbolic link into the repositories directory, as the US admin clone is.
		followSymlinks: true,
	})

	using db = await openDuckDB()

	await db.run(/* sql */ `INSTALL spatial; LOAD spatial;`)

	const stage = new ParquetStage(db, out)
	const reads = parallelMap(paths, (path) => readLocalTextFile(path), { concurrency: options.concurrency ?? 64 })

	for await (const text of reads) {
		counts.read++

		if (counts.read % 100_000 === 0) {
			options.onProgress?.({ ...counts, files: stage.files })
		}

		let feature: WOFFeature

		try {
			feature = parseJSONStrict<WOFFeature>(text)
		} catch {
			counts.unreadable++

			continue
		}

		const properties = feature.properties
		const id = Number(properties?.["wof:id"] ?? feature.id)

		if (!Number.isSafeInteger(id)) {
			counts.unreadable++

			continue
		}

		const isSuperseded = Boolean(properties?.["wof:superseded_by"]?.length)
		const isDeprecated = Boolean(properties?.["edtf:deprecated"])

		counts.superseded += Number(isSuperseded)
		counts.deprecated += Number(isDeprecated)

		const parentID = Number(properties?.["wof:parent_id"])

		const shared = {
			id,
			parentID: Number.isSafeInteger(parentID) ? parentID : -1,
			name: String(properties?.["wof:name"] ?? ""),
			placetype: String(properties?.["wof:placetype"] ?? ""),
			country: String(properties?.["wof:country"] ?? ""),
			isCurrent: isCurrentOf(properties?.["mz:is_current"]),
			isDeprecated,
			isSuperseded,
		}

		const { geometry } = feature

		if (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") {
			const wkb = geometryToWKB(geometry)

			stage.add("boundary", {
				...shared,
				bounds: boundsOf(geometry.coordinates, [Infinity, Infinity, -Infinity, -Infinity]),
				wkb,
			})

			counts.boundaries++
			counts.geometryBytes += wkb.byteLength
		}

		const point = labelPointOf(feature)

		if (point) {
			const [longitude, latitude] = point
			const wkb = geometryToWKB({ type: "Point", coordinates: point })

			stage.add("point", { ...shared, bounds: [longitude, latitude, longitude, latitude], wkb })

			counts.points++
			counts.geometryBytes += wkb.byteLength
		} else {
			counts.withoutPoint++
		}

		if (stage.full) {
			await stage.flush()
		}
	}

	await stage.flush()

	counts.files = stage.files

	return { out, counts }
}
