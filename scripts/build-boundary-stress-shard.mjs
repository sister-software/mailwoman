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
 *   Run: node scripts/build-boundary-stress-shard.mjs [--count 20000] [--seed 20260617]
 *        [--out data/corpus/shards/synth-boundary-stress.jsonl]
 */

import { createWriteStream, mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { alignRow } from "../corpus/out/src/align.js"
import { stableSourceId } from "../corpus/out/src/adapter.js"
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

mkdirSync(dirname(OUT), { recursive: true })
const out = createWriteStream(OUT)
let labeled = 0
let quarantined = 0
const byTemplate = {}
for (let i = 0; i < COUNT; i++) {
	const row = synthesizeBoundaryStressRow(undefined, { random })
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
		synth: { method: `boundary-stress:${row.template}`, base_source_id: source_id },
	}
	const r = alignRow(canonical)
	if (r.kind !== "labeled") {
		quarantined++
		continue
	}
	labeled++
	byTemplate[row.template] = (byTemplate[row.template] ?? 0) + 1
	out.write(JSON.stringify(r.row) + "\n")
}
out.end()
console.error(`wrote ${labeled} labeled rows (${quarantined} quarantined, ${((100 * quarantined) / COUNT).toFixed(1)}%) → ${OUT}`)
console.error("by template:", JSON.stringify(byTemplate))
