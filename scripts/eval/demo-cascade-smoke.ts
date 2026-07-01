/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Demo-cascade smoke eval (#524) — the whole-stack lens the per-layer gate battery lacks.
 *
 *   Runs each row of `data/eval/external/demo-cascade-smoke.jsonl` through the FULL stack exactly the
 *   way the demo (and any real consumer) composes it: neural parse with the ship config (gazetteer
 *   lexicon + postcode anchor + conventions mask + span bridge + FST) → `runPipeline`'s joint
 *   reconcile + grouper audit → the demo's `runCascade` (postcode → locality-with-region-bbox → raw
 *   text) over the Node lookup against the slim `wof-hot.db` the demo serves. Each row asserts the
 *   RESOLVED WOF PLACE ID of the top hit — not parse components. See the row README
 *   (`data/eval/external/demo-cascade-smoke.README.md`) for the convention.
 *
 *   Why: on 2026-06-11 three production bugs (#520/#521/#522) shipped through green gates because
 *   every gate lens is per-layer. Two of the three would have been caught by exactly this pass.
 *
 *   Usage (after `yarn compile`):
 *
 *   ```
 *   node --experimental-strip-types scripts/eval/demo-cascade-smoke.ts \
 *   [--stage-dir /tmp/v440-stage/en-us/v4.4.0] [--db <wof-hot.db>] [--model <onnx>] \
 *   [--tokenizer <tokenizer.model>] [--card <model-card.json>] [--fst <fst.bin>] \
 *   [--gazetteer-lexicon <lexicon.json>] [--file <rows.jsonl>] [--json <sidecar.json>] \
 *   [--explain]
 * ```
 *
 *   Defaults point at the staged demo release dir (`--stage-dir`, the byte-copies of what the live
 *   demo serves); `MAILWOMAN_WOF_HOT_DB` overrides the DB path (same env the #522 integration tests
 *   use). Exit 0 = the run completed (row failures are reported in the table + sidecar; the
 *   promotion-gate verdict enforces any floor). Exit 2 = missing artifacts / malformed rows.
 *
 *   Measurement only: this script changes no pipeline or resolver behavior.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { $public } from "@mailwoman/core/env"
import { runPipeline } from "@mailwoman/core/pipeline"
import type { AnchorLookup } from "@mailwoman/neural"
import { NeuralAddressClassifier, parseGazetteerLexicon, PostcodeBinaryResolver } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { groupPhrases } from "@mailwoman/phrase-grouper"
import { computeQueryShape } from "@mailwoman/query-shape"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"

// The demo's own composition helpers — imported (read-only) from the demo source so the smoke eval
// measures the REAL cascade, not a re-implementation that can drift from it.
import { flattenTree, runCascade } from "../../docs/src/shared/demo-helpers.ts"
import { arg } from "../lib/cli-args.ts"
import { parseSmokeRows, type SmokeRow } from "./demo-cascade-rows.ts"

const argv = process.argv.slice(2)

const STAGE = arg("stage-dir", "/tmp/v440-stage/en-us/v4.4.0")!
const DB = arg("db", $public.MAILWOMAN_WOF_HOT_DB ?? path.join(STAGE, "wof-hot.db"))!
const MODEL = arg("model", path.join(STAGE, "model.onnx"))!
const TOK = arg("tokenizer", path.join(STAGE, "tokenizer.model"))!
const CARD = arg("card", path.join(STAGE, "model-card.json"))!
const FST = arg("fst", path.join(STAGE, "fst-en-US.bin"))!
const GAZ = arg("gazetteer-lexicon", "data/gazetteer/anchor-lexicon-v1.json")!
const FILE = arg("file", "data/eval/external/demo-cascade-smoke.jsonl")!
const JSON_OUT = arg("json")
const EXPLAIN = argv.includes("--explain")

// ── Preflight: every artifact loud-missing, never a vague ENOENT mid-run ────────────────────────
const missing = Object.entries({
	db: DB,
	model: MODEL,
	tokenizer: TOK,
	"model-card": CARD,
	fst: FST,
	gazetteer: GAZ,
	rows: FILE,
})
	.filter(([, p]) => !existsSync(p))
	.map(([k, p]) => `  ${k}: ${p}`)

if (missing.length > 0) {
	console.error(
		`✗ demo-cascade smoke: missing artifacts —\n${missing.join("\n")}\n` +
			"  Stage a demo release (node docs/scripts/build-demo-assets.ts) or point --stage-dir / MAILWOMAN_WOF_HOT_DB at one."
	)
	process.exit(2)
}

let rows: SmokeRow[]

try {
	rows = parseSmokeRows(readFileSync(FILE, "utf8"), FILE)
} catch (error) {
	console.error(`✗ ${(error as Error).message}`)
	process.exit(2)
}

// ── Ship-config classifier (mirrors neural-web's loadNeuralClassifierFromUrls defaults) ─────────
const card = JSON.parse(readFileSync(CARD, "utf8"))

// Postcode anchor channel from the staged binaries — the same artifacts the demo fetches. Merge
// mirrors neural-web's mergeAnchorLookups: union posteriors, mean non-zero centroids.
function mergeAnchorLookups(lookups: readonly AnchorLookup[]): AnchorLookup {
	if (lookups.length === 1) return lookups[0]!
	const merged: AnchorLookup = new Map()

	for (const lookup of lookups) {
		for (const [postcode, entry] of lookup) {
			const existing = merged.get(postcode)

			if (!existing) {
				merged.set(postcode, { posterior: { ...entry.posterior }, lat: entry.lat, lon: entry.lon })
				continue
			}

			for (const country of Object.keys(entry.posterior)) existing.posterior[country] = 1

			if (entry.lat !== 0 || entry.lon !== 0) {
				if (existing.lat === 0 && existing.lon === 0) {
					existing.lat = entry.lat
					existing.lon = entry.lon
				} else {
					existing.lat = (existing.lat + entry.lat) / 2
					existing.lon = (existing.lon + entry.lon) / 2
				}
			}
		}
	}

	return merged
}

const postcodeBinaries = ["postcode-us.bin", "postcode-de.bin", "postcode-fr.bin"]
	.map((f) => path.join(STAGE, f))
	.filter((p) => existsSync(p))

if (postcodeBinaries.length === 0) {
	console.warn(`⚠ no postcode-*.bin under ${STAGE} — anchor channel unfed (anchor-trained models will degrade)`)
}
const anchorLookup =
	postcodeBinaries.length > 0
		? mergeAnchorLookups(postcodeBinaries.map((p) => new PostcodeBinaryResolver(readFileSync(p)).toAnchorLookup()))
		: undefined

const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), ONNXRunner.create(MODEL)])
const classifier = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	...(anchorLookup ? { postcodeAnchorLookup: anchorLookup } : {}),
	gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(GAZ, "utf8"))),
	suppressGazetteerNearPostcode: true,
	addressSystemConventions: "auto",
	bridgePunctuationGaps: true,
})
const fst = deserializeFST(readFileSync(FST))
const lookup = new WOFSqlitePlaceLookup({ databasePath: DB })

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────
interface RowResult {
	input: string
	expected: SmokeRow["expect"]
	actual: { id: number; name: string; placetype: string; anchorCentroid?: boolean } | null
	pass: boolean
	note?: string
}

