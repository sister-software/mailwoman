/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #690 diagnostic: why does title-casing all-caps input REGRESS the geocode-core path (cross-dataset
 *   geocode rate 100%→39%) when it HELPS the resolveTree path (#619: locality 90→99.7%)? Feed both the
 *   raw all-caps string and a pre-title-cased copy through the SAME geocodeAddress and compare.
 *   Run: node --experimental-strip-types scripts/eval/geocode-case-diag.ts
 */

import { createWofResolver, type ResolverBackend } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { geocodeAddress, ShardProvider } from "../../mailwoman/out/geocode-core.js"

const titleCaseInput = (t: string) => t.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const mod = await import("@mailwoman/resolver-wof-sqlite")
const lookup = new mod.WofSqlitePlaceLookup({ databasePath: "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db" })
const resolver = createWofResolver(lookup as unknown as ResolverBackend)
const shards = new ShardProvider(mod, "/mnt/playpen/mailwoman-data")

import { readFileSync } from "node:fs"
const SRC = process.argv[2] ?? "txhhsc"
const N = Number(process.argv[3] ?? "200")
const NOCOMMA = process.argv.includes("nocomma") // #694: ingestRows space-joins columns (no commas)
let addrs: string[]
if (SRC === "fcc") {
	const lines = readFileSync("/tmp/fcc-rhc-tx.csv", "utf8").split("\n").filter((l) => l.trim())
	const cols = lines[0]!.split(",")
	const ci = (n: string) => cols.indexOf(n)
	addrs = lines
		.slice(1, N + 1)
		.map((l) => l.split(","))
		.map((f) => `${f[ci("site_addr")]}, ${f[ci("site_city")]}, TX ${f[ci("site_zip")]}`)
} else {
	addrs = readFileSync("/tmp/txhhsc-oarow.jsonl", "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.slice(0, N)
		.map((l) => JSON.parse(l).input as string)
}

const latOf = async (raw: string): Promise<number | null> => {
	const g = await geocodeAddress(raw, { classifier, resolver, shards: shards.for, defaultCountry: "US", placeCountry: false })
	return g.lat
}

let rawLat = 0
let tcLat = 0
let rawTier: Record<string, number> = {}
let tcTier: Record<string, number> = {}
const tierOf = async (raw: string) => {
	const g = await geocodeAddress(raw, { classifier, resolver, shards: shards.for, defaultCountry: "US", placeCountry: false })
	return { lat: g.lat, tier: g.resolution_tier }
}
const prep = (s: string) => (NOCOMMA ? s.replace(/,/g, "") : s)
for (const raw0 of addrs) {
	const raw = prep(raw0)
	const a = await tierOf(raw)
	const b = await tierOf(titleCaseInput(raw))
	if (a.lat !== null) rawLat++
	if (b.lat !== null) tcLat++
	rawTier[a.tier] = (rawTier[a.tier] ?? 0) + 1
	tcTier[b.tier] = (tcTier[b.tier] ?? 0) + 1
}
console.log(`\nBULK over ${addrs.length} TX HHSC (all-caps):`)
console.log(`  RAW   lat!=null ${rawLat}/${addrs.length}  tiers ${JSON.stringify(rawTier)}`)
console.log(`  TITLE lat!=null ${tcLat}/${addrs.length}  tiers ${JSON.stringify(tcTier)}`)
shards.close()
lookup.close()
