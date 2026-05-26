/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Piscina worker for WOF prepare — reads GeoJSON files, extracts structured fields via
 *   pluckPlacetypeSpec, and upserts into PlacetypeDataSource (SQLite) for classifier mini-DBs.
 *
 *   When `unifiedDbPath` is set, also writes to a unified SQLite (spr, names, concordances,
 *   place_population) for the FST builder and resolver.
 */

import {
	DataSourceCache,
	pluckPlacetypeSpec,
	type PlacetypeRecord,
	type WOFFeature,
} from "@mailwoman/core/resources/whosonfirst"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { PathBuilder } from "path-ts"

const DATA_DIRECTORY = PathBuilder.from(process.env.WOF_DATA_DIR || "/tmp/wof-placetype-dbs")

const ADMIN_PLACETYPES = new Set([
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

const cache = new DataSourceCache()

let unifiedDb: DatabaseSync | null = null
let sprInsert: ReturnType<DatabaseSync["prepare"]> | null = null
let namesInsert: ReturnType<DatabaseSync["prepare"]> | null = null
let concordancesInsert: ReturnType<DatabaseSync["prepare"]> | null = null
let populationInsert: ReturnType<DatabaseSync["prepare"]> | null = null

function ensureUnifiedDb(path: string): void {
	if (unifiedDb) return
	unifiedDb = new DatabaseSync(path, { open: true })
	unifiedDb.exec("PRAGMA journal_mode = WAL")
	unifiedDb.exec("PRAGMA busy_timeout = 10000")
	unifiedDb.exec("PRAGMA synchronous = OFF")

	sprInsert = unifiedDb.prepare(`
		INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	namesInsert = unifiedDb.prepare(`
		INSERT INTO names (id, name, placetype, country, language, lastmodified)
		VALUES (?, ?, ?, ?, ?, ?)
	`)
	concordancesInsert = unifiedDb.prepare(`
		INSERT INTO concordances (id, other_id, other_source, lastmodified)
		VALUES (?, ?, ?, ?)
	`)
	populationInsert = unifiedDb.prepare(`
		INSERT OR REPLACE INTO place_population (id, population)
		VALUES (?, ?)
	`)
}

export interface WorkerInput {
	filePaths: string[]
	unifiedDbPath?: string
}

export interface WorkerOutput {
	processed: number
	skipped: number
}

async function processFiles(input: WorkerInput): Promise<WorkerOutput> {
	let processed = 0
	let skipped = 0

	if (input.unifiedDbPath) {
		ensureUnifiedDb(input.unifiedDbPath)
	}

	if (unifiedDb) unifiedDb.exec("BEGIN TRANSACTION")

	try {
		for (const filePath of input.filePaths) {
			if (filePath.includes("-alt-")) {
				skipped++
				continue
			}

			const fileContent = readFileSync(filePath, "utf8")
			const feature: WOFFeature = JSON.parse(fileContent)

			const superseded_by = feature.properties["wof:superseded_by"]
			if (superseded_by && superseded_by.length !== 0) {
				skipped++
				continue
			}

			const { localizedPropMap, placetype, ...props } = pluckPlacetypeSpec(feature.properties)

			// --- Mini-DB path (unchanged) ---
			for (const [languageCode, nameKindMap] of localizedPropMap) {
				const ds = cache.open({ placetype, languageCode, dataDirectory: DATA_DIRECTORY })

				const record: PlacetypeRecord = {
					id: props.id,
					src: props.src,
					parent_id: props.parent_id,
					name: props.name,
					preferred: nameKindMap.get("preferred") ?? null,
					variant: nameKindMap.get("variant") ?? null,
					colloquial: nameKindMap.get("colloquial") ?? null,
					abbr: nameKindMap.get("abbr") ?? null,
					short: nameKindMap.get("short") ?? null,
				}

				await ds.upsert(record)
			}

			if (localizedPropMap.size === 0) {
				const ds = cache.open({ placetype, languageCode: "eng", dataDirectory: DATA_DIRECTORY })
				const record: PlacetypeRecord = {
					id: props.id,
					src: props.src,
					parent_id: props.parent_id,
					name: props.name,
					preferred: null,
					variant: null,
					colloquial: null,
					abbr: null,
					short: null,
				}
				await ds.upsert(record)
			}

			// --- Unified DB path ---
			if (unifiedDb && ADMIN_PLACETYPES.has(placetype)) {
				const lm = props.lastmodified ?? 0

				sprInsert!.run(
					props.id,
					props.parent_id,
					props.name,
					placetype,
					props.country ?? "",
					props.latitude ?? 0,
					props.longitude ?? 0,
					props.isCurrent === false ? 0 : 1,
					props.isDeprecated ? 1 : 0,
					props.isCeased ? 1 : 0,
					props.isSuperseded ? 1 : 0,
					props.isSuperseding ? 1 : 0,
					lm
				)

				for (const [languageCode, nameKindMap] of localizedPropMap) {
					const preferred = nameKindMap.get("preferred")
					if (preferred) {
						namesInsert!.run(props.id, preferred, placetype, props.country ?? "", languageCode, lm)
					}
					const variant = nameKindMap.get("variant")
					if (variant && variant !== preferred) {
						namesInsert!.run(props.id, variant, placetype, props.country ?? "", languageCode, lm)
					}
				}

				if (props.concordances) {
					for (const [source, value] of Object.entries(props.concordances)) {
						concordancesInsert!.run(props.id, String(value), source, lm)
					}
				}

				if (props.population && props.population > 0) {
					populationInsert!.run(props.id, props.population)
				}
			}

			processed++
		}

		if (unifiedDb) unifiedDb.exec("COMMIT")
	} catch (err) {
		if (unifiedDb) {
			try {
				unifiedDb.exec("ROLLBACK")
			} catch {
				// Rollback may fail if no transaction is active
			}
		}
		throw err
	}

	return { processed, skipped }
}

export default processFiles
