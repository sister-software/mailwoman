#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #822 PLACER-FRONTIER DIAGNOSTIC — quantify, country by country, where forward geocoding a bare
 *   "City, Country" query lands in the WRONG place, and CRITICALLY, how much of that a country hint
 *   recovers. The nominatim/photon drop-ins pass no country constraint for a bare query, so the
 *   bare pass measures exactly what they return; the country-hint pass (`countrycodes` /
 *   defaultCountry) measures the ceiling — which separates the two levers:
 *
 *   - PLACER-RECOVERABLE (#822): fails bare, RESOLVES with the country hint. The coarse #244 placer
 *       just isn't emitting the country; growing its coverage is the fix. This is the prize.
 *   - RESIDUAL (exonym / gazetteer coverage): fails EVEN with the country hint — "Warsaw" vs the
 *       gazetteer's "Warszawa", or a within-country coverage/disambiguation miss (Beijing, Rio). A
 *       country hint can't fix these; they need alt-name matching or more gazetteer data.
 *
 *   The bare US-namesake rate UNDERCOUNTS the placer gap (Shanghai/Cairo fail bare without landing in
 *   the US, yet a hint fixes them), which is why the bare-vs-hint delta is the honest #822
 *   measure.
 *
 *   Method: top-K cities/country from geonames cities15000 (ground-truth lat/lon + ISO2), forward-
 *   geocoded through the same engine the drop-in uses, scored by COORD error (gameable-resistant).
 *   CPU-only; calls global.gc() periodically to dodge the onnxruntime batch-eval leak (#787/#792,
 *   ~380-parse SIGKILL) — REQUIRES --expose-gc. Two geocodes per city (bare + hint).
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
const pct = (a, b) => ((a / b) * 100).toFixed(1)

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

// --- engine (bare = the drop-in's path; hint = the country-constrained ceiling) ---
const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const resolver = createWofResolver(createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) }))
const shards = new ShardProvider(resolverMod, mailwomanDataRoot())

const resolvesWithin = async (query, opts, c) => {
	try {
		const r = await geocodeAddress(query, { classifier, resolver, shards: shards.for, ...opts })
		if (r.lat == null || r.lon == null) return { ok: false, us: false, got: false }
		return {
			ok: haversineKm(r.lat, r.lon, c.lat, c.lon) <= RESOLVE_KM,
			us: c.cc !== "US" && inUs(r.lat, r.lon),
			got: true,
		}
	} catch {
		return { ok: false, us: false, got: false }
	}
}

const perCountry = new Map() // cc -> { n, bare, withCc, namesake, name }
let done = 0
for (const c of sample) {
	const query = `${c.name}, ${c.countryName}`
	const bare = await resolvesWithin(query, {}, c)
	const hint = await resolvesWithin(query, { defaultCountry: c.cc }, c)
	const e = perCountry.get(c.cc) ?? { n: 0, bare: 0, withCc: 0, namesake: 0, hintEmpty: 0, name: c.countryName }
	e.n++
	if (bare.ok) e.bare++
	if (hint.ok) e.withCc++
	if (bare.us) e.namesake++
	// A hint that resolves nothing means the queried name matches no place in that country — the record
	// is under another surface form (exonym). A hint that resolves the WRONG place is a coverage miss.
	if (!hint.ok && !hint.got) e.hintEmpty++
	perCountry.set(c.cc, e)
	if (++done % 25 === 0) {
		global.gc()
		process.stderr.write(`\r[frontier] ${done}/${sample.length}`)
	}
}
process.stderr.write("\n")

// --- aggregate ---
const rows = [...perCountry.entries()]
	.map(([cc, e]) => ({ cc, ...e, bareRate: e.bare / e.n, ccRate: e.withCc / e.n }))
	.sort((a, b) => a.ccRate - b.ccRate || a.bareRate - b.bareRate)
const sum = (k) => rows.reduce((s, r) => s + r[k], 0)
const totalN = sum("n")
const totalBare = sum("bare")
const totalCc = sum("withCc")
const totalNs = sum("namesake")
// Country-level buckets: bare-supported, placer-recoverable (a hint fixes it = #822), residual (a hint
// can't = exonym/coverage). A country counts as placer-recoverable if a hint lifts it over the bar.
const bareSupported = rows.filter((r) => r.bareRate >= 0.5)
const frontier = rows.filter((r) => r.bareRate < 0.5)
const placerRecoverable = frontier.filter((r) => r.ccRate >= 0.5)
const residual = frontier.filter((r) => r.ccRate < 0.5)
// Within the residual, why did the hint fail? Mostly hint-empty (the name isn't in that country → the
// record is under another surface form → the cheap alt-name/exonym fix) vs mostly hint-wrong-place
// (coverage/disambiguation → needs more gazetteer data). misses = the hint-unresolved cities.
const altNameLike = residual.filter((r) => r.hintEmpty > (r.n - r.withCc) / 2)
const coverageLike = residual.filter((r) => r.hintEmpty <= (r.n - r.withCc) / 2)

