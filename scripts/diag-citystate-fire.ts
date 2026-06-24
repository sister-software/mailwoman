/**
 * Diagnose why --city-state-fallback (#387) doesn't fire on the real DE intl Berlin rows. Parses a
 * few Berlin addresses with the v0.9.4 model, resolves with cityStateFallback, and prints the tree
 * shape: does the parse emit a locality node? does the region resolve? does a synthesized node
 * appear?
 *
 * Node --experimental-strip-types scripts/diag-citystate-fire.ts
 */
import { readFileSync } from "node:fs"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { createWofResolver } from "@mailwoman/resolver"
import { NeuralAddressClassifier, parseAnchorLookup } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const MODEL = "/tmp/v094-eval/model.onnx"
const CARD = "neural-weights-en-us/model-card.json"
const TOK = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const WOF =
	"/mnt/playpen/mailwoman-data/wof/admin-global-priority.db,/mnt/playpen/mailwoman-data/wof/postcode-locality-intl.db"
const LOOKUP = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"

const samples = [
	"27 Straußstraße, Berlin, Berlin 12623",
	"5 Hauptstraße, Berlin, Berlin 10115",
	"12 Müllerstraße, Berlin, Berlin 13353",
]

function describe(n: AddressNode, depth = 0): string {
	const pad = "  ".repeat(depth)
	const resolved = n.placeId ? ` → ${n.sourceId} (${n.lat?.toFixed(3)},${n.lon?.toFixed(3)})` : " [unresolved]"
	const synth = (n.metadata as Record<string, unknown> | undefined)?.["resolver_synthesized"] ? " «SYNTH»" : ""
	return [`${pad}${n.tag} "${n.value}"${resolved}${synth}`, ...n.children.map((c) => describe(c, depth + 1))].join("\n")
}

const card = JSON.parse(readFileSync(CARD, "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), OnnxRunner.create(MODEL)])
const anchorLookup = parseAnchorLookup(JSON.parse(readFileSync(LOOKUP, "utf8")))
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: anchorLookup,
})
const backend = new WofSqlitePlaceLookup({ databasePath: WOF.split(",") })
const resolver = createWofResolver(backend as never)

for (const input of samples) {
	const tree = (await neural.parse(input)) as AddressTree
	const tags = new Set<string>()
	const collect = (n: AddressNode) => {
		tags.add(n.tag)
		n.children.forEach(collect)
	}
	tree.roots.forEach(collect)
	const out = await resolver.resolveTree(tree, { defaultCountry: "DE", cityStateFallback: true })
	console.log(`\n=== "${input}" ===`)
	console.log(`  parse tags: ${[...tags].join(", ")}  | has locality node: ${tags.has("locality")}`)
	console.log(describe({ tag: "ROOT", value: "", start: 0, end: 0, confidence: 0, children: out.roots } as AddressNode))
	// Serializer sanity: does a synthesized node render without throwing / producing garbage?
	try {
		const { decodeAsXml, decodeAsJson } = await import("@mailwoman/core/decoder")
		console.log("  XML:", String(decodeAsXml(out)).replace(/\n\s*/g, " ").slice(0, 200))
		console.log("  JSON:", JSON.stringify(decodeAsJson(out)).slice(0, 200))
	} catch (e) {
		console.log("  SERIALIZER THREW:", (e as Error).message)
	}
}
;(backend as { close?: () => void }).close?.()
