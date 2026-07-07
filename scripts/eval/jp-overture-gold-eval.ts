/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Run the SHIPPED JP resolver against the Overture eval gold (#473 How-JP step 2) and compare to
 *   the KEN_ALL-based 94.9% (`jp-resolver-eval.ts`, the number in postcode-locality-jp.db's meta).
 *
 *   Same backend attach, same query shape, same name normalization as the KEN_ALL harness — the only
 *   thing that changes is the GOLD: municipality attribution + coordinate come from Overture's 19.6M
 *   real address points (MLIT), sampled where addresses actually exist. Divergence >2pp from the
 *   shipped number is an INVESTIGATE (pre-registered on #473), not a pass/fail fudge — the sampling
 *   frames differ (address-weighted vs postcode-row-weighted), so read the delta with that in mind.
 *
 *   Usage: node scripts/eval/jp-overture-gold-eval.ts [--gold data/eval/external/jp-overture-gold.jsonl]
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const { values } = parseArgs({
	options: {
		gold: { type: "string" },
	},
})

const GOLD = values.gold ?? "data/eval/external/jp-overture-gold.jsonl"

const backend = new WOFSqlitePlaceLookup({
	databasePath: [dataRootPath("wof", "admin-global-priority.db"), dataRootPath("wof", "postcode-locality-jp.db")],
})

/** Identical to jp-resolver-eval.ts — the comparison depends on it. */
function norm(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[\s-]/g, "")
		.replace(/(shi|ku|cho|machi|gun|ken|fu|to|son|mura|ward)$/, "")
}

function toRad(deg: number): number {
	return (deg * Math.PI) / 180
}

function haversineKm(aLat: number, bLon: number, cLat: number, dLon: number): number {
	const R = 6371.0
	const dp = toRad(cLat - aLat)
	const dl = toRad(dLon - bLon)

	return (
		2 *
		R *
		Math.asin(Math.sqrt(Math.sin(dp / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(cLat)) * Math.sin(dl / 2) ** 2))
	)
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN

	return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))]!
}

interface GoldRow {
	city: string
	postcode: string
	muni: string
	muni_romaji: string
	pref: string
	lat: number
	lon: number
}

const rows: GoldRow[] = readFileSync(GOLD, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as GoldRow)

let resolved = 0
let agree = 0
const distances: number[] = []

for (const r of rows) {
	const cands = await backend.findPlace({
		text: r.city,
		placetype: "locality",
		postcode: r.postcode,
		country: "JP",
	} as never)
	const top = cands[0] as { name: string; lat?: number; lon?: number } | undefined

	if (!top) continue
	resolved += 1
	const nm = norm(top.name)

	if (nm.length >= 2 && norm(r.muni_romaji).includes(nm)) {
		agree += 1
	}

	if (typeof top.lat === "number" && typeof top.lon === "number") {
		distances.push(haversineKm(top.lat, top.lon, r.lat, r.lon))
	}
}

distances.sort((a, b) => a - b)
const agreePct = (100 * agree) / rows.length
const SHIPPED = 94.9 // postcode-locality-jp.db meta match_rate + the jp-resolver-eval.ts headline
const delta = agreePct - SHIPPED

console.log(`JP Overture-gold eval (text=city token + postcode; gold=Overture ${rows.length} rows):`)
console.log(`  resolved:   ${resolved} (${((100 * resolved) / rows.length).toFixed(1)}%)`)
console.log(`  name-agree w/ Overture municipality: ${agree} (${agreePct.toFixed(1)}%)`)
console.log(
	`  coord p50/p90 vs Overture point: ${percentile(distances, 0.5).toFixed(2)} / ${percentile(distances, 0.9).toFixed(2)} km`
)
console.log(
	`  vs shipped KEN_ALL number ${SHIPPED}%: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp ` +
		`(${Math.abs(delta) > 2 ? "INVESTIGATE — >2pp divergence" : "within the 2pp band"})`
)
backend.close?.()
process.exit(0)
