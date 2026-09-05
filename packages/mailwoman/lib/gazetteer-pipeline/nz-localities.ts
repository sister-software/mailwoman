/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `localities-nz-linz.db` — the NZ suburb/locality database (#1564, the NZ lane's coverage
 *   gap; #1585's data half). The candidate gazetteer carries NZ's region + major-locality tiers but
 *   NO suburb tier, so `Stanmore Bay` (a ~6k-person Auckland suburb) has no row and the resolver
 *   can only mis-answer or abstain.
 *
 *   SOURCE + LICENSE: the LINZ-derived OpenAddresses NZ countrywide extract
 *   (`<data-root>/openaddresses/extracted/nz/countrywide.csv`) — upstream is LINZ "NZ Street
 *   Address" via OpenAddresses, CC-BY 4.0 with attribution to Land Information New Zealand (the
 *   same lane the country-evidence runbook already ships pair-index data from). NOT derived from
 *   any Nominatim import — the ODbL comparison arm stays a comparison arm. The build refuses to run
 *   unless the source's md5 sidecar matches, and stamps source md5 + vintage into the database's
 *   `database_meta` table so provenance travels with the artifact.
 *
 *   SHAPE: one `spr` row per (CITY, DISTRICT) group — the CITY column is the address's
 *   suburb/locality line, and 49 names span more than one district (`Hillsborough` is both an
 *   Auckland and a Christchurch suburb), so the group key is the pair. Coordinates are the MEDIAN
 *   address point (robust against depot-coded outliers); the bbox is the group's p5–p95 envelope.
 *   Placetype is `locality`: that is the tier NZ addressing puts the suburb on, and the tier a bare
 *   parsed toponym queries — a `neighbourhood` row would be invisible to the locality filter group,
 *   and widening THAT group is a global ranking change this database must not smuggle in. Population
 *   is deliberately 0/unmeasured (meaning-of-zero: an address-point count is not a population), so
 *   a database row ranks behind any populated namesake and wins only where its key is the answer.
 *
 *   Run: mailwoman gazetteer build nz-localities [--csv <countrywide.csv>] [--out <localities-nz-linz.db>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/hash"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"
import { CSVSpliterator } from "spliterator"

/**
 * Synthetic id base — distinct from the GeoNames postal range (9500000000000) and the NL PC6 range (9600000000000).
 */
const NZ_LOCALITY_ID_BASE = 9_700_000_000_000

/**
 * Minimum address points a (CITY, DISTRICT) group needs before it earns a database row. Below this the "centroid" is a
 * handful of rural delivery points and the name is as likely a farm check as a locality; 5 keeps 3,000-odd real
 * localities and drops the tail of one-off strings.
 */
const MIN_GROUP_POINTS = 5

/**
 * NZ geographic sanity envelope, WGS-84 — generous around the mainland plus the Chathams (~-44, -176.5) and the
 * subantarctic islands (Campbell Island ~-52.5). A point outside it is source noise (a wrong-hemisphere or null-island
 * row), not a New Zealand address.
 */
const NZ_LAT_MIN = -53
const NZ_LAT_MAX = -29
const NZ_LON_MIN = 160
const NZ_LON_MAX = 180

export interface BuildNZLocalitiesOptions {
	/**
	 * The LINZ-derived OpenAddresses NZ countrywide CSV. Default
	 * `<data-root>/openaddresses/extracted/nz/countrywide.csv`.
	 */
	csvPath?: string
	/**
	 * Output database. Default `<data-root>/wof/localities-nz-linz.db`.
	 */
	out?: string
}

/**
 * Title-case comparison surface for the CSV's already-title-cased CITY values — the database stores the display form
 * verbatim and lets `normalizeLocalityForKey` (at candidate-build time) own the key.
 */
function cleanName(raw: string | undefined): string {
	return (raw ?? "").trim().replaceAll(/\s+/g, " ")
}

/**
 * The p-th percentile of a SORTED numeric array (nearest-rank, p in [0, 100]).
 *
 * DELIBERATELY NOT `@mailwoman/core/utils`'s `percentileSorted`: this copy uses the ceil-based nearest rank
 * (`ceil(p/100 · n) − 1`) the shipped NZ label points were computed with, where core floors (`floor(p/100 · n)`) —
 * swapping conventions moves a percentile by up to one member row and with it every derived label point.
 *
 * Repo-health-ignore private-name-shadows-export -- the ceil-based nearest rank the shipped NZ label points were
 * computed with; core floors
 */
function percentileSorted(sorted: readonly number[], p: number): number {
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))

	return sorted[idx]!
}

