/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds one region's address layer, `lookup.db` and `detail.db`, from a stream of address records.
 *
 *   Records are staged once into a scratch database with one row per key they answer. Each key table is then
 *   written in key order with `INSERT … SELECT … ORDER BY`, so its B-tree pages hold contiguous keys.
 */

import { makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { sourcePresentCoverageCells } from "@mailwoman/core/layers"
import { type LayerManifest, writeLayerCoverage, writeLayerManifest } from "@mailwoman/core/layers/manifest"
import { createLayerCoverageTable, createLayerManifestTable } from "@mailwoman/core/layers/schema"
import { shortCellToInt } from "@mailwoman/spatial"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { buildSealedArtifact } from "@mailwoman/sqlite/sealed/build"
import { latLngToCell } from "@sister.software/h3"
import { type Kysely, sql } from "kysely"
import { basename, dirname, resolvePath, type PathBuilderLike } from "path-ts"

import {
	ADDRESS_DUPLICATE_STACK_LIMIT,
	type AddressDuplicateRule,
	type DuplicateCandidate,
	isDuplicateAddress,
} from "#address/duplicate"
import { addressPostcodeKey } from "#address/keys/postcode"
import {
	ADDRESS_SCOPED_KEY_TABLES,
	ADDRESS_STREET_TABLES,
	type AddressDetailDatabase,
	type AddressLookupDatabase,
	createAddressDetailTable,
	createAddressPlaceKeyTable,
	createAddressRegionKeyTable,
	createAddressScopedKeyTable,
	createAddressSourceTable,
	createAddressStreetTable,
} from "#address/keys/schema"
import type { AddressRecord } from "#address/record"
import { addressPointStacksSQL } from "#address/stack"

/**
 * The SQLite page size of both files.
 *
 * At 8 KiB a key hit read 4 pages in 3 range chunks on the Wisconsin prototype.
 */
export const ADDRESS_LAYER_PAGE_SIZE = 8192

/**
 * The H3 resolution `layer_coverage` counts points at, about 36 km² per cell.
 */
export const ADDRESS_LAYER_COVERAGE_RESOLUTION = 6

/**
 * The provenance a caller states for the layer it builds.
 *
 * The build supplies the schema version, the spine keys and the per-source record counts.
 */
export type AddressLayerManifest = Omit<LayerManifest, "schemaVersion" | "spineKeys" | "sourceRecords">

/**
 * The level each staged key row answers.
 * Each level is written to the key table of the same name.
 */
const StagedLevel = {
	Postcode: "key_postcode",
	Locality: "key_locality",
	Subregion: "key_subregion",
	Region: "key_region",
} as const

type StagedLevel = (typeof StagedLevel)[keyof typeof StagedLevel]

/**
 * The scratch schema: every key row an address answers, and every address's detail row.
 */
interface StagingDatabase extends AddressDetailDatabase {
	stage: {
		level: StagedLevel
		scope: string
		street: string
		number: string
		address_id: number
		lat: number
		lon: number
		source_id: number
	}
	source_ids: {
		name: string
		source_id: number
	}
}

/**
 * One keyed read a build must answer: a street and number under one level's scope.
 *
 * `scope` is ignored for `key_region`, which has none.
 */
export interface AddressLayerReadCheck {
	table: StagedLevel
	scope: string
	street: string
	number: string
}

/**
 * What a source's rows are published under, from the register.
 */
export interface AddressSourceTerms {
	license: string | null
	authority: string | null
}

export interface BuildAddressLayerOptions {
	records: AsyncIterable<AddressRecord>
	/**
	 * The terms of each source id the records hold.
	 * A record whose source has no entry stops the build.
	 */
	sources: ReadonlyMap<string, AddressSourceTerms>
	/**
	 * The `layer_manifest` row `lookup.db` holds.
	 */
	manifest: AddressLayerManifest
	/**
	 * Keyed reads the finished `lookup.db` must answer before it is sealed,
	 * such as a known address at each level.
	 */
	checks?: readonly AddressLayerReadCheck[]
	lookupPath: PathBuilderLike
	detailPath: PathBuilderLike
	/**
	 * Where the staging database is written, the largest file a build makes.
	 *
	 * It defaults to beside `lookupPath`.
	 * A directory on another disk keeps that file off the layer's disk.
	 */
	stagingDirectory?: PathBuilderLike
	/**
	 * Called after every millionth record with the count staged so far.
	 */
	onProgress?: (records: number) => void
	/**
	 * Returns why a record is left out of the layer, such as `outside-subdivision`, or `null` to keep it.
	 *
	 * Each refusal is counted in the summary under its source and reason.
	 */
	refuseRecord?: (record: AddressRecord) => string | null
	/**
	 * The most distinct street-and-number pairs one source may place at one point, rounded to 1e-5 degrees.
	 *
	 * The records at a point over this limit are left out under the reason `stacked-point`.
	 *
	 * @defaultValue {@linkcode ADDRESS_LAYER_STACK_LIMIT}
	 */
	stackLimit?: number
	/**
	 * Drops each record that repeats a higher-ranked source's record of the same postcode key,
	 * by {@link isDuplicateAddress}, under the reason `duplicate`.
	 * Without it every source's record is kept.
	 */
	duplicates?: AddressDuplicateRule
}

/**
 * The most distinct addresses one source may place at one point before the layer refuses them all.
 *
 * Across the 2026-11-08 US layer, point counts fall bin by bin from 2 to 1,000 addresses per point,
 * and four points lie above 1,000: two hold 1,004 and 1,653 addresses, and two hold 10,525 and 12,868.
 */
export const ADDRESS_LAYER_STACK_LIMIT = 1000

/**
 * The counts one build wrote.
 * Its checks compare them against the tables.
 */
export interface AddressLayerBuildSummary {
	records: number
	/**
	 * Key rows written per key table.
	 */
	keys: Record<StagedLevel, number>
	/**
	 * Records per source id.
	 */
	sources: Record<string, number>
	/**
	 * Locality names per record, the duplication the per-form keys cost.
	 */
	localityFormsPerRecord: number
	/**
	 * Points per H3 cell at {@link ADDRESS_LAYER_COVERAGE_RESOLUTION}, keyed by the cell's short integer form.
	 */
	coverage: ReadonlyMap<number, number>
	/**
	 * Records left out of the layer, per source id and reason.
	 */
	refused: Record<string, Record<string, number>>
}

async function createStagingTables(db: Kysely<StagingDatabase>): Promise<void> {
	await db.schema
		.createTable("stage")
		.addColumn("level", "text", (c) => c.notNull())
		.addColumn("scope", "text", (c) => c.notNull())
		.addColumn("street", "text", (c) => c.notNull())
		.addColumn("number", "text", (c) => c.notNull())
		.addColumn("address_id", "integer", (c) => c.notNull())
		.addColumn("lat", "real", (c) => c.notNull())
		.addColumn("lon", "real", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.execute()

	await db.schema
		.createTable("source_ids")
		.addColumn("name", "text", (c) => c.notNull())
		.addColumn("source_id", "integer", (c) => c.notNull())
		.execute()

	await createAddressDetailTable(db)
}

/**
 * Stages every record, then writes `lookup.db` and `detail.db` beside their targets
 * and swaps each into place.
 *
 * @throws When a record's source has no entry in `sources`, or when a key table's
 * row count differs from the rows staged for its level.
 */
export async function buildAddressLayer(options: BuildAddressLayerOptions): Promise<AddressLayerBuildSummary> {
	const stagingName = `${basename(options.lookupPath.toString())}.stage-${process.pid}`

	const stagingPath = options.stagingDirectory
		? resolvePath(options.stagingDirectory, stagingName)
		: `${options.lookupPath}.stage-${process.pid}`

	if (options.stagingDirectory) {
		await makeDirectories(options.stagingDirectory)
	}

	await Promise.all([makeDirectories(dirname(options.lookupPath)), makeDirectories(dirname(options.detailPath))])
	await removePathIfPresent(stagingPath)

	try {
		const summary = await stageRecords(options, stagingPath)

		await writeLookup(options.lookupPath, stagingPath, summary, options.sources, options.manifest, options.checks ?? [])
		await writeDetail(options.detailPath, stagingPath, summary)

		return summary
	} finally {
		await removePathIfPresent(stagingPath)
	}
}

async function stageRecords(options: BuildAddressLayerOptions, stagingPath: string): Promise<AddressLayerBuildSummary> {
	using db = new DatabaseClient<StagingDatabase>(stagingPath)

	db.exec(
		`PRAGMA page_size = ${ADDRESS_LAYER_PAGE_SIZE}; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -400000;`
	)

	await createStagingTables(db)

	const stage = db.prepare("INSERT INTO stage VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
	const detail = db.prepare("INSERT INTO address VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
	const sourceIDs = new Map<string, number>()
	const keys: Record<StagedLevel, number> = { key_postcode: 0, key_locality: 0, key_subregion: 0, key_region: 0 }
	const sources: Record<string, number> = {}
	const coverage = new Map<number, number>()
	const refused: Record<string, Record<string, number>> = {}
	let records = 0
	let localityNames = 0

	const refuse = (source: string, reason: string, count = 1) => {
		const bySource = (refused[source] ??= {})

		bySource[reason] = (bySource[reason] ?? 0) + count
	}

	db.exec("BEGIN")

	for await (const record of options.records) {
		if (!options.sources.has(record.source)) {
			throw new Error(
				`address record ${record.sourceRecordID} has source ${record.source}, which the build lists no terms for`
			)
		}

		const reason = options.refuseRecord?.(record)

		if (reason) {
			refuse(record.source, reason)

			continue
		}

		let sourceID = sourceIDs.get(record.source)

		if (sourceID == null) {
			sourceID = sourceIDs.size + 1
			sourceIDs.set(record.source, sourceID)
		}

		const addressID = ++records

		sources[record.source] = (sources[record.source] ?? 0) + 1

		const put = (level: StagedLevel, scope: string) => {
			stage.run(level, scope, record.streetKey, record.number, addressID, record.lat, record.lon, sourceID)

			keys[level]++
		}

		const postcode = addressPostcodeKey(record.country, record.postcode)

		if (postcode) {
			put(StagedLevel.Postcode, postcode)
		}

		for (const name of record.names) {
			if (name.level === "locality" || name.level === "dependent_locality") {
				put(StagedLevel.Locality, name.key)

				localityNames++
			} else if (name.level === "subregion") {
				put(StagedLevel.Subregion, name.key)
			}
		}

		put(StagedLevel.Region, "")

		const cell = shortCellToInt(latLngToCell(record.lat, record.lon, ADDRESS_LAYER_COVERAGE_RESOLUTION))

		coverage.set(cell, (coverage.get(cell) ?? 0) + 1)

		detail.run(
			addressID,
			sourceID,
			record.sourceRecordID,
			record.country,
			record.number,
			record.unit,
			record.streetRaw,
			record.postcode,
			stringifyJSON(record.names.map(({ level, form, value }) => ({ level, form, value }))),
			record.adminCode,
			record.lat,
			record.lon,
			record.placement,
			record.authority
		)

		if (records % 200_000 === 0) {
			db.exec("COMMIT; BEGIN")
		}

		if (records % 1_000_000 === 0) {
			options.onProgress?.(records)
		}
	}

	db.exec("COMMIT")

	const sourceRow = db.prepare("INSERT INTO source_ids VALUES (?, ?)")

	for (const [name, id] of sourceIDs) {
		sourceRow.run(name, id)
	}

	const sourceNames = new Map([...sourceIDs].map(([name, id]) => [id, name]))

	// Removes the records a temporary table lists from the staged keys and details,
	// counts them under `reason`, and lowers the counts the build's checks compare to match.
	const drop = (table: string, reason: string) => {
		const dropped = db
			.prepare(`SELECT a.source_id, a.lat, a.lon FROM ${table} t JOIN address a USING (address_id)`)
			.all() as Array<{
			source_id: number
			lat: number
			lon: number
		}>

		for (const row of dropped) {
			const source = sourceNames.get(row.source_id)!
			const cell = shortCellToInt(latLngToCell(row.lat, row.lon, ADDRESS_LAYER_COVERAGE_RESOLUTION))
			const remaining = (coverage.get(cell) ?? 0) - 1

			if (remaining > 0) {
				coverage.set(cell, remaining)
			} else {
				coverage.delete(cell)
			}

			sources[source] = (sources[source] ?? 0) - 1
			refuse(source, reason)
		}

		for (const { level, n } of db
			.prepare(
				`SELECT level, count(*) AS n FROM stage WHERE address_id IN (SELECT address_id FROM ${table}) GROUP BY level`
			)
			.all() as Array<{ level: StagedLevel; n: number }>) {
			keys[level] -= n
		}

		db.exec(`DELETE FROM stage WHERE address_id IN (SELECT address_id FROM ${table})`)
		db.exec(`DELETE FROM address WHERE address_id IN (SELECT address_id FROM ${table})`)
		db.exec(`DROP TABLE ${table}`)
		records -= dropped.length
	}

	// A point one source shares among more than `stackLimit` addresses locates none of them.
	db.exec(`CREATE TEMP TABLE stacked AS
		SELECT address_id FROM address
		WHERE (source_id, round(lat, 5), round(lon, 5)) IN (
			SELECT source_id, la, lo FROM (${addressPointStacksSQL(options.stackLimit ?? ADDRESS_LAYER_STACK_LIMIT)}))`)

	drop("stacked", "stacked-point")

	if (options.duplicates) {
		markDuplicates(db, options.duplicates, sourceNames)
		drop("duplicate", "duplicate")
	}

	return {
		records,
		keys,
		sources,
		localityFormsPerRecord: records ? localityNames / records : 0,
		coverage,
		refused,
	}
}

/**
 * Lists in a temporary `duplicate` table every staged record that repeats a higher-ranked
 * record of its postcode key group, by {@link isDuplicateAddress}.
 * Only groups holding two or more sources are read.
 */
function markDuplicates(
	db: DatabaseClient<StagingDatabase>,
	rule: AddressDuplicateRule,
	sourceNames: ReadonlyMap<number, string>
): void {
	// SQLite rounds the points for both the stack count and the join, so a record meets its own point's count.
	db.exec(`CREATE TEMP TABLE stack AS ${addressPointStacksSQL(ADDRESS_DUPLICATE_STACK_LIMIT)}`)

	db.exec("CREATE INDEX temp.stack_point ON stack (source_id, la, lo)")
	db.exec("CREATE TEMP TABLE duplicate (address_id INTEGER PRIMARY KEY)")

	const mark = db.prepare("INSERT OR IGNORE INTO duplicate VALUES (?)")

	type Member = DuplicateCandidate & { addressID: number; rank: number }

	const settle = (group: Member[]) => {
		for (const lower of group) {
			if (group.some((higher) => higher.rank < lower.rank && isDuplicateAddress(rule, higher, lower))) {
				mark.run(lower.addressID)
			}
		}
	}

	let group: Member[] = []
	let key = ""

	db.exec("BEGIN")

	for (const row of db
		.prepare(
			`SELECT s.scope, s.street, s.number AS key_number, a.address_id, a.source_id, a.unit, a.number, a.street_raw,
				a.names, a.lat, a.lon, coalesce(k.n, 1) AS stack
			 FROM stage s JOIN address a ON a.address_id = s.address_id
			 LEFT JOIN stack k ON k.source_id = a.source_id AND k.la = round(a.lat, 5) AND k.lo = round(a.lon, 5)
			 WHERE s.level = '${StagedLevel.Postcode}' AND (s.scope, s.street, s.number) IN (
				SELECT scope, street, number FROM stage WHERE level = '${StagedLevel.Postcode}'
				GROUP BY 1, 2, 3 HAVING count(DISTINCT source_id) > 1)
			 ORDER BY s.scope, s.street, s.number`
		)
		.iterate() as Iterable<{
		scope: string
		street: string
		key_number: string
		address_id: number
		source_id: number
		unit: string | null
		number: string
		street_raw: string
		names: string
		lat: number
		lon: number
		stack: number
	}>) {
		const rowKey = `${row.scope}|${row.street}|${row.key_number}`

		if (rowKey !== key) {
			settle(group)
			group = []
			key = rowKey
		}

		const source = sourceNames.get(row.source_id)!
		const names = parseJSONStrict<Array<{ level: string; value: string }>>(row.names)

		group.push({
			addressID: row.address_id,
			rank: rule.rank(source),
			source,
			unit: row.unit,
			number: row.number,
			streetRaw: row.street_raw,
			localities: names.filter((name) => name.level === "locality").map((name) => name.value),
			lat: row.lat,
			lon: row.lon,
			stack: row.stack,
		})
	}

	settle(group)
	db.exec("COMMIT")
	db.exec("DROP TABLE stack")
}

async function writeLookup(
	lookupPath: PathBuilderLike,
	stagingPath: string,
	summary: AddressLayerBuildSummary,
	terms: ReadonlyMap<string, AddressSourceTerms>,
	manifest: AddressLayerManifest,
	checks: readonly AddressLayerReadCheck[]
): Promise<void> {
	await buildSealedArtifact<AddressLookupDatabase, true, void>({
		out: lookupPath,
		createTables: async (db) => {
			db.exec(`PRAGMA page_size = ${ADDRESS_LAYER_PAGE_SIZE}`)
			await createLayerManifestTable(db)
			await createLayerCoverageTable(db)
			await createAddressSourceTable(db)

			for (const table of ADDRESS_SCOPED_KEY_TABLES) {
				await createAddressScopedKeyTable(db, table)
			}

			await createAddressPlaceKeyTable(db)
			await createAddressRegionKeyTable(db)

			for (const table of ADDRESS_STREET_TABLES) {
				await createAddressStreetTable(db, table)
			}
		},
		ingest: async (db) => {
			db.exec(`ATTACH DATABASE '${stagingPath.replaceAll("'", "''")}' AS staged`)

			const insertSource = db.prepare("INSERT INTO source VALUES (?, ?, ?, ?, ?)")

			const ids = db.prepare("SELECT name, source_id FROM staged.source_ids ORDER BY source_id").all() as Array<{
				name: string
				source_id: number
			}>

			for (const { name, source_id } of ids) {
				const term = terms.get(name)!

				insertSource.run(source_id, name, term.license, term.authority, summary.sources[name] ?? 0)
			}

			// A record's locality and dependent-locality names can share a key,
			// so a key row repeated for one address is written once.
			for (const table of ADDRESS_SCOPED_KEY_TABLES) {
				db.exec(
					`INSERT OR IGNORE INTO ${table} SELECT scope, street, number, address_id, lat, lon, source_id
					 FROM staged.stage WHERE level = '${table}' ORDER BY scope, street, number, address_id`
				)
			}

			db.exec(
				`INSERT OR IGNORE INTO key_region SELECT street, number, address_id, lat, lon, source_id
				 FROM staged.stage WHERE level = 'key_region' ORDER BY street, number, address_id`
			)

			for (const [table, level] of [
				["street_postcode", "key_postcode"],
				["street_locality", "key_locality"],
			] as const) {
				db.exec(
					`INSERT INTO ${table} SELECT scope, street, avg(lat), avg(lon), min(lat), max(lat), min(lon), max(lon), count(*)
					 FROM staged.stage WHERE level = '${level}' GROUP BY scope, street ORDER BY scope, street`
				)
			}

			db.exec("DETACH DATABASE staged")

			return true
		},
		finish: async (db) => {
			for (const table of [...ADDRESS_SCOPED_KEY_TABLES, "key_region"] as const) {
				const { count } = (await db
					.selectFrom(table)
					.select(sql<number>`count(*)`.as("count"))
					.executeTakeFirstOrThrow()) as { count: number }

				if (count > summary.keys[table]) {
					throw new Error(`${table} holds ${count} rows, more than the ${summary.keys[table]} staged for it`)
				}
			}

			const unanswered = checks.filter((check) => {
				const row =
					check.table === StagedLevel.Region
						? db
								.prepare("SELECT 1 FROM key_region WHERE street = ? AND number = ? LIMIT 1")
								.get(check.street, check.number)
						: db
								.prepare(`SELECT 1 FROM ${check.table} WHERE scope = ? AND street = ? AND number = ? LIMIT 1`)
								.get(check.scope, check.street, check.number)

				return row == null
			})

			if (unanswered.length) {
				const listed = unanswered.map((check) => `${check.table} ${check.scope} ${check.street} ${check.number}`)

				throw new Error(`lookup.db misses ${unanswered.length} of ${checks.length} checked reads: ${listed.join("; ")}`)
			}

			await writeLayerCoverage(db, sourcePresentCoverageCells(summary.coverage))

			await writeLayerManifest(db, {
				...manifest,
				schemaVersion: 1,
				spineKeys: { h3: { column: "layer_coverage.h3_cell", resolution: ADDRESS_LAYER_COVERAGE_RESOLUTION } },
				sourceRecords: summary.sources,
			})
		},
	})
}

async function writeDetail(detailPath: PathBuilderLike, stagingPath: string, summary: AddressLayerBuildSummary) {
	await buildSealedArtifact<AddressDetailDatabase, true, void>({
		out: detailPath,
		createTables: async (db) => {
			db.exec(`PRAGMA page_size = ${ADDRESS_LAYER_PAGE_SIZE}`)
			await createAddressDetailTable(db)
		},
		ingest: async (db) => {
			db.exec(`ATTACH DATABASE '${stagingPath.replaceAll("'", "''")}' AS staged`)
			db.exec("INSERT INTO address SELECT * FROM staged.address ORDER BY address_id")
			db.exec("DETACH DATABASE staged")

			return true
		},
		finish: async (db) => {
			const { count } = (await db
				.selectFrom("address")
				.select(sql<number>`count(*)`.as("count"))
				.executeTakeFirstOrThrow()) as { count: number }

			if (count !== summary.records) {
				throw new Error(`address holds ${count} rows, against ${summary.records} records staged`)
			}
		},
	})
}