const results: RowResult[] = []

for (const row of rows) {
	const { tree } = await runPipeline(row.input, {
		computeQueryShape,
		groupPhrases,
		classifier: classifier as unknown as Parameters<typeof runPipeline>[1]["classifier"],
		fst: fst as Parameters<typeof runPipeline>[1]["fst"],
	})

	// Node selection copied VERBATIM from the demo page (docs/src/pages/demo/index.tsx) — same
	// locality/city filter, same highest-confidence region pick, same postcode find.
	const nodes = flattenTree(tree)
	const localityNodes = nodes.filter((n) => n.tag === "locality" || n.tag === "city")
	const stateNode = nodes
		.filter((n) => n.tag === "region" || n.tag === "state")
		.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
	const postcodeNode = nodes.find((n) => n.tag === "postcode" || n.tag === "postal_code")

	const hits = await runCascade(
		lookup as unknown as Parameters<typeof runCascade>[0],
		postcodeNode,
		localityNodes,
		stateNode,
		row.input
	)

	// The demo's anchor-centroid fallback for postcode-only dead ends (WOF placeholder zeros / the
	// slim DB's absent postalcode rows): synthesize the approximate hit from the anchor channel.
	let anchorCentroid = false

	if (hits.length === 0 && postcodeNode?.value && anchorLookup) {
		const anchorHit = anchorLookup.get(String(postcodeNode.value).toUpperCase())

		if (anchorHit && (anchorHit.lat !== 0 || anchorHit.lon !== 0)) anchorCentroid = true
	}

	const top = hits[0]
	const actual = top
		? { id: top.id, name: top.name, placetype: String(top.placetype) }
		: anchorCentroid
			? { id: 0, name: `${postcodeNode?.value} (anchor centroid)`, placetype: "postcode", anchorCentroid: true }
			: null

	const pass = row.expect.anchor_centroid === true ? anchorCentroid : top?.id === row.expect.id
	results.push({ input: row.input, expected: row.expect, actual, pass, ...(row.note ? { note: row.note } : {}) })

	if (EXPLAIN) {
		console.error(`\n-- ${JSON.stringify(row.input)}`)
		console.error(
			`   parse: postcode=${JSON.stringify(postcodeNode?.value)} localities=${JSON.stringify(localityNodes.map((n) => n.value))} region=${JSON.stringify(stateNode?.value)}`
		)

		for (const h of hits.slice(0, 3)) {
			console.error(`   hit: id=${h.id} ${h.name} (${h.placetype}) score=${h.score?.toFixed?.(2)}`)
		}
	}
}
lookup.close()