/**
 * Build the sealed NZ locality database. NOT re-exported from a barrel — the command lazy-imports it (optional-peer
 * discipline, same as the NL PC6 builder).
 */
export async function buildNZLocalitiesDatabase(
	opts: BuildNZLocalitiesOptions = {}
): Promise<{ out: string; inserted: number; skippedGroups: number; sourceMD5: string }> {
	const { createUnifiedIndexes, createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
	const { buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite")
	const csvPath = opts.csvPath ?? String(dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv"))
	const outPath = opts.out ?? String(dataRootPath("wof", "localities-nz-linz.db"))
	const tmpPath = `${outPath}.tmp`

	// Provenance check: the md5 sidecar must exist and match. A database whose source cannot be named is
	// exactly the artifact the provenance discipline forbids.
	const sourceMD5 = md5Hex(await readLocalBuffer(csvPath))

	const sidecar = (await readLocalTextFile(`${csvPath}.md5`)).trim().split(/\s+/)[0]

	if (sidecar !== sourceMD5) {
		throw new Error(`source md5 mismatch: computed ${sourceMD5}, sidecar ${sidecar} — re-verify the extract`)
	}

	// Pass 1 — aggregate (CITY, DISTRICT) → coordinate lists. ~2.1M rows; two float arrays per group.
	const groups = new Map<string, { city: string; district: string; lats: number[]; lons: number[] }>()
	let header: string[] | undefined

	for await (const cols of CSVSpliterator.fromAsync(csvPath, { header: false })) {
		if (!header) {
			header = cols.map((c) => String(c))

			if (header.join(",") !== "LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE,ID,HASH") {
				throw new Error(`unexpected CSV header: ${header.join(",")}`)
			}

			continue
		}

		const lon = Number(cols[0])
		const lat = Number(cols[1])
		const city = cleanName(cols[5])
		const district = cleanName(cols[6])

		if (!city || !Number.isFinite(lat) || !Number.isFinite(lon)) continue

		if (lat < NZ_LAT_MIN || lat > NZ_LAT_MAX || lon < NZ_LON_MIN || lon > NZ_LON_MAX) continue

		const key = `${city}\0${district}`
		let g = groups.get(key)

		if (!g) {
			g = { city, district, lats: [], lons: [] }
			groups.set(key, g)
		}

		g.lats.push(lat)
		g.lons.push(lon)
	}

	await removePathIfPresent(tmpPath)
	const db = new DatabaseClient<WOFDatabase>(tmpPath)
	db.exec("PRAGMA journal_mode = OFF")
	db.exec("PRAGMA synchronous = OFF")
	await createUnifiedSchema(db)

	// Provenance stamp — travels with the artifact (the coverage register's basis/vintage discipline).
	db.exec(`CREATE TABLE database_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
	const meta = db.prepare(`INSERT INTO database_meta VALUES (?, ?)`)
	meta.run("source", "LINZ NZ Street Address via OpenAddresses (nz/countrywide)")
	meta.run("license", "CC-BY-4.0, attribution Land Information New Zealand")
	meta.run("source_md5", sourceMD5)
	meta.run("source_vintage", "2021-10-21 (extract mtime); md5-sidecar verified")
	meta.run("min_group_points", String(MIN_GROUP_POINTS))

	const sprInsert = db.prepare(
		`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'locality', 'NZ', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
	)

	const namesInsert = db.prepare(
		`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'locality', 'NZ', '', 0)`
	)

	let inserted = 0
	let skippedGroups = 0
	db.exec("BEGIN")

	for (const g of [...groups.values()].toSorted(
		(a, b) => a.city.localeCompare(b.city) || a.district.localeCompare(b.district)
	)) {
		if (g.lats.length < MIN_GROUP_POINTS) {
			skippedGroups++

			continue
		}

		g.lats.sort((a, b) => a - b)
		g.lons.sort((a, b) => a - b)
		const lat = percentileSorted(g.lats, 50)
		const lon = percentileSorted(g.lons, 50)
		const id = NZ_LOCALITY_ID_BASE + inserted

		sprInsert.run(
			id,
			g.city,
			lat,
			lon,
			percentileSorted(g.lats, 5),
			percentileSorted(g.lons, 5),
			percentileSorted(g.lats, 95),
			percentileSorted(g.lons, 95)
		)

		namesInsert.run(id, g.city)

		inserted++
	}

	db.exec("COMMIT")
	await createUnifiedIndexes(db)
	buildPlaceSearchFTS(db, { drop: true })
	db.exec("ANALYZE")
	await db.destroy()

	swapDatabaseIntoPlace(tmpPath, outPath)
	await sealDatabase(outPath)

	return { out: outPath, inserted, skippedGroups, sourceMD5 }
}
