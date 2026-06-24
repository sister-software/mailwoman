/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Incrementally add one or more countries' admin coverage to an EXISTING `admin-global-priority.db`
 *   from the Overture `divisions` theme — WITHOUT a full `build-unified-wof` re-ingest.
 *
 *   Why this exists: the canonical admin gazetteer is built from the cloned WOF repos + a hand-listed
 *   `--overture-countries` set, so a country that's on neither (e.g. CA) is simply absent. A full
 *   rebuild can add it, but reproducing the exact WOF-repo inputs is error-prone (a sibling repo
 *   not re-globbed silently drops coverage). This path is safe by construction: it COPIES the
 *   frozen live DB (every existing country preserved), backfills only the requested countries from
 *   Overture's global divisions theme (reusing `ingestOvertureDivisions` — the same code the full
 *   build uses), re-runs the freeze (ancestors closure, coincident_roles, indexes), and VACUUMs to
 *   a new file. The country-gate rides `spr.country` (set on every Overture row), so resolution
 *   works immediately.
 *
 *   Run: node --experimental-strip-types scripts/augment-admin-overture.ts\
 *   --in /mnt/playpen/mailwoman-data/wof/admin-global-priority.db\
 *   --out /mnt/playpen/mailwoman-data/wof/admin-global-priority-ca.db\
 *   --countries CA [--release 2026-06-17.0]
 */

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import type { WofDatabase } from "@mailwoman/resolver-wof-sqlite"
import { buildCoincidentRoles } from "@mailwoman/resolver-wof-sqlite/coincident-roles"
import { buildPlaceSearchFts } from "@mailwoman/resolver-wof-sqlite/fts"
import { createUnifiedIndexes, populateAncestors } from "@mailwoman/resolver-wof-sqlite/unified-schema"
import { haversineKm } from "@mailwoman/spatial"
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ingestOvertureDivisions } from "./build-unified-wof.ts"

/**
 * Set `place_population` for Overture-backfilled cities from a GeoNames cities dump (tab-separated:
 * geonameid, name, asciiname, altnames, lat, lon, fclass, fcode, country, …, population at index
 * 14). Match each GeoNames city by name/asciiname + country against the `names` table, nearest
 * centroid within 50 km. ONLY touches Overture rows (`id >= 2e9`; WOF ids are < 2e9, so their
 * populations are left intact). This is what lets a major foreign city outrank its small US homonym
 * — without a population the cascade ranks Moscow RU below Moscow, Idaho.
 */
