/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build `localities-cz-districts.db` — the Prague municipal-district locality shard (the `Praha 9`
 *   class the #42 coherence pass names as unrepresentable: the pair rung needs a LOCALITY row to
 *   cohere with, and WOF carries essentially none of Prague's městské části — one row, measured
 *   2026-08-12, before this shard).
 *
 *   SOURCE + LICENSE: the GeoNames CZ places file (`<data-root>/geonames/CZ.txt`, CC-BY 4.0,
 *   attribution GeoNames) — rows whose name matches `Praha \d+` (the 22 administrative districts),
 *   the A-feature (administrative-division) row preferred per name. Same unified-schema shape as the
 *   LINZ NZ shard (#1617), so the candidate build's `localities` fold consumes it as-is; same
 *   provenance discipline (`shard_meta` + source md5).
 *
 *   Verified against the eu-mixed panel (2026-08-12 test rebuild): `Chabeřická 585, 19016 Praha 9`
 *   moved from a 6,733 km US answer to CZ at ~400 m — the postcode row was ALWAYS in the artifact;
 *   this shard supplies the locality half the pair rung needed.
 *
 *   Run: mailwoman gazetteer build cz-districts [--source <CZ.txt>] [--out <localities-cz-districts.db>]
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { removePathIfPresent } from "@mailwoman/core/fs/writers"
import { dataRootPath } from "@mailwoman/core/utils"
import { md5Hex } from "@mailwoman/core/utils/hash"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase, swapDatabaseIntoPlace } from "@mailwoman/sqlite/sealed-db"

/**
 * Synthetic id base — distinct from the GeoNames postal range (9500000000000), the NL PC6 range (9600000000000), and
 * the NZ locality range (9700000000000).
 */
const CZ_DISTRICT_ID_BASE = 9_800_000_000_000

export interface BuildCZDistrictsOptions {
	/**
	 * The GeoNames CZ places file. Default `<data-root>/geonames/CZ.txt`.
	 */
	sourcePath?: string
	/**
	 * Output shard. Default `<data-root>/wof/localities-cz-districts.db`.
	 */
	out?: string
}

/**
 * Build the sealed CZ-districts shard. NOT re-exported from a barrel — the command lazy-imports it (optional-peer
 * discipline, same as the NL PC6 and NZ builders).
 */
export async function buildCZDistrictsShard(
	opts: BuildCZDistrictsOptions = {}
): Promise<{ out: string; inserted: number; sourceMD5: string }> {
	const { createUnifiedIndexes, createUnifiedSchema } = await import("@mailwoman/resolver-wof-sqlite/unified-schema")
	const { buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite")
	const sourcePath = opts.sourcePath ?? String(dataRootPath("geonames", "CZ.txt"))
	const outPath = opts.out ?? String(dataRootPath("wof", "localities-cz-districts.db"))
	const tmpPath = `${outPath}.tmp`

	const raw = await readLocalTextFile(sourcePath)
	const sourceMD5 = md5Hex(raw)

	// GeoNames places format: 0=geonameid 1=name 2=asciiname … 4=lat 5=lon 6=featureClass 7=featureCode.
	const byName = new Map<string, { name: string; lat: number; lon: number; feature: string }>()

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- CZ.txt is ~3 MB and bounded (one country's places); the whole file is already resident for the md5.
	for (const line of raw.split("\n")) {
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- a single bounded GeoNames row.
		const cols = line.split("\t")

		if (!/^Praha \d+$/.test(cols[1] ?? "")) continue
		const lat = Number(cols[4])
		const lon = Number(cols[5])

		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
		const row = { name: cols[1]!, lat, lon, feature: `${cols[6]}.${cols[7]}` }
		const prev = byName.get(row.name)

		// One row per district: the administrative-division row (feature A.*) wins over PPLX duplicates.
		if (!prev || (row.feature.startsWith("A") && !prev.feature.startsWith("A"))) {
			byName.set(row.name, row)
		}
	}

	await removePathIfPresent(tmpPath)

	let inserted = 0

	{
		using db = new DatabaseClient<WOFDatabase>(tmpPath)
		db.exec("PRAGMA journal_mode = OFF")
		db.exec("PRAGMA synchronous = OFF")
		await createUnifiedSchema(db)

		db.exec(`CREATE TABLE shard_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`)
		const meta = db.prepare(`INSERT INTO shard_meta VALUES (?, ?)`)
		meta.run("source", "GeoNames CZ places file (Praha district rows)")
		meta.run("license", "CC-BY-4.0, attribution GeoNames")
		meta.run("source_md5", sourceMD5)
		meta.run("selection", String.raw`name ~ ^Praha \d+$, A-feature preferred per name`)

		const sprInsert = db.prepare(
			`INSERT OR REPLACE INTO spr (id, parent_id, name, placetype, country, latitude, longitude, min_latitude, min_longitude, max_latitude, max_longitude, is_current, is_deprecated, is_ceased, is_superseded, is_superseding, lastmodified) VALUES (?, -1, ?, 'locality', 'CZ', ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0, 0)`
		)

		const namesInsert = db.prepare(
			`INSERT INTO names (id, name, placetype, country, language, lastmodified) VALUES (?, ?, 'locality', 'CZ', '', 0)`
		)

		db.exec("BEGIN")

		for (const r of [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
			const id = CZ_DISTRICT_ID_BASE + inserted
			sprInsert.run(id, r.name, r.lat, r.lon, r.lat, r.lon, r.lat, r.lon)
			namesInsert.run(id, r.name)

			inserted++
		}

		db.exec("COMMIT")
		await createUnifiedIndexes(db)
		buildPlaceSearchFTS(db, { drop: true })
		db.exec("ANALYZE")
	}

	await swapDatabaseIntoPlace(tmpPath, outPath)
	await sealDatabase(outPath)

	return { out: outPath, inserted, sourceMD5 }
}
