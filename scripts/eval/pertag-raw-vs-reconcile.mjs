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
 *   Usage: node scripts/eval/pertag-raw-vs-reconcile.mjs <golden-a.jsonl> [golden-b.jsonl ...]
 */
import { readFileSync } from "node:fs"
const root = new URL("../../", import.meta.url)
const { NeuralAddressClassifier } = await import(new URL("neural/out/index.js", root).href)
const { createRuntimePipeline } = await import(new URL("mailwoman/out/runtime-pipeline.js", root).href)
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })
const STREET = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])
const norm = (s) =>
	(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
function collect(tree) {
	// returns map tag -> [values], plus assembled street
	const byTag = {}
	const st = [...tree.roots]
	const streetParts = []
	while (st.length) {
		const n = st.pop()
		if (STREET.has(n.tag) && n.value?.trim()) streetParts.push({ s: n.start, v: n.value.trim() })
		;(byTag[n.tag] ??= []).push(n.value?.trim() || "")
		st.push(...(n.children || []))
	}
	streetParts.sort((a, b) => a.s - b.s)
	byTag.__street_assembled = [streetParts.map((p) => p.v).join(" ")]
	return byTag
}
function hit(byTag, tag, goldVal) {
	const g = norm(goldVal)
	if (tag === "street") {
		const a = norm(byTag.__street_assembled?.[0])
		if (a && (a === g || a.includes(g) || g.includes(a))) return true
	}
	const vals = (byTag[tag] || []).map(norm)
	return vals.some((v) => v && (v === g || v.includes(g) || g.includes(v)))
}
const files = process.argv.slice(2)
const tags = ["house_number", "street", "locality", "region", "postcode", "venue", "unit"]
const acc = { raw: {}, rec: {} }
for (const t of tags) {
	acc.raw[t] = { h: 0, n: 0 }
	acc.rec[t] = { h: 0, n: 0 }
}
let n = 0
for (const f of files) {
	for (const line of readFileSync(f, "utf8").trim().split("\n")) {
		const r = JSON.parse(line)
		if (!r.raw || !r.components) continue
		n++
		const rawT = collect(await classifier.parse(r.raw, { postcodeRepair: true }))
		const recT = collect((await pipeline(r.raw)).tree)
		for (const [tag, gv] of Object.entries(r.components)) {
			if (!tags.includes(tag)) continue
			acc.raw[tag].n++
			if (hit(rawT, tag, gv)) acc.raw[tag].h++
			acc.rec[tag].n++
			if (hit(recT, tag, gv)) acc.rec[tag].h++
		}
	}
}
const pct = (h, n) => (n ? ((100 * h) / n).toFixed(1) : "  - ")
console.log(`per-tag recall  raw-neural  vs  runtime-pipeline   (n=${n} addresses)\n`)
console.log(`tag             raw      pipeline   delta(pipe-raw)`)
for (const t of tags) {
	const r = acc.raw[t],
		c = acc.rec[t]
	if (r.n === 0) continue
	const rp = (100 * r.h) / r.n,
		cp = (100 * c.h) / c.n,
		d = cp - rp
	const flag = d <= -2 ? "  <-- pipeline WORSE" : d >= 2 ? "  <-- pipeline better" : ""
	console.log(
		`${t.padEnd(14)} ${pct(r.h, r.n).padStart(5)}%   ${pct(c.h, c.n).padStart(6)}%   ${(d >= 0 ? "+" : "") + d.toFixed(1)}pp${flag}`
	)
}