const L = []
L.push("# #822 placer-frontier diagnostic — bare vs country-hint, by country")
L.push("")
L.push(`_geonames cities15000, top ${PER_COUNTRY}/country by population (≥ ${MIN_POP}). "Resolved" = within`)
L.push(`${RESOLVE_KM} km of the city's true coordinate. **Bare** = no country constraint (what the drop-in sends`)
L.push(`for a bare query); **+hint** = with the country as a \`countrycodes\` constraint. The bare→hint lift is`)
L.push(`what growing the placer would buy (#822); what stays unresolved with a hint is the exonym/coverage lever._`)
L.push("")
L.push(`- Cities: **${totalN}** across **${rows.length}** countries`)
L.push(
	`- Resolve-rate **bare: ${pct(totalBare, totalN)}%** → **+hint: ${pct(totalCc, totalN)}%** (lift +${pct(totalCc - totalBare, totalN)} pp)`
)
L.push(`- Bare US-namesake misroutes: **${pct(totalNs, totalN)}%** (${totalNs}/${totalN}) — undercounts the placer gap`)
L.push(
	`- Countries: **${bareSupported.length}** bare-supported · **${placerRecoverable.length}** placer-recoverable (#822) · **${residual.length}** residual`
)
L.push(
	`- Residual splits: **${altNameLike.length}** name-not-found (English name matches no in-country record — exonym fix where the record exists under a local name, else coverage-absence) · **${coverageLike.length}** wrong-place (coverage/disambiguation)`
)
L.push("")
L.push(`> **How to read this.** Bare resolve-rate is the placer ceiling, not the geocoder's capability — a`)
L.push(`> bare query carries no country hint. The **+hint** column is the honest #822 prize: countries that`)
L.push(`> resolve once the country is known but not before. The **residual** set fails even with the hint, so`)
L.push(`> the placer can't fix it — that's alt-name (Warsaw/Warszawa) + gazetteer coverage, a parallel lever.`)
L.push("")
L.push(`## Placer-recoverable (#822) — a country hint fixes it; growing the placer captures it`)
L.push("")
L.push("| Country | ISO2 | Bare | +hint |")
L.push("| --- | --- | ---: | ---: |")
for (const r of placerRecoverable) {
	L.push(`| ${r.name} | ${r.cc} | ${r.bare}/${r.n} | ${r.withCc}/${r.n} |`)
}
L.push("")
L.push(`## Residual A — name-not-found (exonym fix, or coverage-absence)`)
L.push("")
L.push(`The hint returns NOTHING: the English query name matches no place in the country. Where the record`)
L.push(`exists under a LOCAL name (\`Warsaw\` vs \`Warszawa\` — proven end-to-end), indexing alt-name surface forms`)
L.push(`onto the candidate table fixes it cheaply (#823, no model change). Where the country has no candidate`)
L.push(`records at all, it's coverage. European exonyms dominate; the per-country split needs a local-name probe.`)
L.push(`\`hint→∅\` = of the hint-unresolved cities, how many returned no result (vs a wrong place).`)
L.push("")
L.push("| Country | ISO2 | Bare | +hint | hint→∅ |")
L.push("| --- | --- | ---: | ---: | ---: |")
for (const r of altNameLike) {
	L.push(`| ${r.name} | ${r.cc} | ${r.bare}/${r.n} | ${r.withCc}/${r.n} | ${r.hintEmpty}/${r.n - r.withCc} |`)
}
L.push("")
L.push(`## Residual B — gazetteer coverage / disambiguation`)
L.push("")
L.push(`The hint returns a WRONG place: the country has a same-name match but the target city isn't in the`)
L.push(`candidate gazetteer, or loses disambiguation. Needs more data, not alt-names (Beijing, Rio).`)
L.push("")
L.push("| Country | ISO2 | Bare | +hint | hint→∅ |")
L.push("| --- | --- | ---: | ---: | ---: |")
for (const r of coverageLike) {
	L.push(`| ${r.name} | ${r.cc} | ${r.bare}/${r.n} | ${r.withCc}/${r.n} | ${r.hintEmpty}/${r.n - r.withCc} |`)
}
L.push("")
L.push(`## Bare-supported (≥50% resolve with no hint) — US + the #743 safelist + tail`)
L.push("")
L.push("| Country | ISO2 | Bare |")
L.push("| --- | --- | ---: |")
for (const r of bareSupported) {
	L.push(`| ${r.name} | ${r.cc} | ${r.bare}/${r.n} |`)
}
const report = L.join("\n")
console.log(`\n${report.split("\n").slice(0, 16).join("\n")}\n…`)
if (OUT) {
	writeFileSync(OUT, `${report}\n`)
	console.error(`[frontier] wrote ${OUT}`)
}
process.exit(0)
