/**
 * Risk-probe for the LocalePrior architecture (DeepSeek consult 2026-06-03). Measures whether the
 * postcode anchor alone can supply a confident country signal — the assumption PR2 (locale-prior
 * replacing --default-country) rides on. For each OA address: highest-confidence anchor's posterior
 * → max-prob, argmax, k. Reports: anchor-presence, high-confidence-rate (max-prob>0.9),
 * argmax-correctness, k-histogram.
 */
import { extractPostcodeAnchors } from "@mailwoman/neural/postcode-anchor"
import { WofPostcodeLookup } from "@mailwoman/resolver-wof-sqlite"
import { readFileSync } from "node:fs"

const SHARDS = [
	"/mnt/playpen/mailwoman-data/wof/postalcode-us.db",
	"/mnt/playpen/mailwoman-data/wof/postalcode-intl.db",
]
const lookup = new WofPostcodeLookup(SHARDS)

function probe(path: string, trueCountry: string, limit = 1500) {
	const rows = readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.slice(0, limit)
		.map((l) => JSON.parse(l))
	let noAnchor = 0,
		withAnchor = 0,
		highConf = 0,
		highConfCorrect = 0,
		argmaxCorrect = 0
	const kHist: Record<number, number> = {}
	for (const r of rows) {
		const input = r.input ?? r.text ?? ""
		const anchors = extractPostcodeAnchors(input, lookup)
		// highest-confidence anchor with a non-empty posterior
		const placed = anchors.filter((a) => Object.keys(a.posterior).length > 0)
		if (placed.length === 0) {
			noAnchor++
			continue
		}
		withAnchor++
		const best = placed.reduce((m, a) => (a.confidence > m.confidence ? a : m))
		const entries = Object.entries(best.posterior).sort((x, y) => y[1] - x[1])
		const [argCountry, maxProb] = entries[0]!
		const k = entries.length
		kHist[k] = (kHist[k] ?? 0) + 1
		if (argCountry.toUpperCase() === trueCountry) argmaxCorrect++
		if (maxProb > 0.9) {
			highConf++
			if (argCountry.toUpperCase() === trueCountry) highConfCorrect++
		}
	}
	const n = rows.length
	const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`
	console.log(`\n=== ${trueCountry} sample (${n} rows) ===`)
	console.log(`  anchor present:        ${pct(withAnchor)}  (no anchor: ${pct(noAnchor)})`)
	console.log(`  HIGH-CONF (maxprob>0.9): ${pct(highConf)}   <-- the gate metric (bar ~60%)`)
	console.log(
		`    ...of which argmax == ${trueCountry}: ${highConf ? ((100 * highConfCorrect) / highConf).toFixed(1) : "0"}%`
	)
	console.log(`  argmax == ${trueCountry} (any conf): ${pct(argmaxCorrect)}`)
	console.log(`  k (countries in posterior) histogram: ${JSON.stringify(kHist)}`)
}

probe("data/eval/external/openaddresses-us-sample.jsonl", "US")
probe("data/eval/external/openaddresses-de-sample.jsonl", "DE")
lookup.close()
