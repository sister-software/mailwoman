/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Eval the v0.6.x neural classifier against the golden set with the optional Layer 1
 *   street-morphology FST enabled. Produces a per-tag error-analysis report in the same shape as
 *   `scripts/eval-error-analysis.ts` so the rows can be diffed against the existing v0.6.0 / v0.6.1
 *   baselines in `docs/articles/evals/`.
 *
 *   Usage: node --experimental-strip-types scripts/eval-morphology-fst.ts\
 *   --model /mnt/playpen/.../model-v061-step-100000-int8.onnx\
 *   --tokenizer /mnt/playpen/.../v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --admin-fst /mnt/playpen/.../fst-en-us.bin\
 *   --golden data/eval/golden/v0.1.2\
 *   [--no-morphology] # disable the morphology FST (baseline run) [--morphology-bin <path>] # use an
 *   already-serialized morphology FST
 *
 *   If neither --morphology-bin nor --no-morphology is given, the script builds the FST in-process
 *   from `core/data/libpostal/dictionaries/`.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, basename as pathBasename, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs as parseNodeArgs } from "node:util"

import { type ComponentTag, decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { buildStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street-morphology-fst-builder"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..")

interface GoldenEntry {
	raw: string
	components: Record<string, string>
	country?: string
	source?: string
}

interface Args {
	modelPath: string
	tokenizerPath: string
	modelCardPath: string
	adminFSTPath?: string
	morphologyBinPath?: string
	morphologyEnabled: boolean
	goldenDir: string
	maxAffixBias?: number
	maxNeighbourStreetBias?: number
	dependentLocalityPenalty?: number
	/**
	 * Optional JSON output path. When set, emits structured per-tag stats consumable by `eval-gate.ts`.
	 */
	outJson?: string
	/**
	 * Optional human-readable name written into the JSON output's `name` field. Defaults to the model basename.
	 */
	evalName?: string
	/**
	 * When set, fold the neural model's Stage 3 component tags back to Stage 2 conventions before comparing against the
	 * golden set. The v0.1.2 golden set uses Stage 2's single "street" spans (e.g. golden street = "Main St", not
	 * separate street + street_suffix). Without the fold, a Stage 3 model that correctly decomposes "Main St" →
	 * street="Main"
	 *
	 * - Street_suffix="St" is counted as a `street` boundary error PLUS a `street_suffix` hallucination — a double penalty
	 *   for legitimate decomposition. The fold combines street_prefix + street_prefix_particle + street + street_suffix
	 *   into a single `street` value (space-joined in document order, matching the original raw text).
	 */
	stage3Fold?: boolean
}

function parseArgs(): Args {
	let modelPath: string | undefined
	let tokenizerPath: string | undefined
	let modelCardPath: string | undefined
	let adminFSTPath: string | undefined
	let morphologyBinPath: string | undefined
	let morphologyEnabled = true
	let goldenDir: string | undefined
	let maxAffixBias: number | undefined
	let maxNeighbourStreetBias: number | undefined
	let dependentLocalityPenalty: number | undefined
	let outJson: string | undefined
	let evalName: string | undefined
	let stage3Fold = false

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated)
	const { values } = parseNodeArgs({
		args: process.argv.slice(2),
		options: {
			"admin-fst": { type: "string" },
			"dep-locality-penalty": { type: "string" },
			golden: { type: "string" },
			"max-affix-bias": { type: "string" },
			"max-neighbour-street-bias": { type: "string" },
			model: { type: "string" },
			"model-card": { type: "string" },
			"morphology-bin": { type: "string" },
			name: { type: "string" },
			"no-morphology": { type: "boolean" },
			"out-json": { type: "string" },
			"stage3-fold": { type: "boolean" },
			tokenizer: { type: "string" },
		},
		strict: false,
		allowPositionals: true,
	})

	if (values["model"] != null) modelPath = values["model"] as string
	if (values["tokenizer"] != null) tokenizerPath = values["tokenizer"] as string
	if (values["model-card"] != null) modelCardPath = values["model-card"] as string
	if (values["admin-fst"] != null) adminFSTPath = values["admin-fst"] as string
	if (values["morphology-bin"] != null) morphologyBinPath = values["morphology-bin"] as string
	if (values["no-morphology"] != null) morphologyEnabled = false
	if (values["golden"] != null) goldenDir = values["golden"] as string
	if (values["max-affix-bias"] != null) maxAffixBias = Number(values["max-affix-bias"] as string)
	if (values["max-neighbour-street-bias"] != null)
		maxNeighbourStreetBias = Number(values["max-neighbour-street-bias"] as string)
	if (values["dep-locality-penalty"] != null)
		dependentLocalityPenalty = Number(values["dep-locality-penalty"] as string)
	if (values["out-json"] != null) outJson = values["out-json"] as string
	if (values["name"] != null) evalName = values["name"] as string
	if (values["stage3-fold"] != null) stage3Fold = true

	if (!modelPath || !tokenizerPath || !modelCardPath || !goldenDir) {
		console.error(
			"Usage: node scripts/eval-morphology-fst.ts --model <onnx> --tokenizer <spm> --model-card <json> --golden <dir> [--admin-fst <bin>] [--morphology-bin <bin>] [--no-morphology]"
		)
		process.exit(1)
	}

	return {
		modelPath,
		tokenizerPath,
		modelCardPath,
		adminFSTPath,
		morphologyBinPath,
		morphologyEnabled,
		goldenDir,
		maxAffixBias,
		maxNeighbourStreetBias,
		dependentLocalityPenalty,
		outJson,
		evalName,
		stage3Fold,
	}
}

