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
 *   Each record's fields come from `pluckPlacetypeSpec` and its point from `wofRecordPoint`,
 *   the readers the admin ingest uses, so the `wof` and `gazetteer` tiles agree on both.
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
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/values/json"
import { type DisposableDuckDB, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"
import { Globerator } from "spliterator/node/fs"

import { isCeasedRecord } from "#tools/pipeline/admin/former-divisions"
import { ADMIN_PLACETYPES } from "#tools/pipeline/admin/ingest-wof"
import { repositoryPatterns } from "#tools/pipeline/admin/polygons"
import {
	assignSyntheticIDs,
	overtureCountryList,
	overtureDivisionCondition,
	overtureDivisionsGlob,
	OVERTURE_ANONYMOUS_SECRET,
} from "#tools/pipeline/admin/sources/overture"
import { extractParsedWOFFeature, wofRecordPoint } from "#tools/pipeline/admin/wof/feature"
import { DEFAULT_RELEASE } from "#tools/pipeline/poi/defaults"
import { DEFAULT_ADMIN_DB, DEFAULT_OVERTURE_COUNTRIES } from "#tools/pipeline/recipe/defaults"
import { storedRecordNames } from "#tools/pipeline/wof/slim"
import type { WOFFeature } from "#whosonfirst"
import { type ParsedWOFPlacetype, pluckPlacetypeSpec } from "#whosonfirst/placetypes/admin"
import { openWOFRecordStoreReader, refreshWOFRecordStore, wofRecordStorePathFor } from "#whosonfirst/record-store"

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
	/**
	 * The WOF record store the export refreshes over the clones and reads successor names from.
	 *
	 * @defaultValue the store {@linkcode wofRecordStorePathFor} assigns the clones
	 */
	recordStore?: PathBuilderLike
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
	/**
	 * Records the admin intake leaves out: a superseded duplicate, or a placetype it doesn't ingest.
	 */
	notIngested: number
	deprecated: number
	/**
	 * Records written with `is_ceased`, by the former-divisions rule.
	 */
	ceased: number
	unreadable: number
	/**
	 * Parquet files written, across both types.
	 */
	files: number
	/**
	 * The GeoJSON text length of the boundaries written, in characters.
	 */
	geometryBytes: number
}

/**
 * The rows one Parquet file holds at most.
 */
const FILE_ROW_LIMIT = 50_000

/**
 * The GeoJSON characters one staged batch holds at most, so a batch of country
 * boundaries stays within memory.
 */
const FILE_GEOMETRY_BYTE_LIMIT = 256 * 1024 * 1024

/**
 * The rows per Parquet row group.
 *
 * The tile build skips a row group whose `bbox` statistics lie outside its bounds, and records
 * arrive in repository order, so a small group keeps one group to one part of one country.
 */
const ROW_GROUP_SIZE = 2000

/**
 * The two row types an export writes, each to its own hive directory.
 */
const ROW_TYPES = ["boundary", "point"] as const

type RowType = (typeof ROW_TYPES)[number]

/**
 * One staged row: the record's fields as the admin ingest reads them, and its geometry as GeoJSON text.
 */
interface StagedRow {
	place: ParsedWOFPlacetype
	/**
	 * Whether the record is ceased by the rule the former-divisions table applies (`isCeasedRecord`).
	 */
	ceased: boolean
	geometry: string
}

/**
 * The staging tables of one export, flushed to a Parquet file per type when either limit is reached.
 *
 * DuckDB parses each geometry and computes its extent, as the gazetteer export does.
 */
class ParquetStage {
	readonly #db: DisposableDuckDB
	readonly #out: string
	#rows: Record<RowType, StagedRow[]> = { boundary: [], point: [] }
	#geometryBytes = 0
	#part = 0
	files = 0

	constructor(db: DisposableDuckDB, out: string) {
		this.#db = db
		this.#out = out
	}

	add(type: RowType, row: StagedRow): void {
		this.#rows[type].push(row)
		this.#geometryBytes += row.geometry.length
	}

	get full(): boolean {
		return (
			this.#rows.boundary.length + this.#rows.point.length >= FILE_ROW_LIMIT ||
			this.#geometryBytes >= FILE_GEOMETRY_BYTE_LIMIT
		)
	}

