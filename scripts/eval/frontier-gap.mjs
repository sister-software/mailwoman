#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #822 PLACER-FRONTIER DIAGNOSTIC — quantify, country by country, where forward geocoding a bare
 *   "City, Country" query lands in the WRONG country (almost always a US namesake) because the
 *   coarse #244 placer doesn't confidently emit that country. The nominatim/photon drop-ins pass no
 *   country constraint for a bare query, so this measures exactly what they return.
 *
 *   The parity harness proved the gap on 4 hand-picked cities (Vienna/Sydney/London/Toronto). This
 *   generalizes it: top-K cities per country from geonames cities15000 (ground-truth lat/lon +
 *   ISO2), forward-geocoded through the same engine the drop-in uses, scored by COORD error (the
 *   gameable- resistant "right place" test) + a US-namesake flag (intended non-US, resolved inside
 *   the US bbox). The output is the country-by-country recall table the operator needs before
 *   greenlighting the GPU placer next-tranche — turning "AT/AU/GB/CA miss" into evidence.
 *
 *   CPU-only. Runs `geocodeAddress` directly (no server) and calls global.gc() periodically to dodge
 *   the onnxruntime batch-eval leak (#787/#792, ~380-parse SIGKILL) — REQUIRES --expose-gc.
 *
 *   Run: node --expose-gc scripts/eval/frontier-gap.mjs [--per-country 3] [--min-pop 50000] [--out
 *   <md>]
 */

import { ISO2_TO_NAME } from "@mailwoman/codex/country"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWofResolver } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

const arg = (flag, fallback) => {
	const i = process.argv.indexOf(flag)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PER_COUNTRY = Number(arg("--per-country", "3"))
const MIN_POP = Number(arg("--min-pop", "50000"))
const OUT = arg("--out", "")
const RESOLVE_KM = 50 // coarse "right city"
const CITIES = "/mnt/playpen/mailwoman-data/geonames/cities15000.txt"
// Continental-US bounding box — a resolved point inside it, for an intended non-US city, is a namesake.
const US_BBOX = { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }

function haversineKm(aLat, aLon, bLat, bLon) {
	const R = 6371
	const dLat = ((bLat - aLat) * Math.PI) / 180
	const dLon = ((bLon - aLon) * Math.PI) / 180
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(s))
}
const inUs = (lat, lon) =>
	lat >= US_BBOX.minLat && lat <= US_BBOX.maxLat && lon >= US_BBOX.minLon && lon <= US_BBOX.maxLon

if (typeof global.gc !== "function") {
	console.error("Run with --expose-gc (the onnxruntime batch leak SIGKILLs ~380 parses otherwise).")
	process.exit(1)
}

// --- build the city sample: top-K by population per country ---
const byCountry = new Map()
for (const line of readFileSync(CITIES, "utf8").split("\n")) {
	if (!line) continue
	const f = line.split("\t")
	const name = f[1]
	const lat = Number(f[4])
	const lon = Number(f[5])
	const cc = f[8]
	const pop = Number(f[14])
	if (!name || !cc || !Number.isFinite(lat) || pop < MIN_POP) continue
	const countryName = ISO2_TO_NAME.get(cc)
	if (!countryName) continue // skip codes codex doesn't name
	if (!byCountry.has(cc)) byCountry.set(cc, [])
	byCountry.get(cc).push({ name, lat, lon, cc, countryName, pop })
}
const sample = []
for (const [, cities] of byCountry) {
	cities.sort((a, b) => b.pop - a.pop)
	sample.push(...cities.slice(0, PER_COUNTRY))
}
console.error(`[frontier] ${byCountry.size} countries, ${sample.length} cities (top ${PER_COUNTRY}, pop ≥ ${MIN_POP})`)

// --- engine (same path the drop-in uses: no country constraint) ---
const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const resolver = createWofResolver(createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) }))
const shards = new ShardProvider(resolverMod, mailwomanDataRoot())

const perCountry = new Map() // cc -> { n, resolved, namesake, name }
let done = 0
for (const c of sample) {
	let resolved = false
	let namesake = false
	try {
		const r = await geocodeAddress(`${c.name}, ${c.countryName}`, { classifier, resolver, shards: shards.for })
		if (r.lat != null && r.lon != null) {
			const km = haversineKm(r.lat, r.lon, c.lat, c.lon)
			resolved = km <= RESOLVE_KM
			namesake = c.cc !== "US" && inUs(r.lat, r.lon)
		}
	} catch {
		/* count as unresolved */
	}
	const e = perCountry.get(c.cc) ?? { n: 0, resolved: 0, namesake: 0, name: c.countryName }
	e.n++
	if (resolved) e.resolved++
	if (namesake) e.namesake++
	perCountry.set(c.cc, e)
	if (++done % 25 === 0) {
		global.gc()
		process.stderr.write(`\r[frontier] ${done}/${sample.length}`)
	}
}
process.stderr.write("\n")

