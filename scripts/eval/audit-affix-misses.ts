/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Affix miss-form audit (#492 endgame): the width run falsified the capacity hypothesis (48M lands
 *   at exactly 29M's 64.9-prefix equilibrium at matched density, P=100/R≈48 on both), which points
 *   the ladder's last finger at the DATA. This script classifies every real-affix-eval miss by
 *   surface-form features and compares them against what the shard builder actually varies
 *   (abbr/full per affix, Title-case, four layouts) — the #487 audit method, applied to affix.
 *
 *   Usage: node --experimental-strip-types scripts/eval/audit-affix-misses.ts\
 *   --model <int8.onnx> [--file data/eval/external/street-affix-real.jsonl]\
 *   [--gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json]
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { NeuralAddressClassifier, parseAnchorLookup, parseGazetteerLexicon } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"

const TOK = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const LK = dataRootPath("anchor", "pilot-anchor-lookup.json")

const { values: args } = parseArgs({
	options: {
		model: { type: "string" },
		file: { type: "string", default: "data/eval/external/street-affix-real.jsonl" },
		"gazetteer-lexicon": { type: "string", default: "data/gazetteer/anchor-lexicon-v1.json" },
	},
})

if (!args.model) throw new Error("--model required")

const rows = readFileSync(args.file!, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l) as { raw: string; components: Record<string, string> })

// Mirror score-affix's SHIP-CONFIG construction exactly — loadFromWeights ignores a modelPath
// and grades the default symlink with no anchor channel (the zero-fill crash signature this
// audit's first run produced — caught by the misses-vs-scorer discrepancy).
const card = JSON.parse(readFileSync("neural-weights-en-us/model-card.json", "utf8"))
const [tokenizer, runner] = await Promise.all([MailwomanTokenizer.loadFromFile(TOK), ONNXRunner.create(args.model!)])
const neural = new NeuralAddressClassifier({
	tokenizer,
	runner,
	labels: card.labels,
	postcodeAnchorLookup: parseAnchorLookup(JSON.parse(readFileSync(LK, "utf8"))),
	gazetteerLexicon: parseGazetteerLexicon(JSON.parse(readFileSync(args["gazetteer-lexicon"]!, "utf8"))),
	suppressGazetteerNearPostcode: true,
})

const COMMON_SUFFIXES = new Set([
	"st",
	"street",
	"ave",
	"avenue",
	"dr",
	"drive",
	"rd",
	"road",
	"blvd",
	"boulevard",
	"ln",
	"lane",
])

/** Classify the surface-form features of one eval row. */
function formFeatures(row: { raw: string; components: Record<string, string> }): string[] {
	const f: string[] = []
	const { street_prefix: prefix, street_suffix: suffix } = row.components

	if (prefix) {
		f.push(prefix.length <= 2 ? "prefix-abbr" : "prefix-full")
	}

	if (suffix) {
		f.push(suffix.length <= 4 && !suffix.endsWith(".") ? "suffix-abbr" : "suffix-full")

		if (!COMMON_SUFFIXES.has(suffix.toLowerCase().replace(/\.$/, ""))) {
			f.push("suffix-RARE")
		}
	}

	if (/\b[A-Z]{3,}\b/.test(row.raw.replace(/\b(USA|APO|FPO)\b/g, ""))) {
		f.push("CAPS")
	}

	if (/\w\./.test(row.raw)) {
		f.push("punct-period")
	}

	if (!row.raw.includes(",")) {
		f.push("no-comma")
	}

	if ((row.components.street ?? "").includes(" ")) {
		f.push("street-multiword")
	}

	if (prefix && suffix) {
		f.push("both-affixes")
	}

	if (!/\d{5}/.test(row.raw)) {
		f.push("no-postcode")
	}

	return f
}

const featureCounts = (rowsSubset: typeof rows) => {
	const counts = new Map<string, number>()

	for (const r of rowsSubset) {
		for (const f of formFeatures(r)) {
			counts.set(f, (counts.get(f) ?? 0) + 1)
		}
	}

	return counts
}

const norm = (s?: string) => (s ?? "").trim().toLowerCase()
const misses: Array<{ row: (typeof rows)[number]; tag: string; expected: string; got: string; street?: string }> = []

for (const row of rows) {
	const got = decodeAsJSON(await neural.parse(row.raw)) as Record<string, string>

	for (const tag of ["street_prefix", "street_suffix"]) {
		const e = norm(row.components[tag])

		if (!e) continue

		if (norm(got[tag]) !== e) {
			misses.push({ row, tag, expected: e, got: norm(got[tag]) || "(nothing)", street: norm(got.street) })
		}
	}
}

console.log(`rows: ${rows.length} · affix-gold instances missed: ${misses.length}`)
console.log("\n== per-miss detail ==")

for (const m of misses) {
	console.log(
		`✗ [${m.tag}] expected "${m.expected}" got "${m.got}" · model street="${m.street}" · forms: ${formFeatures(m.row).join(",")}`
	)
	console.log(`    ${m.row.raw}`)
}
console.log("\n== form-feature rates: misses vs whole eval ==")
const all = featureCounts(rows)
const missed = featureCounts([...new Set(misses.map((m) => m.row))])
const features = [...new Set([...all.keys(), ...missed.keys()])].sort()

for (const f of features) {
	const a = all.get(f) ?? 0
	const m = missed.get(f) ?? 0
	console.log(
		`${f.padEnd(18)} misses ${String(m).padStart(2)} / eval ${String(a).padStart(2)}  (${a ? Math.round((100 * m) / a) : 0}% of carriers missed)`
	)
}
console.log(
	"\nShard variation surface (build-street-affix-shard.mjs): abbr/full per affix (50/50), Title-case ONLY, 4 layouts (full/bare/street-only/venue), comma-tailed. NOT varied: ALL-CAPS, periods ('S.'/'Dr.'), rare suffixes beyond the parse source's natural mix."
)
