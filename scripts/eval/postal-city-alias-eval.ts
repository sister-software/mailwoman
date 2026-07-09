/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Aggregate measurement of the #475 postal-city alias scorer — the "grade the COORDINATE, not the
 *   label" track. For every DIVERGENT alias `(postcode, postal_city → geo_locality)` in the built
 *   `postal-city-alias-<cc>.db`, we ask the resolver to find the locality for the POSTAL-city name
 *   a user would type, with the postcode in hand, and grade the resolved coordinate against the
 *   postcode's own centroid (from the postalcode shard) — an INDEPENDENT truth, not the alias
 *   table.
 *
 *   Non-circular: the input surface (the postal name) comes from the alias table, but the truth (the
 *   postcode centroid) does not, so a WRONG alias that sends the resolver to a far same-named place
 *   scores as NOT fixed. The question this answers is the only one that matters for a geocoder:
 *   does turning the alias scorer on move the resolved point CLOSER to where the postcode actually
 *   is?
 *
 *   The lever only fires where the coordinate-first path is active (the postcode has a containing
 *   locality in the `postcode_locality` shard), so the headline is reported over the LEVER-ACTIVE
 *   subset (rows where ON ≠ OFF) as well as the full divergent set.
 *
 *   Run: node scripts/eval/postal-city-alias-eval.ts\
 *   --alias-db $MAILWOMAN_DATA_ROOT/wof/postal-city-alias-us.db\
 *   --postcode-db $MAILWOMAN_DATA_ROOT/wof/postalcode-us.db\
 *   --wof
 *   $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db,$MAILWOMAN_DATA_ROOT/wof/postcode-locality-us.db\
 *   --country US [--limit 0] [--near-km 50]
 */

import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { WOFPostalCityAliasLookup, WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { haversineKm } from "@mailwoman/spatial"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		"alias-db": { type: "string" },
		country: { type: "string" },
		limit: { type: "string" },
		"near-km": { type: "string" },
		"postcode-db": { type: "string" },
		wof: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	"alias-db"?: string
	country?: string
	limit?: string
	"near-km"?: string
	"postcode-db"?: string
	wof?: string
}
const pct = (xs: number[], p: number): number => {
	if (xs.length === 0) return NaN
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

async function main(): Promise<void> {
	const aliasDBPath = values["alias-db"] || dataRootPath("wof", "postal-city-alias-us.db")
	const postcodeDBPath = values["postcode-db"] || dataRootPath("wof", "postalcode-us.db")
	const wof = (
		values["wof"] ||
		`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-us.db")}`
	).split(",")
	const country = values["country"] || "US"
	const limit = Number(values["limit"] || "0") // 0 = all
	const nearKm = Number(values["near-km"] || "50") // "resolved near the postcode" threshold

	// Truth: postcode → centroid (independent of the alias table).
	const pcDB = new DatabaseSync(postcodeDBPath, { readOnly: true })
	const centroid = new Map<string, { lat: number; lon: number }>()

	for (const r of pcDB
		.prepare("SELECT name, latitude AS lat, longitude AS lon FROM spr WHERE latitude IS NOT NULL")
		.all() as unknown as Array<{ name: string; lat: number; lon: number }>) {
		centroid.set(String(r.name), { lat: Number(r.lat), lon: Number(r.lon) })
	}
	pcDB.close()

	// The divergent alias edges to test.
	const aliasDB = new DatabaseSync(aliasDBPath, { readOnly: true })
	let rows = aliasDB
		.prepare("SELECT postcode, postal_city FROM postal_city_alias WHERE divergent = 1 ORDER BY n DESC")
		.all() as unknown as Array<{ postcode: string; postal_city: string }>
	aliasDB.close()

	if (limit > 0) {
		rows = rows.slice(0, limit)
	}

	const off = new WOFSqlitePlaceLookup({ databasePath: wof })
	const on = new WOFSqlitePlaceLookup({
		databasePath: wof,
		postalCityAliases: new WOFPostalCityAliasLookup({ databasePath: aliasDBPath }),
	})

	const distOff: number[] = []
	const distOn: number[] = []
	let tested = 0
	let leverActive = 0 // ON differs from OFF
	let fixed = 0 // OFF far, ON near
	let regressed = 0 // OFF near, ON far
	let mismOff = 0
	let mismOn = 0
	const leverDistOff: number[] = []
	const leverDistOn: number[] = []

	let i = 0

	for (const row of rows) {
		i++
		const truth = centroid.get(row.postcode)

		if (!truth) continue // no independent truth for this postcode → skip
		const q = { text: row.postal_city, placetype: "locality" as const, postcode: row.postcode, country }
		const rOff = (await off.findPlace(q))[0]
		const rOn = (await on.findPlace(q))[0]

		if (!rOff || !rOn) continue
		tested++
		const dOff = haversineKm(rOff.lat, rOff.lon, truth.lat, truth.lon)
		const dOn = haversineKm(rOn.lat, rOn.lon, truth.lat, truth.lon)
		distOff.push(dOff)
		distOn.push(dOn)

		if (rOff.mismatch) {
			mismOff++
		}

		if (rOn.mismatch) {
			mismOn++
		}
		const changed = rOff.id !== rOn.id || Math.abs(dOff - dOn) > 0.01

		if (changed) {
			leverActive++
			leverDistOff.push(dOff)
			leverDistOn.push(dOn)
		}

		if (dOff > nearKm && dOn <= nearKm) {
			fixed++
		}

		if (dOff <= nearKm && dOn > nearKm) {
			regressed++
		}

		if (i % 1000 === 0) {
			console.error(`  …${i}/${rows.length} (tested ${tested}, lever-active ${leverActive}, fixed ${fixed})`)
		}
	}
	off.close()
	on.close()

	const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "—")
	console.log(`\n# #475 postal-city alias — aggregate coordinate eval (${country})\n`)
	console.log(`Truth = postcode centroid (independent of the alias table). \`near\` threshold = ${nearKm} km.\n`)
	console.log(`- Divergent alias edges tested (with a centroid + a resolution): **${tested}**`)
	console.log(`- Lever-active (ON ≠ OFF): **${leverActive}**`)
	console.log(`- **Fixed** (OFF >${nearKm} km → ON ≤${nearKm} km): **${fixed}**`)
	console.log(`- **Regressed** (OFF ≤${nearKm} km → ON >${nearKm} km): **${regressed}**`)
	console.log(`- Mismatch flags: OFF ${mismOff} → ON ${mismOn}\n`)
	console.log(`| coord error (km) | OFF | ON |`)
	console.log(`| --- | --- | --- |`)
	console.log(`| p50 (all divergent) | ${f1(pct(distOff, 50))} | ${f1(pct(distOn, 50))} |`)
	console.log(`| p90 (all divergent) | ${f1(pct(distOff, 90))} | ${f1(pct(distOn, 90))} |`)
	console.log(`| p50 (lever-active) | ${f1(pct(leverDistOff, 50))} | ${f1(pct(leverDistOn, 50))} |`)
	console.log(`| p90 (lever-active) | ${f1(pct(leverDistOff, 90))} | ${f1(pct(leverDistOn, 90))} |`)
}

await main()
