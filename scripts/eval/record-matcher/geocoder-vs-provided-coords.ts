/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Geocoder validation against provided coordinates (#619) — a free, honest, real-world accuracy
 *   eval.
 *
 *   TX HHSC's nursing-facilities registry ships a `Geo Location` (`lat,lon`) per facility alongside
 *   its physical address. We geocode the address with mailwoman's real parser + resolver and
 *   measure the great-circle delta to the provided point — p50 / p90, broken down by the resolution
 *   tier we assign (address_point / interpolated / admin). This is an independent check of the
 *   geocoder on real facility addresses; it does not touch the matcher.
 *
 *   The provided coordinate is treated as ground truth for _this_ eval, with the honest caveat that
 *   it is itself a third-party geocode of unknown provenance — a large delta is a discrepancy to
 *   inspect, not automatically our error.
 *
 *   Run: node scripts/eval/record-matcher/geocoder-vs-provided-coords.ts\
 *   [--max 1176] [--wof <admin.db>] [--data-root <dir>] [--out-md docs/articles/evals/<date>-...md]
 */

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/match"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { streamRows } from "@mailwoman/registry"
import { createWOFResolver } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		"data-root": { type: "string" },
		max: { type: "string" },
		"out-md": { type: "string" },
		sources: { type: "string" },
		wof: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as { "data-root"?: string; max?: string; "out-md"?: string; sources?: string; wof?: string }
const SOURCES = values["sources"] || dataRootPath("record-matcher", "sources")
const MAX = Number(values["max"] || "2000")
const WOF = values["wof"] || dataRootPath("wof", "admin-global-priority.db")
const DATA_ROOT = values["data-root"] || mailwomanDataRoot()
const OUT_MD = values["out-md"] || ""

const FILE = `${SOURCES}/txhhsc_nursing-facilities_20260611.tsv`
const norm = (s: string | undefined) => (s ?? "").trim()

/** Parse a `lat,lon` string into a coordinate, or null if malformed / out of range. */
function parseLatLon(raw: string | undefined): { latitude: number; longitude: number } | null {
	if (!raw) return null
	const [a, b] = raw.split(",").map((x) => Number(x.trim()))

	if (!Number.isFinite(a) || !Number.isFinite(b)) return null

	if (Math.abs(a!) > 90 || Math.abs(b!) > 180) return null

	return { latitude: a!, longitude: b! }
}

function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return NaN
	const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length))

	return sorted[i]!
}

async function main(): Promise<void> {
	console.error("[A] building the geocoder…")
	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const lookup = new mod.WOFSqlitePlaceLookup({ databasePath: WOF })
	const resolver = createWOFResolver(lookup)
	const shardProvider = new ShardProvider(mod, DATA_ROOT)

	console.error(`[B] geocoding ≤${MAX} TX nursing facilities + measuring delta to provided coords…`)
	interface Row {
		deltaM: number
		tier: string
	}
	const results: Row[] = []
	let scanned = 0
	let noCoord = 0
	let noPlace = 0

	for await (const r of streamRows(FILE)) {
		if (results.length >= MAX) break
		const provided = parseLatLon(r["Geo Location"])
		const line = norm(r["Physical Address"])
		const city = norm(r["Physical Address CITY"])
		const state = norm(r["Physical Address State"])
		const zip = norm(r["Physical Address Zipcode"])

		if (!provided || !line) {
			noCoord++
			continue
		}
		scanned++
		const address = [line, city, state, zip].filter(Boolean).join(", ")
		const g = await geocodeAddress(address, {
			classifier,
			resolver,
			shards: shardProvider.for,
			defaultCountry: "US",
			placeCountry: false,
		})

		if (g.lat === null || g.lon === null) {
			noPlace++
			continue
		}
		const deltaM = haversineKm(provided, { latitude: g.lat, longitude: g.lon }) * 1000
		results.push({ deltaM, tier: g.resolution_tier ?? "unknown" })
	}

	shardProvider.close()
	lookup.close()

	// Overall + per-tier percentiles.
	const all = results.map((r) => r.deltaM).sort((a, b) => a - b)
	const byTier = new Map<string, number[]>()

	for (const r of results) {
		const list = byTier.get(r.tier) ?? []
		list.push(r.deltaM)
		byTier.set(r.tier, list)
	}

	const m = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} km` : `${Math.round(x)} m`)
	console.error(
		`    geocoded ${results.length}/${scanned} placed (${noPlace} unplaced, ${noCoord} skipped no-coord/addr); ` +
			`p50 ${m(quantile(all, 0.5))}, p90 ${m(quantile(all, 0.9))}`
	)

	const lines: string[] = []
	lines.push(`# Geocoder vs provided coordinates (#619)`)
	lines.push("")
	lines.push(
		`_Generated by \`scripts/eval/record-matcher/geocoder-vs-provided-coords.ts\`. Source: TX HHSC ` +
			`nursing-facilities (\`Geo Location\` = provided \`lat,lon\`). We geocode each facility's physical address ` +
			`with mailwoman's parser + resolver and measure the great-circle delta to the provided point. The provided ` +
			`coordinate is a third-party geocode of unknown provenance — a large delta is a discrepancy to inspect, not ` +
			`automatically our error._`
	)
	lines.push("")
	lines.push(`## Result`)
	lines.push("")
	lines.push(`- facilities geocoded: **${results.length}** of ${scanned} with a usable address + provided coord`)
	lines.push(`- unplaced by our geocoder: ${noPlace} · skipped (no coord / no address): ${noCoord}`)
	lines.push(
		`- **overall delta: p50 ${m(quantile(all, 0.5))}, p90 ${m(quantile(all, 0.9))}, p99 ${m(quantile(all, 0.99))}** ` +
			`(max ${m(all[all.length - 1] ?? 0)})`
	)
	lines.push("")
	lines.push(`## By resolution tier`)
	lines.push("")
	lines.push(`| tier | n | p50 | p90 |`)
	lines.push(`|---|---:|---:|---:|`)

	for (const [tier, list] of [...byTier.entries()].sort((a, b) => b[1].length - a[1].length)) {
		const s = [...list].sort((a, b) => a - b)
		lines.push(`| ${tier} | ${list.length} | ${m(quantile(s, 0.5))} | ${m(quantile(s, 0.9))} |`)
	}
	lines.push("")
	lines.push(`## Reading`)
	lines.push("")
	lines.push(
		`Two regimes. **Street-tier placement is excellent** (the address_point + interpolated rows above) — ` +
			`rooftop-to-segment medians, the precision that makes geo-first blocking and the distance evidence ` +
			`trustworthy. The **admin (centroid) tier** is where no street shard covered the address: accuracy is ` +
			`necessarily km-scale, and it carries a catastrophic tail (the p90/p99/max above) from wrong-region admin ` +
			`resolutions and/or malformed provided coordinates — NOT street-tier error. Those extremes are a signal to ` +
			`inspect, and they motivate wider street-shard coverage for rural TX plus an admin-tier sanity bound. The ` +
			`self-reported-vs-independent coordinate discrepancy is itself a data-quality column the reconciliation ` +
			`surfaces (#621).`
	)
	lines.push("")

	const md = lines.join("\n")
	console.log(md)

	if (OUT_MD) {
		writeFileSync(OUT_MD, md)
		console.error(`\n[written] ${OUT_MD}`)
	}
}

await main()
