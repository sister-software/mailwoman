/**
 * Smoke test: confirm WofSqlitePlaceLookup works against our CUSTOM unified DB
 * (admin-global-priority.db) now that ancestors + FTS are built. Tests plain text lookup AND
 * ancestors-based parent-constraint scoping (the Springfield problem).
 *
 * Run: node --experimental-strip-types scripts/smoke-resolve.ts
 */
import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const DB = process.argv[2] ?? "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
const lookup = new WofSqlitePlaceLookup({ databasePath: DB })

console.log("=== plain: 'New York' (locality) ===")
console.log(
	(await lookup.findPlace({ text: "New York", placetype: "locality", country: "US", limit: 3 })).map((p) => ({
		id: p.id,
		name: p.name,
		lat: p.lat,
		lon: p.lon,
	}))
)

console.log("\n=== Springfield (ambiguous, locality) top 5 ===")
const springfields = await lookup.findPlace({ text: "Springfield", placetype: "locality", country: "US", limit: 5 })
console.log(springfields.map((p) => ({ id: p.id, name: p.name, lat: p.lat.toFixed(2), lon: p.lon.toFixed(2) })))

console.log("\n=== region: 'Illinois' ===")
const il = await lookup.findPlace({ text: "Illinois", placetype: "region", country: "US", limit: 1 })
console.log(il.map((p) => ({ id: p.id, name: p.name })))

if (il[0]) {
	console.log(`\n=== Springfield scoped to Illinois (parentId=${il[0].id}) — ancestors parent-constraint ===`)
	const scoped = await lookup.findPlace({ text: "Springfield", placetype: "locality", parentId: il[0].id, limit: 3 })
	console.log(scoped.map((p) => ({ id: p.id, name: p.name, lat: p.lat.toFixed(2), lon: p.lon.toFixed(2) })))
}
