/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parser Coverage Audit — per-US-state gate for the coordinate tiers.
 *
 *   The geocoder's street-level coordinate tiers (address-point and interpolation) require the parser
 *   to emit a clean (house_number, street, postcode) triple. "Street" must reassemble to its FULL
 *   name — the street node value PLUS any street_prefix / street_prefix_particle / street_suffix
 *   CHILDREN, ordered by offset (see `assembleStreetValue` in core/resolver/resolve.ts). A row that
 *   silently drops any member of that triple — or assembles a bare street name when a prefix/suffix
 *   is present — is a coordinate-tier failure.
 *
 *   This script measures, PER US STATE, how often the neural parser satisfies that precondition on a
 *   held-out OA sample. No go/no-go decision is made here — the orchestrator reads the table.
 *
 *   Usage: node --experimental-strip-types scripts/eval/parser-coverage-audit.ts\
 *   --model /mnt/playpen/mailwoman-data/models/quantized/model-v150-step-40000-int8.onnx\
 *   --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   [--eval data/eval/external/openaddresses-us-sample.jsonl]\
 *   [--per-state-cap 300]\
 *   [--model-anchor-lookup /mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json]\
 *   [--gazetteer-lexicon <path>]
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { readFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

const DEFAULT_MODEL = "/mnt/playpen/mailwoman-data/models/quantized/model-v150-step-40000-int8.onnx"
const DEFAULT_TOKENIZER = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const DEFAULT_MODEL_CARD = "neural-weights-en-us/model-card.json"
const DEFAULT_EVAL = "data/eval/external/openaddresses-us-sample.jsonl"
const DEFAULT_CAP = 300

const modelPath = arg("model", DEFAULT_MODEL)
const tokenizerPath = arg("tokenizer", DEFAULT_TOKENIZER)
const modelCardPath = arg("model-card", DEFAULT_MODEL_CARD)
const evalPath = arg("eval", DEFAULT_EVAL)
const perStateCap = parseInt(arg("per-state-cap", String(DEFAULT_CAP)), 10)
const anchorPath = arg("model-anchor-lookup", "")
const gazetteerPath = arg("gazetteer-lexicon", "")

// ---------------------------------------------------------------------------
// OA row shape
// ---------------------------------------------------------------------------

interface OaRow {
	input: string
	lat?: number
	lon?: number
	expected?: { locality?: string; region?: string; postcode?: string }
	state: string
	source?: string
}

// ---------------------------------------------------------------------------
// Street name tags (mirrors assembleStreetValue in core/resolver/resolve.ts)
// ---------------------------------------------------------------------------

const STREET_NAME_TAGS = new Set(["street", "street_prefix", "street_prefix_particle", "street_suffix"])

/**
 * Reassemble the full street string from a street node's subtree. Mirrors `assembleStreetValue` in
 * core/resolver/resolve.ts exactly — DFS over children, collect STREET_NAME_TAGS members (trimmed +
 * non-empty), sort by .start, join with spaces.
 */
function assembleStreetValue(streetNode: AddressNode): string {
	const parts: AddressNode[] = []
	const stack: AddressNode[] = [streetNode]
	while (stack.length > 0) {
		const n = stack.pop()!
		if (STREET_NAME_TAGS.has(n.tag) && n.value.trim()) parts.push(n)
		stack.push(...n.children)
	}
	parts.sort((a, b) => a.start - b.start)
	return parts.map((n) => n.value.trim()).join(" ")
}

// ---------------------------------------------------------------------------
// Tree walkers
// ---------------------------------------------------------------------------

/** Walk all nodes in the tree (depth-first). */
function* walkTree(roots: AddressNode[]): Generator<AddressNode> {
	const stack = [...roots]
	while (stack.length > 0) {
		const n = stack.pop()!
		yield n
		stack.push(...n.children)
	}
}

/** Find the FIRST node with a given tag (depth-first). */
function findTag(roots: AddressNode[], tag: string): AddressNode | undefined {
	for (const n of walkTree(roots)) {
		if (n.tag === tag) return n
	}
	return undefined
}

// ---------------------------------------------------------------------------
// Per-row analysis
// ---------------------------------------------------------------------------

interface RowResult {
	input: string
	state: string
	has_house_number: boolean
	has_street: boolean
	has_postcode: boolean
	/** All three present. */
	precondition: boolean
	/** Reassembled street string (may equal bare street.value when no affixes). */
	reassembled_street: string
	/** True when reassembled_street differs from the bare street node value. */
	reassembly_differs: boolean
	/** Tags the parser actually produced (for failure samples). */
	tags_found: string[]
}

function analyzeRow(input: string, state: string, tree: AddressTree): RowResult {
	const roots = tree.roots

	const streetNode = findTag(roots, "street")
	const hnNode = findTag(roots, "house_number")
	const pcNode = findTag(roots, "postcode")

	const has_house_number = hnNode !== undefined
	const has_street = streetNode !== undefined
	const has_postcode = pcNode !== undefined
	const precondition = has_house_number && has_street && has_postcode

	let reassembled_street = ""
	let reassembly_differs = false
	if (streetNode) {
		reassembled_street = assembleStreetValue(streetNode)
		reassembly_differs = reassembled_street !== streetNode.value.trim()
	}

	// Collect unique tags found (for failure samples)
	const tagSet = new Set<string>()
	for (const n of walkTree(roots)) {
		if (n.value.trim()) tagSet.add(n.tag)
	}
	const tags_found = [...tagSet]

	return {
		input,
		state,
		has_house_number,
		has_street,
		has_postcode,
		precondition,
		reassembled_street,
		reassembly_differs,
		tags_found,
	}
}

// ---------------------------------------------------------------------------
// Per-state aggregation
// ---------------------------------------------------------------------------

interface StateStats {
	state: string
	n: number
	precondition: number
	has_street: number
	has_hn: number
	has_postcode: number
	/** Rows where reassembly_differs (affix was present). */
	reassembly_differs: number
	/** Failure samples: precondition === false. */
	failures: Array<{ input: string; tags: string[] }>
}

const MAX_FAILURE_SAMPLES = 5

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.error(`[parser-coverage-audit] model      : ${modelPath}`)
console.error(`[parser-coverage-audit] tokenizer  : ${tokenizerPath}`)
console.error(`[parser-coverage-audit] model-card : ${modelCardPath}`)
console.error(`[parser-coverage-audit] eval       : ${evalPath}`)
console.error(`[parser-coverage-audit] cap/state  : ${perStateCap}`)

const modelCard = JSON.parse(readFileSync(modelCardPath, "utf8"))

const [tokenizer, runner] = await Promise.all([
	MailwomanTokenizer.loadFromFile(tokenizerPath),
	OnnxRunner.create(modelPath),
])

const postcodeAnchorLookup = anchorPath ? parseAnchorLookup(JSON.parse(readFileSync(anchorPath, "utf8"))) : undefined
if (anchorPath) console.error(`[parser-coverage-audit] anchor-lookup  : ${anchorPath}`)

const gazetteerLexicon = gazetteerPath
	? parseGazetteerLexicon(JSON.parse(readFileSync(gazetteerPath, "utf8")))
	: undefined
if (gazetteerPath) console.error(`[parser-coverage-audit] gazetteer     : ${gazetteerPath}`)

const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: modelCard.labels,
	postcodeAnchorLookup,
	gazetteerLexicon,
})