/**
 * Fold the neural classifier's Stage 3 component tags down to Stage 2 conventions for comparison against the v0.1.2
 * golden set. See {@linkcode Args.stage3Fold} for the full rationale.
 *
 * - `street_prefix` + `street_prefix_particle` + `street` + `street_suffix` → single `street` value (space-joined in
 *   declared order; the underlying tree spans are character-adjacent so the joined string approximates the original raw
 *   substring).
 * - `intersection_a` + `intersection_b` → folded to `street` (golden encodes intersections as a single street span per
 *   the v0 rule-based parser's convention).
 *
 * Returns a flat record consumable by the existing comparison loop.
 */
function foldStage3ToStage2(flat: Partial<Record<ComponentTag, string>>): Partial<Record<ComponentTag, string>> {
	const out: Partial<Record<ComponentTag, string>> = { ...flat }
	const streetParts: string[] = []

	for (const tag of ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const) {
		const v = out[tag]

		if (v) {
			streetParts.push(v)
		}
	}

	if (streetParts.length > 0) {
		out.street = streetParts.join(" ")
		delete out.street_prefix
		delete out.street_prefix_particle
		delete out.street_suffix
	}

	if (out.intersection_a || out.intersection_b) {
		const xs: string[] = []

		if (out.intersection_a) {
			xs.push(out.intersection_a)
		}

		if (out.intersection_b) {
			xs.push(out.intersection_b)
		}

		// Combine into street if there's no existing street; otherwise leave intersection_a/b alone
		// since the golden uses a single street value per address.
		if (!out.street && xs.length > 0) {
			out.street = xs.join(" & ")
		}
		delete out.intersection_a
		delete out.intersection_b
	}

	return out
}

function loadGolden(dir: string): GoldenEntry[] {
	const entries: GoldenEntry[] = []

	for (const file of ["us.jsonl", "fr.jsonl", "adversarial.jsonl"]) {
		const path = resolve(dir, file)

		try {
			const text = readFileSync(path, "utf8")

			for (const line of text.split("\n")) {
				if (!line.trim()) continue
				entries.push(JSON.parse(line))
			}
		} catch {
			// file may not exist
		}
	}

	return entries
}