async function applyGeoNamesPopulation(db: DatabaseSync, citiesFile: string): Promise<number> {
	// The match probe stays a reused prepared statement (read-heavy loop). The WRITE goes through a
	// typed DatabaseClient<WofDatabase> upsert, so `place_population`'s columns are checked against the
	// shared schema the reader uses.
	const kdb = new DatabaseClient<WofDatabase>({ database: db })
	const findByName = db.prepare(
		"SELECT n.id AS id, s.latitude AS lat, s.longitude AS lon FROM names n JOIN spr s ON n.id = s.id WHERE n.name = ? AND n.country = ? AND n.id >= 2000000000"
	)
	const lines = readFileSync(citiesFile, "utf8").split("\n")
	// id → population; last write wins, matching the original INSERT OR REPLACE (also dedupes two
	// GeoNames cities that match the same place).
	const pops = new Map<number, number>()
	for (const line of lines) {
		if (!line) continue
		const f = line.split("\t")
		const lat = Number(f[4])
		const lon = Number(f[5])
		const country = f[8]
		const pop = Number(f[14])
		if (!pop || !country || !Number.isFinite(lat)) continue
		let best: number | null = null
		let bestD = Infinity
		for (const nm of new Set([f[1], f[2]].filter(Boolean))) {
			for (const r of findByName.all(nm, country) as Array<{ id: number; lat: number; lon: number }>) {
				const d = haversineKm(lat, lon, Number(r.lat), Number(r.lon))
				if (d < bestD) {
					bestD = d
					best = Number(r.id)
				}
			}
		}
		if (best != null && bestD < 50) pops.set(best, pop)
	}

	const rows = [...pops].map(([id, population]) => ({ id, population }))
	for (let i = 0; i < rows.length; i += 1000) {
		await kdb
			.insertInto("place_population")
			.values(rows.slice(i, i + 1000))
			.onConflict((oc) => oc.column("id").doUpdateSet({ population: (eb) => eb.ref("excluded.population") }))
			.execute()
	}
	return pops.size
}

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const IN = arg("in", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const OUT = arg("out")
const COUNTRIES = arg("countries")
	.split(",")
	.map((c) => c.trim().toUpperCase())
	.filter(Boolean)
const RELEASE = arg("release", "2026-06-17.0")
const GEONAMES = arg("geonames") // optional GeoNames cities dump → population for the backfilled cities

if (!OUT || COUNTRIES.length === 0) {
	console.error(
		"Usage: augment-admin-overture.ts --in <admin.db> --out <new.db> --countries CA[,AU,...] [--release 2026-06-17.0]"
	)
	process.exit(1)
}

const WORK = `${OUT}.work`
if (existsSync(WORK)) unlinkSync(WORK)
console.error(`Copying ${IN} → ${WORK} (preserves all existing coverage) ...`)
copyFileSync(IN, WORK)

const db = new DatabaseSync(WORK)
// `kdb` wraps `db` for the typed read stats below (the bulk INSERTs in ingestOvertureDivisions +
// populateAncestors stay raw on the handle). MAX(COALESCE)/PRAGMA/VACUUM below also stay raw.
const kdb = new DatabaseClient<WofDatabase>({ database: db })
const before = Number(
	(
		await kdb
			.selectFrom("spr")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.executeTakeFirstOrThrow()
	).n
)

// Start synthetic ids ABOVE every id already in the DB (WOF or a prior Overture backfill) so this
// augment never collides with existing rows — a flat OVERTURE_ID_BASE would `INSERT OR REPLACE`
// straight over the EU Overture divisions.
const idBase = Number((db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM spr").get() as { m: number }).m) + 1
const n = await ingestOvertureDivisions(db, COUNTRIES, RELEASE, idBase)
console.error(`Ingested ${n.toLocaleString()} ${COUNTRIES.join(",")} divisions from Overture`)

if (GEONAMES) {
	console.error(`Applying GeoNames population from ${GEONAMES} ...`)
	const set = await applyGeoNamesPopulation(db, GEONAMES)
	console.error(`  set population on ${set.toLocaleString()} Overture cities`)
}

console.error("Re-freezing: ancestors closure ...")
populateAncestors(db)
console.error("  coincident_roles ...")
buildCoincidentRoles(db)
console.error("  indexes ...")
await createUnifiedIndexes(db)
// Rebuild the place_search FTS from the names table — the candidate's alias pass reads
// place_search.alt_names, so without this the augmented places' aliases (incl. the multilingual
// English names) never reach the candidate, and a non-Latin city resolves only by its local-script
// primary. drop:true so it includes the newly-ingested rows.
console.error("  place_search FTS (so the candidate's alias pass sees the new places) ...")
buildPlaceSearchFts(db, { drop: true })
db.exec("ANALYZE")
db.exec("PRAGMA optimize")

const after = Number(
	(
		await kdb
			.selectFrom("spr")
			.select((eb) => eb.fn.countAll<number>().as("n"))
			.executeTakeFirstOrThrow()
	).n
)
const added = await kdb
	.selectFrom("spr")
	.select((eb) => ["country", eb.fn.countAll<number>().as("n")])
	.where("country", "in", COUNTRIES)
	.groupBy("country")
	.execute()
console.error(`spr: ${before.toLocaleString()} → ${after.toLocaleString()} (+${(after - before).toLocaleString()})`)
console.error(`  added: ${added.map((r) => `${r.country}=${Number(r.n).toLocaleString()}`).join(", ")}`)

const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
if (integrity !== "ok") throw new Error(`integrity_check failed: ${integrity}`)

if (existsSync(OUT)) unlinkSync(OUT)
db.prepare("VACUUM INTO ?").run(OUT)
db.close()
if (existsSync(WORK)) unlinkSync(WORK)
console.error(`Wrote ${OUT}`)