// Load JSONL
const rows: OaRow[] = readFileSync(evalPath, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l))

// Per-state cap: keep first N rows per state
const rowsByState = new Map<string, OaRow[]>()
for (const row of rows) {
	if (!row.state) continue
	const bucket = rowsByState.get(row.state) ?? []
	if (bucket.length < perStateCap) bucket.push(row)
	rowsByState.set(row.state, bucket)
}

const stateKeys = [...rowsByState.keys()].sort()
console.error(`[parser-coverage-audit] states found: ${stateKeys.join(", ")}`)
const totalRows = stateKeys.reduce((acc, s) => acc + rowsByState.get(s)!.length, 0)
console.error(`[parser-coverage-audit] total rows  : ${totalRows}`)

// Per-state buckets
const stateStats = new Map<string, StateStats>()
for (const s of stateKeys) {
	stateStats.set(s, {
		state: s,
		n: 0,
		precondition: 0,
		has_street: 0,
		has_hn: 0,
		has_postcode: 0,
		reassembly_differs: 0,
		failures: [],
	})
}

// Run
let processed = 0
for (const state of stateKeys) {
	const bucket = rowsByState.get(state)!
	const stats = stateStats.get(state)!

	for (const row of bucket) {
		const tree = await neural.parse(row.input)
		const result = analyzeRow(row.input, state, tree)

		stats.n++
		if (result.has_house_number) stats.has_hn++
		if (result.has_street) stats.has_street++
		if (result.has_postcode) stats.has_postcode++
		if (result.precondition) stats.precondition++
		if (result.reassembly_differs) stats.reassembly_differs++

		if (!result.precondition && stats.failures.length < MAX_FAILURE_SAMPLES) {
			stats.failures.push({ input: row.input, tags: result.tags_found })
		}

		processed++
		if (processed % 50 === 0) {
			process.stderr.write(`\r[parser-coverage-audit] ${processed}/${totalRows} rows parsed...`)
		}
	}
}
process.stderr.write(`\r[parser-coverage-audit] ${processed}/${totalRows} rows parsed.\n`)

