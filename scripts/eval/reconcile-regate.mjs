/**
 * @copyright Sister Software
 * @license AGPL-3.0
 *
 *   Reconcile RE-GATE (post-#565). The grouper HN-bundling fix (#565) re-enabled joint-reconcile's
 *   street/HN precondition (US 20% → 91.7% in the bundling audit). Open question for re-promotion:
 *   does running the pipeline with `jointReconcile: true` now BEAT-OR-MATCH argmax (reconcile off,
 *   the #566 default) on FR/EU **without regressing US**? This grades the ASSEMBLED pipeline in
 *   both modes — never raw-neural F1 — which is the lesson of the retirement (see
 *   docs/articles/evals/2026-06-14-reconcile-retirement.md).
 *
 *   For each golden file it prints a per-tag recall table: raw-neural (reference) | argmax |
 *   reconcile | Δ(reconcile − argmax), flagging any tag where reconcile moves ≥2pp either way. The
 *   decision metric is the per-locale Δ column, US vs FR.
 *
 *   Usage: node scripts/eval/reconcile-regate.mjs <golden-a.jsonl> [golden-b.jsonl ...] Requires
 *   compiled out/ (yarn compile).
 */
import { readFileSync } from "node:fs"
import { basename } from "node:path"

const root = new URL("../../", import.meta.url)
const { NeuralAddressClassifier } = await import(new URL("neural/out/index.js", root).href)
const { createRuntimePipeline } = await import(new URL("mailwoman/out/runtime-pipeline.js", root).href)
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const pipeline = createRuntimePipeline({ classifier })

const STREET = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])
const TAGS = ["house_number", "street", "locality", "region", "postcode", "venue", "unit"]
const norm = (s) =>
	(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()

function collect(tree) {
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
const pct = (h, n) => (n ? ((100 * h) / n).toFixed(1) : "  - ")

for (const f of files) {
	const acc = { raw: {}, argmax: {}, rec: {} }
	for (const t of TAGS) for (const k of ["raw", "argmax", "rec"]) acc[k][t] = { h: 0, n: 0 }
	let n = 0
	for (const line of readFileSync(f, "utf8").trim().split("\n")) {
		const r = JSON.parse(line)
		if (!r.raw || !r.components) continue
		n++
		const rawT = collect(await classifier.parse(r.raw, { postcodeRepair: true }))
		const argT = collect((await pipeline(r.raw, { jointReconcile: false })).tree)
		const recT = collect((await pipeline(r.raw, { jointReconcile: true })).tree)
		for (const [tag, gv] of Object.entries(r.components)) {
			if (!TAGS.includes(tag)) continue
			;(acc.raw[tag].n++, (acc.argmax[tag].n++, acc.rec[tag].n++))
			if (hit(rawT, tag, gv)) acc.raw[tag].h++
			if (hit(argT, tag, gv)) acc.argmax[tag].h++
			if (hit(recT, tag, gv)) acc.rec[tag].h++
		}
	}
	console.log(`\n=== ${basename(f)}  (n=${n} addresses) ===`)
	console.log(`tag             raw      argmax   reconcile   Δ(rec−argmax)`)
	let worst = 0
	for (const t of TAGS) {
		const a = acc.argmax[t],
			c = acc.rec[t],
			rw = acc.raw[t]
		if (a.n === 0) continue
		const ap = (100 * a.h) / a.n,
			cp = (100 * c.h) / c.n,
			d = cp - ap
		if (d < worst) worst = d
		const flag = d <= -2 ? "  <-- reconcile WORSE" : d >= 2 ? "  <-- reconcile better" : ""
		console.log(
			`${t.padEnd(14)} ${pct(rw.h, rw.n).padStart(5)}%   ${pct(a.h, a.n).padStart(5)}%   ${pct(c.h, c.n).padStart(6)}%   ${(d >= 0 ? "+" : "") + d.toFixed(1)}pp${flag}`
		)
	}
	console.log(
		`worst Δ(rec−argmax) on this file: ${worst.toFixed(1)}pp  ${worst <= -2 ? "→ REGRESSION" : "→ no regression ≥2pp"}`
	)
}