// --- aggregate ---
const rows = [...perCountry.entries()]
	.map(([cc, e]) => ({ cc, ...e, rate: e.resolved / e.n, nsRate: e.namesake / e.n }))
	.sort((a, b) => a.rate - b.rate || b.nsRate - a.nsRate)
const totalN = rows.reduce((s, r) => s + r.n, 0)
const totalResolved = rows.reduce((s, r) => s + r.resolved, 0)
const totalNs = rows.reduce((s, r) => s + r.namesake, 0)
const frontier = rows.filter((r) => r.rate < 0.5)
const supported = rows.filter((r) => r.rate >= 0.5)
// Pure-namesake: every sampled city went to a US namesake. The unambiguous placer-emission gap (#822)
// — distinct from exonym (Wien/Vienna) or gazetteer-coverage misses, which fail without landing in the US.
const pureNamesake = frontier.filter((r) => r.namesake === r.n)

const L = []
L.push("# #822 placer-frontier diagnostic — forward geocoding by country")
L.push("")
L.push(`_geonames cities15000, top ${PER_COUNTRY}/country by population (≥ ${MIN_POP}). "Resolved" = within`)
L.push(`${RESOLVE_KM} km of the city's true coordinate. "US namesake" = an intended non-US city that resolved`)
L.push(`inside the continental-US bbox. Bare "City, Country" query — exactly what the drop-in sends._`)
L.push("")
L.push(`- Countries sampled: **${rows.length}**`)
L.push(`- Overall resolve-rate: **${((totalResolved / totalN) * 100).toFixed(1)}%** (${totalResolved}/${totalN})`)
L.push(`- US-namesake misroutes: **${((totalNs / totalN) * 100).toFixed(1)}%** (${totalNs}/${totalN})`)
L.push(`- Supported (50%+ resolve): **${supported.length}** countries · Frontier (under 50%): **${frontier.length}**`)
L.push(`- Pure US-namesake (every sampled city → US): **${pureNamesake.length}** countries — the cleanest #822 targets`)
L.push("")
L.push(`> **How to read this.** This is the placer's country-emission ceiling, not the geocoder's capability.`)
L.push(`> A bare "City, Country" query carries no country hint, so US plus the ${supported.length} supported`)
L.push(`> countries below resolve; \`countrycodes\` recovers more (the manual escape). The lever for the rest is`)
L.push(`> placer coverage (#822) — GPU model work.`)
L.push("")
L.push(`## Pure US-namesake countries — the unambiguous #822 placer-emission gap`)
L.push("")
L.push(`Every sampled city resolved to a US namesake: the placer never emits the country, so a confident US`)
L.push(`place wins. A country constraint (\`countrycodes\`) is the manual escape today; the fix is placer coverage.`)
L.push("")
L.push("| Country | ISO2 | Cities → US |")
L.push("| --- | --- | ---: |")
for (const r of pureNamesake) {
	L.push(`| ${r.name} | ${r.cc} | ${r.namesake}/${r.n} |`)
}
L.push("")
L.push(`## All frontier countries (under 50% resolve) — the #822 work list`)
L.push("")
L.push(`Where US-namesake is below the miss count, the rest are exonym (Wien/Vienna) or gazetteer-coverage`)
L.push(`misses — a different fix than placer emission.`)
L.push("")
L.push("| Country | ISO2 | Resolved | US-namesake |")
L.push("| --- | --- | ---: | ---: |")
for (const r of frontier) {
	L.push(`| ${r.name} | ${r.cc} | ${r.resolved}/${r.n} | ${r.namesake}/${r.n} |`)
}
L.push("")
L.push(`## Supported countries (≥50% resolve)`)
L.push("")
L.push("| Country | ISO2 | Resolved |")
L.push("| --- | --- | ---: |")
for (const r of supported) {
	L.push(`| ${r.name} | ${r.cc} | ${r.resolved}/${r.n} |`)
}
const report = L.join("\n")
console.log(`\n${report.split("\n").slice(0, 22).join("\n")}\n…`)
if (OUT) {
	writeFileSync(OUT, `${report}\n`)
	console.error(`[frontier] wrote ${OUT}`)
}
process.exit(0)
