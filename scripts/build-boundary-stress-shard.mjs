/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #375 — build the boundary-instability synthetic shard. Wraps `synthesizeBoundaryStressRow`
 *   (`corpus/src/synthesize-boundary-stress.ts`) through the real `alignRow` aligner and writes a
 *   LabeledRow JSONL the corpus build / a Modal training run can ride. Concrete groundwork for the
 *   taxonomy's #1 parser lever (the boundary-wobble family); no retrain happens here.
 *
 *   Imports the COMPILED corpus (`corpus/out/src/*.js`) — `alignRow` has internal `.js` runtime
 *   imports the strip-types loader can't resolve from source, so `tsc -b` first.
 *
 *   Run: node scripts/build-boundary-stress-shard.mjs [--count 20000] [--seed 20260617] [--out
 *   data/corpus/shards/synth-boundary-stress.jsonl]
 */

import { createWriteStream, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { stableSourceId } from "../corpus/out/src/adapter.js"
import { alignRow } from "../corpus/out/src/align.js"
import { synthesizeBoundaryStressRow } from "../corpus/out/src/synthesize-boundary-stress.js"

const arg = (n, d) => {
	const i = process.argv.indexOf(`--${n}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const COUNT = Number(arg("count", "20000"))
const OUT = arg("out", "data/corpus/shards/synth-boundary-stress.jsonl")
const SEED = Number(arg("seed", "20260617"))

function mulberry32(seed) {
	let a = seed >>> 0
	return () => {
		a |= 0
		a = (a + 0x6d2b79f5) | 0
		let t = Math.imul(a ^ (a >>> 15), 1 | a)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
const random = mulberry32(SEED)

// Revised composition (v1.7.0, DeepSeek-tuned 2026-06-18). The v1.6.0 shard was uniform over 4 shapes;
// the probes showed it over-fit a narrow distribution. Weighted now: `bare-locality` ~11% (recover the
// 84% locality drop on bare "City, STATE" rows WITHOUT becoming a locality-first majority — the base
// already carries ~5-8%), and `house-number-before:after` = 7:3 (FR's own dominant order is number-BEFORE;
// 30% after is enough to break the order-bias shortcut without risking FR hn-before accuracy via shared
// cross-locale capacity). The three original non-number shapes keep the bulk. Weights sum to 1.0.
const WEIGHTS = {
	"street-eats-affix": 0.22,
	"comma-less-city-state": 0.22,
	"fr-prefix": 0.18,
	"bare-locality": 0.11,
	"house-number-before-street": 0.189,
	"house-number-after-street": 0.081,
}
const CUM = (() => {
	let acc = 0
	return Object.entries(WEIGHTS).map(([t, w]) => [t, (acc += w)])
})()
function pickTemplate(r) {
	const x = r()
	for (const [t, c] of CUM) if (x <= c) return t
	return CUM[CUM.length - 1][0]
}

mkdirSync(dirname(OUT), { recursive: true })
const out = createWriteStream(OUT)
let labeled = 0
let quarantined = 0
const byTemplate = {}
for (let i = 0; i < COUNT; i++) {
	const row = synthesizeBoundaryStressRow(undefined, { random, forceTemplate: pickTemplate(random) })
	const country = row.locale.split("-")[1] ?? "US"
	const source_id = stableSourceId("synth-boundary-stress", { ...row.components, v: String(i) })
	const canonical = {
		raw: row.raw,
		components: row.components,
		country,
		locale: row.locale,
		source: "synth-boundary-stress",
		source_id,
		corpus_version: "0.6.0",
		license: "Synthetic — boundary-stress; derived from public-domain locality/region tuples",
	}
	const r = alignRow(canonical)
	if (r.kind !== "labeled") {
		quarantined++
		continue
	}
	labeled++
	byTemplate[row.template] = (byTemplate[row.template] ?? 0) + 1
	// Match the base corpus parquet schema: flat synth_method / synth_base_id (the synthesize-* pattern),
	// not a nested `synth` object.
	out.write(JSON.stringify({ ...r.row, synth_method: `boundary-stress:${row.template}`, synth_base_id: null }) + "\n")
}
out.end()
console.error(
	`wrote ${labeled} labeled rows (${quarantined} quarantined, ${((100 * quarantined) / COUNT).toFixed(1)}%) → ${OUT}`
)
console.error("by template:", JSON.stringify(byTemplate))
