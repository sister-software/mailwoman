/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Functional-eyeball helper for a promote gate (the human tier). Parses + resolves the first K rows of a
 *   coord golden under TWO models side-by-side and prints, per row: the raw input, each model's decoded
 *   components (street / house_number / locality / …), and each model's resolved coord + great-circle error
 *   to the gold pin. The point is to READ the parses, not a number — specifically to catch post-fix
 *   OVER-tagging on a shard-fix candidate: a diacritic-fix model going over-confident on a rare fragment and
 *   extending the street span into the house_number (house_number disappears, street swallows the digit).
 *   Aggregate p50 can pass while this quietly breaks the boundary in a NEW way.
 *
 *   Usage:
 *     node --experimental-strip-types scripts/eval/coord-eyeball.ts \
 *       --golden $GATE/cz-coord.jsonl --base $BASE --cand $CAND \
 *       --tokenizer $TOK --model-card $CARD --default-country CZ --n 18
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { type AddressNode, type AddressTree, decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}

interface Resolved {
	placetype: string
	lat: number
	lon: number
}

function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []
	const visit = (n: AddressNode): void => {
		if (n.placeID?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""
			out.push({ placetype, lat: n.lat, lon: n.lon })
		}

		for (const c of n.children) {
			visit(c)
		}
	}

	for (const r of tree.roots) {
		visit(r)
	}

	return out
}

function mostSpecific(rs: Resolved[]): Resolved | null {
	let best: Resolved | null = null

	for (const r of rs)
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) {
			best = r
		}

	return best
}

const { values } = parseArgs({
	options: {
		golden: { type: "string" },
		base: { type: "string" },
		cand: { type: "string" },
		tokenizer: { type: "string" },
		// The candidate's tokenizer, when it differs from the baseline's (a vocab-splice candidate like
		// #884 ships its own tokenizer; feeding the spliced vocab to the base model would emit ids past
		// its embedding table). Defaults to --tokenizer.
		"cand-tokenizer": { type: "string" },
		"model-card": { type: "string", default: "neural-weights-en-us/model-card.json" },
		"anchor-lookup": { type: "string" },
		"default-country": { type: "string", default: "US" },
		"wof-db": { type: "string" },
		n: { type: "string", default: "18" },
	},
})

if (!values.golden || !values.base || !values.cand || !values.tokenizer) {
	console.error("usage: coord-eyeball.ts --golden <jsonl> --base <onnx> --cand <onnx> --tokenizer <model> [--n 18]")
	process.exit(2)
}

const rows = readFileSync(values.golden, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
	.slice(0, Number(values.n))

const [{ WOFSqlitePlaceLookup }, { createScorer }, { createWOFResolver }] = await Promise.all([
	import("@mailwoman/resolver-wof-sqlite"),
	import("@mailwoman/neural/scorer"),
	import("@mailwoman/resolver"),
])

const anchorPath = values["anchor-lookup"] ?? dataRootPath("anchor", "pilot-anchor-lookup.json")
const wofDB = values["wof-db"] ?? dataRootPath("wof", "admin-global-priority.db")
const resolver = createWOFResolver(new WOFSqlitePlaceLookup({ databasePath: wofDB }) as never)
const resolveOpts = { defaultCountry: values["default-country"] }

async function build(modelPath: string, tokenizerPath: string) {
	return createScorer({
		modelPath,
		tokenizerPath,
		modelCardPath: values["model-card"]!,
		anchorLookupPath: anchorPath,
		strict: true,
		tier: "server" as const,
	})
}

const baseModel = await build(values.base!, values.tokenizer!)
const candModel = await build(values.cand!, values["cand-tokenizer"] ?? values.tokenizer!)

async function run(model: Awaited<ReturnType<typeof build>>, raw: string, gold: { lat: number; lon: number }) {
	const tree = await model.parse(raw, { postcodeRepair: true })
	const flat = decodeAsJSON(tree) as Record<string, string>
	let coord = "—"
	let err = "—"
	const best = mostSpecific(collectResolved(await resolver.resolveTree(tree, resolveOpts)))

	if (best) {
		coord = `${best.lat.toFixed(4)},${best.lon.toFixed(4)}`
		err = haversineKm(best.lat, best.lon, gold.lat, gold.lon).toFixed(1) + "km"
	}

	const parts = ["house_number", "street", "locality", "region", "postcode"]
		.map((k) => (flat[k] ? `${k}=${flat[k]}` : null))
		.filter(Boolean)
		.join("  ")

	return { parts, coord, err }
}

for (const row of rows) {
	const gold = { lat: row.lat, lon: row.lon }
	const b = await run(baseModel, row.raw, gold)
	const c = await run(candModel, row.raw, gold)
	console.log(`\n▶ ${row.raw}   [gold ${gold.lat.toFixed(4)},${gold.lon.toFixed(4)}]`)
	console.log(`  BASE  ${b.parts}`)
	console.log(`        → ${b.coord}  err=${b.err}`)
	console.log(`  CAND  ${c.parts}`)
	console.log(`        → ${c.coord}  err=${c.err}`)
}
