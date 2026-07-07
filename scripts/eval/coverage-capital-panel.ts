#!/usr/bin/env node
/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   #823 promote-evidence panel — concrete before/after for the coverage-expansion gazetteer. Geocodes
 *   the capital of a sample of the 147 newly-covered countries through the SHIPPED drop-in pipeline
 *   (`geocodeAddress`) and reports resolve + great-circle error vs the true capital coordinate. Run it
 *   on the CANONICAL candidate DB (before — these resolve to nothing or a US namesake) and on the
 *   STAGED-B DB (after — they resolve to the right city) to make the promote decision tangible.
 *
 *   Run: MAILWOMAN_CANDIDATE_DB=<db> node --expose-gc scripts/eval/coverage-capital-panel.ts [--out <md>]
 */

import { existsSync, writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"

// Loose scan parity with the retired scripts/lib/cli-args helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: { out: { type: "string" }, set: { type: "string" } },
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { out?: string; set?: string }
const OUT = values["out"] || ""
const gc = (globalThis as { gc?: () => void }).gc

if (typeof gc !== "function") {
	console.error("Run with --expose-gc.")
	process.exit(1)
}

// Capitals of a sample of the 147 newly-covered (previously zero-row) countries, with true coordinates.
interface Cap {
	city: string
	country: string
	cc: string
	lat: number
	lon: number
}
const CAPITALS: Cap[] = [
	{ city: "Tirana", country: "Albania", cc: "AL", lat: 41.33, lon: 19.82 },
	{ city: "Yerevan", country: "Armenia", cc: "AM", lat: 40.18, lon: 44.51 },
	{ city: "Tbilisi", country: "Georgia", cc: "GE", lat: 41.72, lon: 44.78 },
	{ city: "Ulaanbaatar", country: "Mongolia", cc: "MN", lat: 47.89, lon: 106.91 },
	{ city: "Kabul", country: "Afghanistan", cc: "AF", lat: 34.53, lon: 69.17 },
	{ city: "Sarajevo", country: "Bosnia and Herzegovina", cc: "BA", lat: 43.85, lon: 18.36 },
	{ city: "Skopje", country: "North Macedonia", cc: "MK", lat: 41.99, lon: 21.43 },
	{ city: "Chisinau", country: "Moldova", cc: "MD", lat: 47.01, lon: 28.86 },
	{ city: "Podgorica", country: "Montenegro", cc: "ME", lat: 42.44, lon: 19.26 },
	{ city: "Pristina", country: "Kosovo", cc: "XK", lat: 42.66, lon: 21.16 },
	{ city: "Antananarivo", country: "Madagascar", cc: "MG", lat: -18.88, lon: 47.51 },
	{ city: "Maputo", country: "Mozambique", cc: "MZ", lat: -25.97, lon: 32.57 },
	{ city: "Lusaka", country: "Zambia", cc: "ZM", lat: -15.39, lon: 28.32 },
	{ city: "Harare", country: "Zimbabwe", cc: "ZW", lat: -17.83, lon: 31.05 },
	{ city: "Bamako", country: "Mali", cc: "ML", lat: 12.65, lon: -8.0 },
	{ city: "Niamey", country: "Niger", cc: "NE", lat: 13.51, lon: 2.11 },
	{ city: "Tashkent", country: "Uzbekistan", cc: "UZ", lat: 41.31, lon: 69.24 },
	{ city: "Bishkek", country: "Kyrgyzstan", cc: "KG", lat: 42.87, lon: 74.59 },
	{ city: "Dushanbe", country: "Tajikistan", cc: "TJ", lat: 38.56, lon: 68.79 },
	{ city: "Ashgabat", country: "Turkmenistan", cc: "TM", lat: 37.96, lon: 58.33 },
	{ city: "Tripoli", country: "Libya", cc: "LY", lat: 32.89, lon: 13.19 },
	{ city: "Khartoum", country: "Sudan", cc: "SD", lat: 15.5, lon: 32.56 },
	{ city: "Sanaa", country: "Yemen", cc: "YE", lat: 15.37, lon: 44.19 },
	{ city: "Damascus", country: "Syria", cc: "SY", lat: 33.51, lon: 36.29 },
	{ city: "Hong Kong", country: "Hong Kong", cc: "HK", lat: 22.32, lon: 114.17 },
]

// Do-no-harm set: supported-country second-tier cities (NOT the 10 parity presets) — a broader check
// that the +988k new-country places didn't perturb supported resolution via a same-name collision.
const SUPPORTED: Cap[] = [
	{ city: "Lyon", country: "France", cc: "FR", lat: 45.76, lon: 4.83 },
	{ city: "Marseille", country: "France", cc: "FR", lat: 43.3, lon: 5.37 },
	{ city: "Hamburg", country: "Germany", cc: "DE", lat: 53.55, lon: 9.99 },
	{ city: "Cologne", country: "Germany", cc: "DE", lat: 50.94, lon: 6.96 },
	{ city: "Naples", country: "Italy", cc: "IT", lat: 40.85, lon: 14.27 },
	{ city: "Milan", country: "Italy", cc: "IT", lat: 45.46, lon: 9.19 },
	{ city: "Valencia", country: "Spain", cc: "ES", lat: 39.47, lon: -0.38 },
	{ city: "Seville", country: "Spain", cc: "ES", lat: 37.39, lon: -5.99 },
	{ city: "Utrecht", country: "Netherlands", cc: "NL", lat: 52.09, lon: 5.12 },
	{ city: "Eindhoven", country: "Netherlands", cc: "NL", lat: 51.44, lon: 5.48 },
	{ city: "Chicago, IL", country: "USA", cc: "US", lat: 41.88, lon: -87.63 },
	{ city: "Houston, TX", country: "USA", cc: "US", lat: 29.76, lon: -95.37 },
	{ city: "Phoenix, AZ", country: "USA", cc: "US", lat: 33.45, lon: -112.07 },
	{ city: "Denver, CO", country: "USA", cc: "US", lat: 39.74, lon: -104.99 },
]
const SET = (values["set"] || "new") === "supported" ? SUPPORTED : CAPITALS

const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const resolver = createWOFResolver(createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) }))
const shards = new ShardProvider(resolverMod, mailwomanDataRoot())