	async flush(): Promise<void> {
		const part = String(this.#part++).padStart(5, "0")

		for (const type of ROW_TYPES) {
			const rows = this.#rows[type]

			if (!rows.length) continue

			await this.#db.run(/* sql */ `
				CREATE OR REPLACE TEMP TABLE staged (
					id BIGINT, parent_id BIGINT, name VARCHAR, placetype VARCHAR, country VARCHAR,
					is_current BOOLEAN, is_deprecated BOOLEAN, is_superseded BOOLEAN, is_ceased BOOLEAN,
					population BIGINT, geojson VARCHAR
				)
			`)

			const appender = await this.#db.createAppender("staged")

			for (const { place, ceased, geometry } of rows) {
				appender.appendBigInt(BigInt(place.id))
				appender.appendBigInt(BigInt(place.parent_id))
				appender.appendVarchar(place.name ?? "")
				appender.appendVarchar(place.placetype ?? "")
				appender.appendVarchar(place.country ?? "")

				if (place.isCurrent == null) {
					appender.appendNull()
				} else {
					appender.appendBoolean(place.isCurrent)
				}

				appender.appendBoolean(place.isDeprecated)
				appender.appendBoolean(place.isSuperseded)
				appender.appendBoolean(ceased)

				if (typeof place.population === "number" && Number.isSafeInteger(place.population)) {
					appender.appendBigInt(BigInt(place.population))
				} else {
					appender.appendNull()
				}

				appender.appendVarchar(geometry)
				appender.endRow()
			}

			appender.closeSync()

			const directory = PathBuilder.from(this.#out, "rowset=wof", `type=${type}`)

			await makeDirectories(directory)

			const file = PathBuilder.from(directory, `part-${part}.parquet`).toString()

			await this.#db.run(/* sql */ `
				COPY (
					SELECT id, parent_id, name, placetype, country, 'whosonfirst' AS source,
						is_current, is_deprecated, is_superseded, is_ceased, population,
						{'xmin': ST_XMin(geometry), 'xmax': ST_XMax(geometry),
						 'ymin': ST_YMin(geometry), 'ymax': ST_YMax(geometry)} AS bbox,
						geometry
					FROM (SELECT *, ST_GeomFromGeoJSON(geojson) AS geometry FROM staged)
				) TO '${escapeSQLString(file)}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})
			`)

			this.files++
		}

		this.#rows = { boundary: [], point: [] }
		this.#geometryBytes = 0
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
		${OVERTURE_ANONYMOUS_SECRET}
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
 * Writes the records of the clones the admin intake keeps to GeoParquet, and reports what it read.
 *
 * Each record passes through the intake's own decision, `extractParsedWOFFeature`
 * over {@linkcode ADMIN_PLACETYPES} with successor names from the WOF record store,
 * so the export holds the records the gazette is built from.
 * Each kept record is written with its `is_deprecated`, `is_current` and `is_ceased` flags,
 * so the tiles can sort deprecated and former records from candidates.
 */
export async function exportWOFGeoParquet(
	options: ExportWOFGeoParquetOptions
): Promise<{ out: string; counts: WOFGeoParquetCounts }> {
	const out = PathBuilder.from(options.out).toString()
	const reposDir = options.reposDir ?? wofReposPath
	const storePath = options.recordStore ?? wofRecordStorePathFor(reposDir)
	const placetypes = options.postcodes ? new Set([...ADMIN_PLACETYPES, "postalcode"]) : ADMIN_PLACETYPES

	await refreshWOFRecordStore(storePath, reposDir)

	using store = openWOFRecordStoreReader(storePath)

	const namesOf = storedRecordNames(store)

	const counts: WOFGeoParquetCounts = {
		read: 0,
		boundaries: 0,
		points: 0,
		withoutPoint: 0,
		notIngested: 0,
		deprecated: 0,
		ceased: 0,
		unreadable: 0,
		files: 0,
		geometryBytes: 0,
	}

	const paths = Globerator.from(repositoryPatterns(options), {
		cwd: reposDir,
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

		const { properties, geometry } = feature

		if (!properties || !Number.isSafeInteger(properties["wof:id"])) {
			counts.unreadable++

			continue
		}

		if (!extractParsedWOFFeature({ properties }, placetypes, namesOf)) {
			counts.notIngested++

			continue
		}

		const place = pluckPlacetypeSpec(properties)
		const ceased = isCeasedRecord(properties)

		counts.deprecated += Number(place.isDeprecated)
		counts.ceased += Number(ceased)

		if (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") {
			const boundary = stringifyJSON(geometry)

			stage.add("boundary", { place, ceased, geometry: boundary })

			counts.boundaries++
			counts.geometryBytes += boundary.length
		}

		const point = wofRecordPoint(properties)

		if (point) {
			stage.add("point", {
				place,
				ceased,
				geometry: stringifyJSON({ type: "Point", coordinates: [point.longitude, point.latitude] }),
			})

			counts.points++
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
