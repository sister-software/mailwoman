/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   DeepSeek diagnostic (2026-06-07): is the international-order German locality collapse driven by
 *   the adjacent same-token "City, Region" pairs (Berlin's locality == its region) confusing the
 *   PARSE, vs a purely positional anchor problem? Splits the international-order de-sample by
 *   whether expected locality == expected region (the city-states: Berlin/Hamburg/Bremen) vs
 *   distinct (München/Bayern), and reports the model's locality-span correctness in each bucket.
 *
 *   If duplicates are much worse than distinct → token-level confusion (dual-injection won't fix it).
 *   If both are equally poor → the positional-anchor hypothesis holds (v0.9.4 is the right fix).
 *
 *   Parse-level (no resolver): we check whether the model's locality span matches the expected
 *   locality.
 *
 *   Run: node --experimental-strip-types scripts/eval/de-duplicate-locality-diag.ts\
 *   --eval data/eval/external/openaddresses-de-sample.jsonl\
 *   --model /tmp/v093-eval/model.onnx --model-card neural-weights-en-us/model-card.json\
 *   [--anchor-lookup /mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json]
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { readFileSync } from "node:fs"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface OaRow {
	input: string
	expected: { locality?: string; region?: string }
}

function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ")
}
function valueMatch(pred: string, gold: string): boolean {
	const a = norm(pred)
	const b = norm(gold)
	if (!a || !b) return false
	if (a === b) return true
	const aset = new Set(a.split(" "))
	const bset = new Set(b.split(" "))
	const subset = (xs: Set<string>, ys: Set<string>): boolean => [...xs].every((t) => ys.has(t))
	return subset(aset, bset) || subset(bset, aset)
}
function firstByTag(tree: AddressTree, tag: string): AddressNode | undefined {
	let found: AddressNode | undefined
	const walk = (n: AddressNode): void => {
		if (found) return
		if (n.tag === tag) found = n
		else for (const c of n.children) walk(c)
	}
	for (const r of tree.roots) walk(r)
	return found
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/openaddresses-de-sample.jsonl")
	const rows: OaRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))

	const { NeuralAddressClassifier, parseAnchorLookup } = await import("@mailwoman/neural")
	const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
	const modelCard = JSON.parse(readFileSync(arg("model-card", "neural-weights-en-us/model-card.json"), "utf8"))
	const anchorPath = arg("anchor-lookup", "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json")
	const postcodeAnchorLookup = anchorPath ? parseAnchorLookup(JSON.parse(readFileSync(anchorPath, "utf8"))) : undefined
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(
			arg("tokenizer", "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model")
		),
		OnnxRunner.create(arg("model", "/tmp/v093-eval/model.onnx")),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels, postcodeAnchorLookup })
	const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]

	const acc = { dup: { ok: 0, n: 0 }, distinct: { ok: 0, n: 0 } }
	let i = 0
	for (const row of rows) {
		i++
		if (i % 1000 === 0) console.error(`  ${i}/${rows.length}`)
		const loc = row.expected.locality
		const reg = row.expected.region
		if (!loc) continue
		const isDup = !!reg && norm(loc) === norm(reg)
		const bucket = isDup ? acc.dup : acc.distinct
		bucket.n++
		let tree: AddressTree
		try {
			tree = await neural.parse(row.input, parseOpts)
		} catch {
			continue
		}
		const pred = firstByTag(tree, "locality")
		if (pred && valueMatch(pred.value, loc)) bucket.ok++
	}

	const pct = (b: { ok: number; n: number }): string => (b.n ? ((100 * b.ok) / b.n).toFixed(1) : "0.0") + "%"
	console.log(`# DE intl locality-parse — duplicate (locality==region) vs distinct`)
	console.log(``)
	console.log(`| bucket | n | locality-parse correct |`)
	console.log(`| --- | ---: | ---: |`)
	console.log(`| duplicate (Berlin/Berlin) | ${acc.dup.n} | ${pct(acc.dup)} |`)
	console.log(`| distinct (München/Bayern) | ${acc.distinct.n} | ${pct(acc.distinct)} |`)
	console.error(`\nduplicate ${pct(acc.dup)} (n=${acc.dup.n}) vs distinct ${pct(acc.distinct)} (n=${acc.distinct.n})`)
}

void main()