async function main() {
	const args = parseArgs()

	console.error("--- eval-morphology-fst.ts ---")
	console.error("Model:        ", args.modelPath)
	console.error("Tokenizer:    ", args.tokenizerPath)
	console.error("Model card:   ", args.modelCardPath)
	console.error("Admin FST:    ", args.adminFSTPath ?? "(none)")
	console.error("Morphology:   ", args.morphologyEnabled ? "enabled" : "disabled")
	console.error("Morphology src:", args.morphologyBinPath ?? "(build in-process)")
	console.error("Golden:       ", args.goldenDir)

	const golden = loadGolden(args.goldenDir)
	console.error(`Loaded ${golden.length} golden entries`)

	// Load model + tokenizer + labels explicitly — bypasses resolveWeights so we can point at any
	// arbitrary v0.6.x checkpoint without touching package symlinks.
	console.error("Loading classifier...")
	const modelCard = JSON.parse(readFileSync(args.modelCardPath, "utf8"))
	const labels: readonly string[] = modelCard.labels
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(args.tokenizerPath),
		ONNXRunner.create(args.modelPath),
	])
	const classifier = new NeuralAddressClassifier({ tokenizer, runner, labels })

	// Admin FST (if provided).
	let adminFST: ReturnType<typeof deserializeFST> | undefined

	if (args.adminFSTPath) {
		console.error("Loading admin FST...")
		adminFST = deserializeFST(readFileSync(args.adminFSTPath))
	}

	// Morphology FST.
	let morphologyFST: ReturnType<typeof deserializeFST> | undefined

	if (args.morphologyEnabled) {
		if (args.morphologyBinPath) {
			console.error("Loading morphology FST from", args.morphologyBinPath)
			morphologyFST = deserializeFST(readFileSync(args.morphologyBinPath))
		} else {
			console.error("Building morphology FST in-process from libpostal dictionaries...")
			const built = buildStreetMorphologyFST({
				dictionariesDir: resolve(REPO_ROOT, "core", "data", "libpostal", "dictionaries"),
			})
			morphologyFST = built.matcher
			console.error(`  ${built.canonicalCount} canonicals / ${built.variantCount} variants`)
		}
	}

	// Per-tag stats — same shape as the existing eval-error-analysis.ts so output is comparable.
	type TagStats = {
		expected: number
		correct: number
		missed: number
		boundary: number
		confused: number
		hallucinated: number
	}
	const perTag = new Map<string, TagStats>()
	function tagStat(tag: string): TagStats {
		let s = perTag.get(tag)

		if (!s) {
			s = { expected: 0, correct: 0, missed: 0, boundary: 0, confused: 0, hallucinated: 0 }
			perTag.set(tag, s)
		}

		return s
	}

	let exactMatch = 0
	let total = 0
	let missedTotal = 0
	let boundaryTotal = 0
	let confusedTotal = 0
	let hallucinatedTotal = 0

	console.error("Running eval...")
	const t0 = performance.now()
	const morphologyOpts: Record<string, number> = {}

	if (args.maxAffixBias !== undefined) {
		morphologyOpts.maxAffixBias = args.maxAffixBias
	}

	if (args.maxNeighbourStreetBias !== undefined) {
		morphologyOpts.maxNeighbourStreetBias = args.maxNeighbourStreetBias
	}

	if (args.dependentLocalityPenalty !== undefined) {
		morphologyOpts.dependentLocalityPenalty = args.dependentLocalityPenalty
	}

	const parseOpts = {
		...(adminFST
			? {
					fst: adminFST as unknown as Parameters<typeof classifier.parse>[1] extends infer T
						? T extends { fst?: infer F }
							? F
							: never
						: never,
				}
			: {}),
		...(morphologyFST
			? {
					fstStreetMorphology: morphologyFST as unknown as Parameters<typeof classifier.parse>[1] extends infer T
						? T extends { fstStreetMorphology?: infer F }
							? F
							: never
						: never,
					...(Object.keys(morphologyOpts).length > 0 ? { fstStreetMorphologyOpts: morphologyOpts } : {}),
				}
			: {}),
	}

	for (const entry of golden) {
		total++
		const tree = await classifier.parse(entry.raw, parseOpts as Parameters<typeof classifier.parse>[1])
		const rawPredicted = decodeAsJSON(tree)
		const predicted = args.stage3Fold ? foldStage3ToStage2(rawPredicted) : rawPredicted
		const expected = entry.components

		let allCorrect = true

		for (const [tag, value] of Object.entries(expected)) {
			const predValue = predicted[tag as keyof typeof predicted]
			tagStat(tag).expected++

			if (!predValue) {
				missedTotal++
				tagStat(tag).missed++
				allCorrect = false
			} else if (predValue !== value) {
				const predNorm = String(predValue).toLowerCase().trim()
				const expNorm = value.toLowerCase().trim()

				if (predNorm.includes(expNorm) || expNorm.includes(predNorm)) {
					boundaryTotal++
					tagStat(tag).boundary++
				} else {
					confusedTotal++
					tagStat(tag).confused++
				}
				allCorrect = false
			} else {
				tagStat(tag).correct++
			}
		}

		for (const tag of Object.keys(predicted)) {
			if (!(tag in expected)) {
				hallucinatedTotal++
				tagStat(tag).hallucinated++
				allCorrect = false
			}
		}

		if (allCorrect) {
			exactMatch++
		}

		if (total % 500 === 0) {
			const elapsed = (performance.now() - t0) / 1000
			console.error(`  ${total}/${golden.length} (${elapsed.toFixed(1)}s)`)
		}
	}

	const elapsed = ((performance.now() - t0) / 1000).toFixed(1)

	// Markdown report — same shape as eval-error-analysis.ts so existing tooling diffs cleanly.
	console.log("# Error Analysis Report (morphology-FST eval)")
	console.log("")
	console.log(`**Model:** \`${args.modelPath}\``)
	console.log(`**Tokenizer:** \`${args.tokenizerPath}\``)
	console.log(`**Admin FST:** ${args.adminFSTPath ?? "(none)"}`)
	console.log(`**Morphology FST:** ${args.morphologyEnabled ? "enabled" : "disabled"}`)
	console.log(`**Golden set:** ${total} entries`)
	console.log(`**Time:** ${elapsed}s`)
	console.log("")
	console.log("## Summary")
	console.log("")
	console.log(`| Metric | Count | Rate |`)
	console.log(`|--------|-------|------|`)
	console.log(`| Exact match | ${exactMatch} | ${((100 * exactMatch) / total).toFixed(1)}% |`)
	console.log(`| Missed entities | ${missedTotal} | — |`)
	console.log(`| Boundary errors | ${boundaryTotal} | — |`)
	console.log(`| Confused tags | ${confusedTotal} | — |`)
	console.log(`| Hallucinated tags | ${hallucinatedTotal} | — |`)
	console.log("")
	console.log("## Per-tag breakdown")
	console.log("")
	console.log("| Tag | Expected | Correct | Missed | Boundary | Confused | Hallucinated | Recall |")
	console.log("|-----|----------|---------|--------|----------|----------|--------------|--------|")
	const sortedTags = [...perTag.entries()].sort((a, b) => b[1].expected - a[1].expected)

	for (const [tag, s] of sortedTags) {
		const recall = s.expected > 0 ? ((100 * s.correct) / s.expected).toFixed(1) + "%" : "—"
		console.log(
			`| ${tag} | ${s.expected} | ${s.correct} | ${s.missed} | ${s.boundary} | ${s.confused} | ${s.hallucinated} | ${recall} |`
		)
	}

	if (args.outJson) {
		// Normalized eval-result JSON. The shape is the contract `scripts/eval-gate.ts` reads.
		// Keep field names stable; gates from older releases must be diffable against newer ones.
		const out = {
			name: args.evalName ?? pathBasename(args.modelPath).replace(/\.onnx$/, ""),
			golden_set: total,
			exact_match_pct: (100 * exactMatch) / total,
			model: args.modelPath,
			admin_fst: args.adminFSTPath ?? null,
			morphology_enabled: args.morphologyEnabled,
			per_tag: Object.fromEntries(
				sortedTags.map(([tag, s]) => [
					tag,
					{
						expected: s.expected,
						correct: s.correct,
						missed: s.missed,
						boundary: s.boundary,
						confused: s.confused,
						hallucinated: s.hallucinated,
						recall_pct: s.expected > 0 ? (100 * s.correct) / s.expected : 0,
						hallucination_rate_pct: s.expected > 0 ? (100 * s.hallucinated) / s.expected : 0,
					},
				])
			),
		}
		writeFileSync(args.outJson, JSON.stringify(out, null, 2))
		console.error(`Wrote eval JSON to ${args.outJson}`)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
