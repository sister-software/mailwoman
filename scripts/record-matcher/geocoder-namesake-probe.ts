/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Admin-tier wrong-region probe (#619 tail) — the geocoder-vs-provided-coords eval found an
 *   admin-tier tail to 11143 km (p99 2189 km). Hypothesis: when no street shard covers the address,
 *   the admin cascade resolves the locality by NAME and (when the region/postcode constraint is
 *   weak) picks the population-dominant FOREIGN namesake — Paris→France, Athens→Greece — instead of
 *   the in-state Texas city. This probes a curated set of TX namesake cities, with and without ZIP,
 *   and flags any result outside the Texas bounding box.
 *
 *   Run: node --experimental-strip-types scripts/record-matcher/geocoder-namesake-probe.ts
 */

import { createWofResolver, type ResolverBackend } from "@mailwoman/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}
const WOF = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
const DATA_ROOT = arg("data-root", "/mnt/playpen/mailwoman-data")

// TX namesake cities with their real Texas coordinates + the famous foreign/other namesake to watch for.
const CASES: Array<{ city: string; zip: string; tx: [number, number]; namesake: string }> = [
	{ city: "Paris", zip: "75460", tx: [33.66, -95.55], namesake: "Paris, France (48.85, 2.35)" },
	{ city: "Athens", zip: "75751", tx: [32.2, -95.85], namesake: "Athens, Greece (37.98, 23.72)" },
	{ city: "Palestine", zip: "75801", tx: [31.76, -95.63], namesake: "Palestine, Levant (31.9, 35.2)" },
	{ city: "Italy", zip: "76651", tx: [32.18, -96.88], namesake: "Italy, the country (~42, 12)" },
	{ city: "Naples", zip: "75568", tx: [33.2, -94.68], namesake: "Naples, Italy (40.85, 14.27)" },
	{ city: "Dublin", zip: "76446", tx: [32.08, -98.34], namesake: "Dublin, Ireland (53.35, -6.26)" },
	{ city: "Nazareth", zip: "79063", tx: [34.54, -102.1], namesake: "Nazareth, Israel (32.7, 35.3)" },
	{ city: "Odessa", zip: "79761", tx: [31.85, -102.37], namesake: "Odessa, Ukraine (46.48, 30.72)" },
]

// Texas bounding box (generous).
const TX_BBOX = { latMin: 25.8, latMax: 36.6, lonMin: -106.7, lonMax: -93.4 }
const inTexas = (lat: number, lon: number) =>
	lat >= TX_BBOX.latMin && lat <= TX_BBOX.latMax && lon >= TX_BBOX.lonMin && lon <= TX_BBOX.lonMax


async function main(): Promise<void> {
	console.error("[A] building the geocoder…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WofSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWofResolver(lookup as unknown as ResolverBackend)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)

	const geo = (address: string) =>
		geocodeAddress(address, {
			classifier,
			resolver,
			shards: shardProvider.for,
			defaultCountry: "US",
			placeCountry: false,
		})

	console.error("[B] probing TX namesake cities (with ZIP / without ZIP)…\n")
	let wrongRegion = 0
	let total = 0
	for (const c of CASES) {
		for (const variant of [`${c.city}, TX ${c.zip}`, `${c.city}, TX`, `${c.city}, Texas`]) {
			total++
			const g = await geo(variant)
			if (g.lat === null || g.lon === null) {
				console.log(`  ✗ "${variant}"  → UNPLACED`)
				continue
			}
			const ok = inTexas(g.lat, g.lon)
			const km = haversineKm(c.tx[0], c.tx[1], g.lat, g.lon)
			if (!ok) wrongRegion++
			console.log(
				`  ${ok ? "✓" : "✗ WRONG-REGION"}  "${variant}"  → ${g.lat.toFixed(3)},${g.lon.toFixed(3)} ` +
					`[${g.resolution_tier ?? "?"}]  ${km > 100 ? `${km.toFixed(0)}km off TX (cf ${c.namesake})` : `${(km * 1000).toFixed(0)}m off`}`
			)
		}
	}
	shardProvider.close()
	lookup.close()
	console.log(`\n  ${wrongRegion}/${total} variants resolved OUTSIDE Texas (wrong-region).`)
}

await main()