// ---------------------------------------------------------------------------
// Output: Markdown table + failure samples
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`)

console.log()
console.log("## Parser Coverage Audit — Per-State Results")
console.log()
console.log(`Model: \`${modelPath.split("/").slice(-1)[0]}\``)
console.log(`Tokenizer: \`${tokenizerPath.split("/").slice(-2).join("/")}\``)
console.log(`Eval: \`${evalPath}\`  Cap/state: ${perStateCap}`)
console.log()
console.log("| state | n | precondition% | has_street% | has_hn% | has_postcode% | reassembled≠bare% |")
console.log("| ----- | -: | ------------: | ----------: | ------: | ------------: | ----------------: |")

for (const state of stateKeys) {
	const s = stateStats.get(state)!
	const n = s.n
	console.log(
		`| ${state} | ${n} | ${pct(s.precondition, n)} | ${pct(s.has_street, n)} | ${pct(s.has_hn, n)} | ${pct(s.has_postcode, n)} | ${pct(s.reassembly_differs, n)} |`
	)
}

// Global aggregate
const total = { n: 0, precondition: 0, has_street: 0, has_hn: 0, has_postcode: 0, reassembly_differs: 0 }
for (const s of stateStats.values()) {
	total.n += s.n
	total.precondition += s.precondition
	total.has_street += s.has_street
	total.has_hn += s.has_hn
	total.has_postcode += s.has_postcode
	total.reassembly_differs += s.reassembly_differs
}
console.log(
	`| **ALL** | **${total.n}** | **${pct(total.precondition, total.n)}** | **${pct(total.has_street, total.n)}** | **${pct(total.has_hn, total.n)}** | **${pct(total.has_postcode, total.n)}** | **${pct(total.reassembly_differs, total.n)}** |`
)

// ---------------------------------------------------------------------------
// Failure samples
// ---------------------------------------------------------------------------

console.log()
console.log("## Precondition Failure Samples (up to 5 per state)")
console.log()

for (const state of stateKeys) {
	const s = stateStats.get(state)!
	if (s.failures.length === 0) {
		console.log(`### ${state} — no failures`)
		continue
	}
	const failPct = (((s.n - s.precondition) / s.n) * 100).toFixed(1)
	console.log(`### ${state} — ${s.n - s.precondition} failures (${failPct}%)`)
	console.log()
	for (const f of s.failures) {
		const missingParts: string[] = []
		if (!f.tags.includes("house_number")) missingParts.push("house_number")
		if (!f.tags.includes("street")) missingParts.push("street")
		if (!f.tags.includes("postcode")) missingParts.push("postcode")
		console.log(`- \`${f.input}\``)
		console.log(`  - got tags: \`${f.tags.join(", ") || "(none)"}\``)
		console.log(`  - missing: \`${missingParts.join(", ")}\``)
	}
	console.log()
}
