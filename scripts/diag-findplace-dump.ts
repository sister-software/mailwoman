/**
 * Byte-stability harness for the #289 rule-engine refactor. Dumps `findPlace` output for a fixed
 * set of DE/FR/GB/NL queries (coord-first, FTS-fallback, exact-name-tiering, conflict-flag, and
 * non-locality paths) against the real WOF DBs. Run before and after the refactor and diff — the
 * output must be byte-identical (the refactor changes dispatch shape, not behavior).
 *
 * Usage: node --experimental-strip-types scripts/diag-findplace-dump.ts >
 * /tmp/jp-probe/fp-<tag>.json
 */
import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const WOF = [
	"/mnt/playpen/mailwoman-data/wof/admin-global-priority.db",
	"/mnt/playpen/mailwoman-data/wof/postcode-locality-intl.db",
]

const backend = new WofSqlitePlaceLookup({ databasePath: WOF })

// Fixed query set spanning every findPlace branch the refactor touches.
const queries: Array<Record<string, unknown>> = [
	// coord-first, postcode in table (small town the FTS misses)
	{ text: "Plauen", country: "DE", postcode: "08523", placetype: "locality" },
	// coord-first + exact-name tiering (unambiguous big city)
	{ text: "Berlin", country: "DE", postcode: "10115", placetype: "locality" },
	// conflict flag (Munich postcode under "Berlin")
	{ text: "Berlin", country: "DE", postcode: "80331", placetype: "locality" },
	// locality, NO postcode → FTS path
	{ text: "Berlin", country: "DE", placetype: "locality" },
	// FR coord-first
	{ text: "Paris", country: "FR", postcode: "75001", placetype: "locality" },
	{ text: "Lyon", country: "FR", postcode: "69001", placetype: "locality" },
	// GB
	{ text: "Edinburgh", country: "GB", postcode: "EH1 1AA", placetype: "locality" },
	{ text: "London", country: "GB", placetype: "locality" },
	// NL coord-first
	{ text: "Amstelveen", country: "NL", postcode: "1187LM", placetype: "locality" },
	{ text: "Amsterdam", country: "NL", postcode: "1012LG", placetype: "locality" },
	// postcode NOT in table → coord-first returns null → FTS fallback
	{ text: "Berlin", country: "DE", postcode: "00000", placetype: "locality" },
	// non-locality query (region) → never coord-first
	{ text: "Bayern", country: "DE", placetype: "region" },
	// no country filter
	{ text: "Springfield", placetype: "locality" },
]

const out: unknown[] = []
for (const q of queries) {
	const cands = await backend.findPlace(q as never)
	out.push({
		q,
		candidates: cands.map((c: any) => ({
			id: c.id,
			name: c.name,
			placetype: c.placetype,
			country: c.country,
			score: c.score,
			lat: c.lat,
			lon: c.lon,
			population: c.population ?? null,
			distanceKm: c.distanceKm ?? null,
			mismatch: c.mismatch ?? null,
		})),
	})
}
console.log(JSON.stringify(out, null, 1))
backend.close?.()
process.exit(0)