// ── Report ───────────────────────────────────────────────────────────────────────────────────────
const passCount = results.filter((r) => r.pass).length
const passRate = Number(((100 * passCount) / results.length).toFixed(1))

console.log(`# Demo-cascade smoke (#524) — whole-stack parse→reconcile→resolve`)
console.log(`model: ${MODEL}`)
console.log(`db: ${DB}`)
console.log("")
console.log("| # | input | expected | actual | result |")
console.log("| - | ----- | -------- | ------ | ------ |")
results.forEach((r, i) => {
	const exp = r.expected.anchor_centroid
		? "anchor centroid"
		: `${r.expected.id} (${r.expected.name ?? "?"}${r.expected.placetype ? `, ${r.expected.placetype}` : ""})`
	const act = r.actual
		? r.actual.anchorCentroid
			? "anchor centroid"
			: `${r.actual.id} (${r.actual.name}, ${r.actual.placetype})`
		: "NO HIT"
	console.log(`| ${i + 1} | ${r.input} | ${exp} | ${act} | ${r.pass ? "PASS" : "FAIL"} |`)
})
console.log("")
console.log(`**${passCount}/${results.length} pass (${passRate}%)**`)

if (JSON_OUT) {
	const sidecar = {
		label: "demo-cascade-smoke",
		issue: 524,
		generated: new Date().toISOString(),
		db: DB,
		model: MODEL,
		rows: results,
		summary: { total: results.length, pass: passCount, fail: results.length - passCount, pass_rate_pct: passRate },
	}
	writeFileSync(JSON_OUT, JSON.stringify(sidecar, null, "\t"))
	console.log(`\nsidecar: ${JSON_OUT}`)
}
