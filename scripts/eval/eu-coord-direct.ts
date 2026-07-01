import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Direct per-locale COORDINATE harness for the zero-DB EU locales (2026-06-20 coordinate-leverage
 *   sprint). Grades the assembled-geocode coordinate vs the held-out OA rooftop truth — the
 *   #566-correct metric — instead of the admin-name-match arm `oa-resolver-eval` headlines.
 *
 *   Why a separate harness: `oa-resolver-eval`'s "neural" arm credits only the admin-centroid tier
 *   (resolved locality name → centroid). For a locale whose locality the model mis-parses (PT
 *   parses the street "Av Saboia" AS the locality), that arm reports 0% even though `resolveTree`
 *   still lands a correct coordinate via the postcode coordinate-first path. This harness takes the
 *   FINEST resolved coordinate (whatever tier produced it) so coverage and parse-quality don't get
 *   tangled, and separately reports the locality name-match rate so you can see which is which.
 *
 *   Usage: node --experimental-strip-types scripts/eval/eu-coord-direct.ts\
 *   --eval /tmp/reg/eu-eval-pt.jsonl --country PT\
 *   --wof-db
 *   $MAILWOMAN_DATA_ROOT/wof/admin-overture-eu.db,$MAILWOMAN_DATA_ROOT/wof/postcode-locality-intl.db
 */
import type { AddressNode } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createScorer } from "@mailwoman/neural/scorer"
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { haversineKm } from "@mailwoman/spatial"

const { values: a } = parseArgs({
	options: {
		eval: { type: "string" },
		country: { type: "string" },
		"wof-db": { type: "string" },
		model: {
			type: "string",
			default: dataRootPath("models", "quantized", "model-v180-step-40000-int8.onnx"),
		},
		tokenizer: {
			type: "string",
			default: dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model"),
		},
		"model-card": { type: "string", default: "neural-weights-en-us/model-card.json" },
		"anchor-lookup": {
			type: "string",
			default: dataRootPath("anchor", "pilot-anchor-lookup.json"),
		},
		limit: { type: "string" },
	},
})

if (!a.eval || !a.country || !a["wof-db"]) {
	console.error("--eval, --country, --wof-db are required")
	process.exit(1)
}

function pct(sorted: number[], p: number): number {
	if (sorted.length === 0) return NaN

	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
function norm(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]/g, "")
}

const rows = readFileSync(a.eval!, "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l) as { input: string; lat: number; lon: number; expected?: { locality?: string } })
	.slice(0, a.limit ? Number.parseInt(a.limit, 10) : undefined)

const neural = await createScorer({
	modelPath: a.model!,
	tokenizerPath: a.tokenizer!,
	modelCardPath: a["model-card"]!,
	anchorLookupPath: a["anchor-lookup"]!,
	strict: true,
	tier: "server",
})
const backend = new WOFSqlitePlaceLookup({ databasePath: a["wof-db"]!.split(",") })
const resolver = createWOFResolver(backend)

const finest: number[] = []
const adminLoc: number[] = []
let locResolved = 0
let locNameMatch = 0
let anyCoord = 0

for (const r of rows) {
	const tree = await neural.parse(r.input, { normalizeCase: true, postcodeRepair: true })
	const resolved = await resolver.resolveTree(tree, { defaultCountry: a.country!.toUpperCase() })
	// Collect every resolved node carrying a coordinate, with its placetype.
	const nodes: { pt: string; name?: string; lat: number; lon: number }[] = []
	const visit = (n: AddressNode): void => {
		if (typeof n.lat === "number" && typeof n.lon === "number" && (n.placeId || n.sourceId)) {
			nodes.push({ pt: String(n.sourceId ?? "").split(":")[0]!, name: n.value, lat: n.lat, lon: n.lon })
		}

		for (const c of n.children ?? []) visit(c)
	}

	for (const root of resolved.roots) visit(root)

	if (nodes.length === 0) continue
	anyCoord++

	// Finest = the most specific tier present (postcode beats locality beats region/county).
	const order = ["postcode", "locality", "localadmin", "county", "region", "country"]
	const pick = (pts: string[]) => nodes.find((n) => pts.includes(n.pt)) ?? nodes[0]
	const fine = nodes.slice().sort((x, y) => order.indexOf(x.pt) - order.indexOf(y.pt))[0]!
	finest.push(haversineKm(r.lat, r.lon, fine.lat, fine.lon))

	const loc = pick(["locality", "localadmin"])

	if (loc && (loc.pt === "locality" || loc.pt === "localadmin")) {
		locResolved++
		adminLoc.push(haversineKm(r.lat, r.lon, loc.lat, loc.lon))

		if (r.expected?.locality && loc.name && norm(loc.name) === norm(r.expected.locality)) locNameMatch++
	}
}

const fs = finest.slice().sort((x, y) => x - y)
const as = adminLoc.slice().sort((x, y) => x - y)
const N = rows.length
const f1 = (x: number) => x.toFixed(1)
console.log(
	`| ${a.country!.toUpperCase()} | ${N} | ${((100 * anyCoord) / N).toFixed(0)}% | ${f1(pct(fs, 50))} | ${f1(pct(fs, 90))} | ${((100 * locResolved) / N).toFixed(0)}% | ${((100 * locNameMatch) / N).toFixed(0)}% | ${as.length ? f1(pct(as, 50)) : "—"} | ${as.length ? f1(pct(as, 90)) : "—"} |`
)