const db = process.env["MAILWOMAN_CANDIDATE_DB"] ?? "admin shards"
const rows: Array<{ cap: Cap; err: number | null }> = []

for (const cap of SET) {
	const q = `${cap.city}, ${cap.country}`
	let err: number | null = null

	try {
		const g = await geocodeAddress(q, { classifier, resolver, shards: shards.for, defaultCountry: cap.cc })

		if (g.lat != null && g.lon != null) {
			err = haversineKm(g.lat, g.lon, cap.lat, cap.lon)
		}
	} catch {
		/* unresolved */
	}
	rows.push({ cap, err })
	gc()
}

const resolved = rows.filter((r) => r.err != null)
const within25 = resolved.filter((r) => r.err! <= 25)
const L: string[] = []
L.push(`# #823 coverage promote-evidence — capitals of newly-covered countries`)
L.push("")
L.push(`_Gazetteer: \`${db}\`. ${SET.length} cities geocoded through the drop-in (\`geocodeAddress\`), error vs`)
L.push(`the true coordinate._`)
L.push("")
L.push(`- Resolved: **${resolved.length}/${SET.length}** · within 25 km: **${within25.length}/${SET.length}**`)
L.push("")
L.push("| Capital | ISO2 | error |")
L.push("| --- | --- | ---: |")

for (const r of rows) {
	L.push(
		`| ${r.cap.city}, ${r.cap.country} | ${r.cap.cc} | ${r.err == null ? "∅ unresolved" : `${r.err.toFixed(0)} km`} |`
	)
}

const report = L.join("\n")
console.log(report)

if (OUT) {
	writeFileSync(OUT, `${report}\n`)
	console.error(`[capital-panel] wrote ${OUT}`)
}
