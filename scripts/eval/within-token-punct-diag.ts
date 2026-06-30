/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 follow-up: WHY does neural lose to v0 on within-token punctuation (apostrophe 81 vs 89,
 *   hyphen 81 vs 87, slash 62 vs 72 — `2026-06-14-punctuation-stress`)? This dumps neural's actual
 *   parse vs gold on the apostrophe/hyphen/slash classes so the failure MECHANISM is visible, not
 *   just the rate. Read-only diagnostic. Run: node --experimental-strip-types
 *   scripts/eval/within-token-punct-diag.ts
 */

import { readFileSync } from "node:fs"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const CLASSES = new Set(["apostrophe", "hyphen", "slash"])
const rows = readFileSync("data/eval/external/punctuation-stress.jsonl", "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as { raw: string; components: Record<string, string>; class: string })
	.filter((r) => CLASSES.has(r.class))

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

const tally: Record<string, { n: number; miss: number; missKeys: Record<string, number> }> = {}

for (const r of rows) {
	const t = (tally[r.class] ??= { n: 0, miss: 0, missKeys: {} })
	t.n++
	const json = decodeAsJSON(await classifier.parse(r.raw, { postcodeRepair: true })) as Record<string, unknown>
	// decodeAsJSON is a (mostly flat) component dict; collect string leaves keyed by component name.
	const got: Record<string, string> = {}
	const collect = (o: Record<string, unknown>): void => {
		for (const [k, v] of Object.entries(o)) {
			if (typeof v === "string") got[k] = v
			else if (v && typeof v === "object") collect(v as Record<string, unknown>)
		}
	}
	collect(json)
	const diffs: string[] = []

	for (const [k, gold] of Object.entries(r.components)) {
		const g = (got[k] ?? "").toLowerCase().trim()

		if (g !== String(gold).toLowerCase().trim()) {
			diffs.push(`${k}: gold=${JSON.stringify(gold)} got=${JSON.stringify(got[k] ?? "∅")}`)
			t.missKeys[k] = (t.missKeys[k] ?? 0) + 1
		}
	}

	if (diffs.length) {
		t.miss++
		console.log(`\n[${r.class}] ${r.raw}`)
		console.log(`  got: ${JSON.stringify(got)}`)

		for (const d of diffs) console.log(`  ✗ ${d}`)
	}
}
console.log("\n=== summary ===")

for (const [cls, t] of Object.entries(tally)) {
	const topKeys = Object.entries(t.missKeys)
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k}:${n}`)
		.join(" ")
	console.log(`${cls}: ${t.miss}/${t.n} rows with ≥1 mismatch | miss-keys: ${topKeys}`)
}
