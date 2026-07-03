/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diagnose the FR street parse-recall gap (#148): the en-US model fragments a French street when no
 *   postcode anchors it ("Rue du Chevaleret, Paris" → street="Rue du", locality="Chevaleret"). Sample
 *   real FR addresses from the OSM shard, parse each BARE ("<n> <street>, <city>") and ANCHORED
 *   ("<n> <street>, <pc> <city>"), assemble the street key (FR locale) and check it matches the shard's
 *   street_norm. The bare-vs-anchored match-rate delta IS the gap, and isolates whether the model only
 *   learned FR structure in the postcode-anchored context.
 *
 *   Run: node scripts/diagnostic/fr-parse-recall.ts
 */

import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier, parseGazetteerLexicon, PostcodeBinaryResolver } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { normalizeStreetForKeyLocale } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { mailwomanDataRoot } from "mailwoman/resolver-backend"

const STREET_TAGS = new Set(["street", "street_prefix", "street_suffix"])

const { values: args } = parseArgs({
	options: {
		// Candidate-pair override (the v2.2.0 salvage read). Argless = the installed weights package
		// via loadFromWeights, unchanged. When a pair is given, the classifier is built MANUALLY with
		// the ship-config channels fed from the INSTALLED package's model-independent artifacts
		// (postcode bins + gazetteer lexicon) — the explicit-path resolveWeights drops the soft-feed
		// siblings, and an unfed arm vs a fed arm is not a comparison.
		model: { type: "string" },
		tokenizer: { type: "string" },
		"model-card": { type: "string", default: "neural-weights-en-us/model-card.json" },
		label: { type: "string", default: "" },
	},
})

const db = new DatabaseSync(`${mailwomanDataRoot()}/osm/address-points-fr-fr.db`, { readOnly: true })
// Distinct streets with a city + postcode, sampled across the table (not one street repeated).
const rows = db
	.prepare(
		`SELECT street_raw, number, locality_norm, postcode FROM address_point
		 WHERE locality_norm IS NOT NULL AND postcode IS NOT NULL AND street_raw LIKE '% %'
		 GROUP BY street_norm ORDER BY number LIMIT 40`
	)
	.all() as Array<{ street_raw: string; number: string; locality_norm: string; postcode: string }>

async function buildClassifier(): Promise<NeuralAddressClassifier> {
	if (!args.model || !args.tokenizer) return NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

	const card = JSON.parse(readFileSync(args["model-card"]!, "utf8")) as { labels: string[] }
	const anchor = new PostcodeBinaryResolver(readFileSync("neural-weights-en-us/postcode-us.bin")).toAnchorLookup()
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(args.tokenizer),
		ONNXRunner.create(args.model),
	])

	return new NeuralAddressClassifier({
		tokenizer,
		runner,
		labels: card.labels,
		postcodeAnchorLookup: anchor,
		gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync("neural-weights-en-us/anchor-lexicon-v1.json", "utf8"))),
		suppressGazetteerNearPostcode: true,
		addressSystemConventions: "auto",
		bridgePunctuationGaps: true,
	})
}

const classifier = await buildClassifier()

if (args.label) console.log(`[pair] ${args.label}: model=${args.model ?? "package"} tokenizer=${args.tokenizer ?? "package"}`)

function streetKeyOf(tree: {
	roots: readonly { tag: string; value: string; start: number; children: readonly unknown[] }[]
}): string {
	const parts: Array<{ value: string; start: number }> = []
	const stack = [...tree.roots]

	while (stack.length) {
		const n = stack.pop()! as { tag: string; value: string; start: number; children: readonly unknown[] }

		if (STREET_TAGS.has(n.tag) && n.value.trim()) parts.push({ value: n.value.trim(), start: n.start })
		stack.push(...(n.children as typeof stack))
	}
	parts.sort((a, b) => a.start - b.start)

	return normalizeStreetForKeyLocale(parts.map((p) => p.value).join(" "), "fr")
}

let bareOk = 0
let anchoredOk = 0
const fails: string[] = []

for (const r of rows) {
	const want = normalizeStreetForKeyLocale(r.street_raw, "fr")
	const bareQ = `${r.number} ${r.street_raw}, ${r.locality_norm}`
	const anchQ = `${r.number} ${r.street_raw}, ${r.postcode} ${r.locality_norm}`
	const bare = streetKeyOf(await classifier.parse(bareQ, { postcodeRepair: true, normalizeCase: true }))
	const anch = streetKeyOf(await classifier.parse(anchQ, { postcodeRepair: true, normalizeCase: true }))

	if (bare === want) bareOk++

	if (anch === want) anchoredOk++

	if (bare !== want && fails.length < 12)
		fails.push(`  ✗ bare "${r.street_raw}" → "${bare}" (want "${want}")  | anchored→"${anch}"`)
}

console.log(`\nFR street parse-recall on ${rows.length} real OSM addresses:`)
console.log(
	`  BARE     (no postcode): ${bareOk}/${rows.length} streets intact  (${((bareOk / rows.length) * 100).toFixed(0)}%)`
)
console.log(
	`  ANCHORED (w/ postcode): ${anchoredOk}/${rows.length} streets intact  (${((anchoredOk / rows.length) * 100).toFixed(0)}%)`
)
console.log(`\nbare failures:`)

for (const f of fails) console.log(f)
