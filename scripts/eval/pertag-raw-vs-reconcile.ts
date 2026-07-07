import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Per-tag recall: raw neural (`classifier.parse`, with street reassembled from its child
 *   prefix/suffix nodes) vs the assembled runtime pipeline, on golden rows carrying gold
 *   `components`. Built 2026-06-14 for the joint-reconcile retirement decision; see
 *   docs/articles/evals/2026-06-14-reconcile-retirement.md. Value-match is loose (normalized
 *   substring), applied identically to both columns so the delta is fair. Requires compiled
 *   `out/`.
 *
 *   Usage: node scripts/eval/pertag-raw-vs-reconcile.ts <golden-a.jsonl> [golden-b.jsonl ...]
 */
import type { AddressTree } from "@mailwoman/core/decoder"

const { positionals } = parseArgs({ allowPositionals: true, strict: false })
interface NeuralClassifier {
	parse(input: string, opts?: { postcodeRepair?: boolean }): Promise<AddressTree>
}
interface RuntimePipeline {
	(input: string): Promise<{ tree: AddressTree }>
}
interface GoldenRow {
	raw?: string
	components?: Record<string, string>
}

const root = new URL("../../", import.meta.url)
const { NeuralAddressClassifier } = (await import(new URL("neural/out/index.js", root).href)) as {
	NeuralAddressClassifier: { loadFromWeights(opts: { locale: string }): Promise<NeuralClassifier> }
}
const { createRuntimePipeline } = (await import(new URL("mailwoman/out/runtime-pipeline.js", root).href)) as {
	createRuntimePipeline(opts: { classifier: NeuralClassifier }): RuntimePipeline
}
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })
const STREET = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])
const norm = (s: string | undefined): string =>
	(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
type ByTag = Record<string, string[]>
function collect(tree: AddressTree): ByTag {
	// returns map tag -> [values], plus assembled street
	const byTag: ByTag = {}
	const st = [...tree.roots]
	const streetParts: Array<{ s: number; v: string }> = []

	while (st.length) {
		const n = st.pop()!

		if (STREET.has(n.tag) && n.value?.trim()) {
			streetParts.push({ s: n.start, v: n.value.trim() })
		}
		;(byTag[n.tag] ??= []).push(n.value?.trim() || "")
		st.push(...(n.children || []))
	}
	streetParts.sort((a, b) => a.s - b.s)
	byTag.__street_assembled = [streetParts.map((p) => p.v).join(" ")]

	return byTag
}
function hit(byTag: ByTag, tag: string, goldVal: string): boolean {
	const g = norm(goldVal)

	if (tag === "street") {
		const a = norm(byTag.__street_assembled?.[0])

		if (a && (a === g || a.includes(g) || g.includes(a))) return true
	}
	const vals = (byTag[tag] || []).map(norm)

	return vals.some((v) => v && (v === g || v.includes(g) || g.includes(v)))
}
const files = positionals
const tags = ["house_number", "street", "locality", "region", "postcode", "venue", "unit"]
type Counts = { h: number; n: number }
const acc: { raw: Record<string, Counts>; rec: Record<string, Counts> } = { raw: {}, rec: {} }

for (const t of tags) {
	acc.raw[t] = { h: 0, n: 0 }
	acc.rec[t] = { h: 0, n: 0 }
}
let n = 0

for (const f of files) {
	for (const line of readFileSync(f, "utf8").trim().split("\n")) {
		const r = JSON.parse(line) as GoldenRow

		if (!r.raw || !r.components) continue
		n++
		const rawT = collect(await classifier.parse(r.raw, { postcodeRepair: true }))
		const recT = collect((await pipeline(r.raw)).tree)

		for (const [tag, gv] of Object.entries(r.components)) {
			if (!tags.includes(tag)) continue
			acc.raw[tag]!.n++

			if (hit(rawT, tag, gv)) {
				acc.raw[tag]!.h++
			}
			acc.rec[tag]!.n++

			if (hit(recT, tag, gv)) {
				acc.rec[tag]!.h++
			}
		}
	}
}
const pct = (h: number, n: number): string => (n ? ((100 * h) / n).toFixed(1) : "  - ")
console.log(`per-tag recall  raw-neural  vs  runtime-pipeline   (n=${n} addresses)\n`)
console.log(`tag             raw      pipeline   delta(pipe-raw)`)

for (const t of tags) {
	const r = acc.raw[t]!,
		c = acc.rec[t]!

	if (r.n === 0) continue
	const rp = (100 * r.h) / r.n,
		cp = (100 * c.h) / c.n,
		d = cp - rp
	const flag = d <= -2 ? "  <-- pipeline WORSE" : d >= 2 ? "  <-- pipeline better" : ""
	console.log(
		`${t.padEnd(14)} ${pct(r.h, r.n).padStart(5)}%   ${pct(c.h, c.n).padStart(6)}%   ${(d >= 0 ? "+" : "") + d.toFixed(1)}pp${flag}`
	)
}
