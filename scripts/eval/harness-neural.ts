/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Neural test harness — the arena scorer behind `external-arenas.ts` and the pre-ship gate
 *   battery. Reads the 30+ `mailwoman/test/address.*.test.ts` files (and sibling
 *   intersection/venue/compound_street tests), extracts every `assert(input, ...expected)` call via
 *   TS AST, and grades each input's neural parse (`NeuralAddressClassifier`) against the expected
 *   records. `--falsehoods <dir>` adds JSONL row files (the external arena fixtures).
 *
 *   LINEAGE: ported neural-only from `harness-v0-neural.ts` at the `legacy-rules-final` seal tag.
 *   The v7 excision (#1151) deleted the rule-based parser, which was that harness's second arm; the
 *   three-bucket v0-vs-neural comparison it existed for closed with the capability map. The NEURAL
 *   arm here is semantically unchanged — same tag fold, same loose any-expected matcher — so neural
 *   pass rates remain comparable with historical arena reports. The `--assembled` arm (#478, grade
 *   `runPipeline` alongside raw neural) also survives; only the v0 arm and its buckets are gone.
 *
 *   Output: a markdown report on stdout + a JSON sidecar (`--out-json`) per-assertion containing
 *   `{ file, locale, input, expected, neural_pass, neural_actual, ... }` so downstream scripts
 *   (`summarize-arenas.ts`) can cluster failures by tag/locale/address-shape.
 *
 *   Usage: node scripts/eval/harness-neural.ts\
 *   --tests mailwoman/test\
 *   --out-json /tmp/harness.json\
 *   [--model <onnx>] [--tokenizer <spm>] [--model-card <json>]\
 *   [--admin-fst <bin>] [--morphology-fst <bin> | --no-morphology]\
 *   [--falsehoods data/eval/falsehoods] # extra JSONL row files to include
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parseArgs as parseNodeArgs } from "node:util"

import { type ComponentTag, decodeAsJSON, type TreeViolation, validateTree } from "@mailwoman/core/decoder"
import { runIfScript } from "@mailwoman/core/scripting"
import type { ClassificationRecord } from "@mailwoman/core/types"
import { repoRootPath } from "@mailwoman/core/utils"
import {
	type AnchorLookup,
	type GazetteerLexicon,
	NeuralAddressClassifier,
	parseAnchorLookup,
	parseGazetteerLexicon,
} from "@mailwoman/neural"
import { ONNXRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { buildStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street-morphology-fst-builder"
import { createRuntimePipeline } from "mailwoman"
import ts from "typescript"

// -------------------------------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------------------------------

interface Args {
	testsDir: string
	outJson?: string
	modelPath?: string
	tokenizerPath?: string
	modelCardPath?: string
	gazetteerLexiconPath?: string
	anchorLookupPath?: string
	conventions?: string
	bridgeGaps?: boolean
	adminFSTPath?: string
	morphologyEnabled: boolean
	morphologyBinPath?: string
	falsehoodsDir?: string
	postcodeRepair: boolean
	unitRepair: boolean
	/**
	 * #478: also grade the ASSEMBLED runtime pipeline (`createRuntimePipeline` — normalize → kind/ fast-path → grouper →
	 * reconcile → classify), not just the raw neural classifier. This is the #566-lesson gate: a pipeline regression
	 * (e.g. a reconcile/arbitration change) is invisible when the eval grades raw neural. Off by default → the existing
	 * raw-neural report is byte-stable.
	 */
	assembled: boolean
}

function parseArgs(): Args {
	const out: Partial<Args> = {
		morphologyEnabled: true,
		postcodeRepair: false,
		unitRepair: false,
		assembled: false,
	}

	// node:util parseArgs (strict:false = old scan parity: unknown flags tolerated — including the
	// retired `--symmetric-match` (only ever governed the deleted v0 arm's scoring) and the retired
	// `--arbitrate` (#478 inc 3; the `arbitrate` PipelineOpt no longer exists)).
	const { values } = parseNodeArgs({
		options: {
			"admin-fst": { type: "string" },
			"anchor-lookup": { type: "string" },
			assembled: { type: "boolean" },
			"bridge-gaps": { type: "boolean" },
			conventions: { type: "string" },
			falsehoods: { type: "string" },
			"gazetteer-lexicon": { type: "string" },
			model: { type: "string" },
			"model-card": { type: "string" },
			"morphology-fst": { type: "string" },
			"no-morphology": { type: "boolean" },
			"out-json": { type: "string" },
			"postcode-repair": { type: "boolean" },
			tests: { type: "string" },
			tokenizer: { type: "string" },
			"unit-repair": { type: "boolean" },
		},
		strict: false,
		allowPositionals: true,
	})

	if (values["tests"] != null) {
		out.testsDir = values["tests"] as string
	}

	if (values["out-json"] != null) {
		out.outJson = values["out-json"] as string
	}

	if (values["model"] != null) {
		out.modelPath = values["model"] as string
	}

	if (values["tokenizer"] != null) {
		out.tokenizerPath = values["tokenizer"] as string
	}

	if (values["model-card"] != null) {
		out.modelCardPath = values["model-card"] as string
	}

	if (values["gazetteer-lexicon"] != null) {
		out.gazetteerLexiconPath = values["gazetteer-lexicon"] as string
	}

	if (values["anchor-lookup"] != null) {
		out.anchorLookupPath = values["anchor-lookup"] as string
	}

	if (values["conventions"] != null) {
		out.conventions = values["conventions"] as string
	}

	if (values["bridge-gaps"] != null) {
		out.bridgeGaps = true
	}

	if (values["admin-fst"] != null) {
		out.adminFSTPath = values["admin-fst"] as string
	}

	if (values["morphology-fst"] != null) {
		out.morphologyBinPath = values["morphology-fst"] as string
	}

	if (values["no-morphology"] != null) {
		out.morphologyEnabled = false
	}

	if (values["falsehoods"] != null) {
		out.falsehoodsDir = values["falsehoods"] as string
	}

	if (values["postcode-repair"] != null) {
		out.postcodeRepair = true
	}

	if (values["unit-repair"] != null) {
		out.unitRepair = true
	}

	if (values["assembled"] != null) {
		out.assembled = true
	}

	if (!out.testsDir) {
		console.error("Usage: scripts/eval/harness-neural.ts --tests <dir> [--out-json <path>] [...]")
		process.exit(1)
	}

	return out as Args
}

// -------------------------------------------------------------------------------------------------
// Assertion extraction — TS AST → list of (input, expected[])
// -------------------------------------------------------------------------------------------------

interface ExtractedAssertion {
	file: string
	locale: string // derived from filename (e.g., "usa" from "address.usa.test.ts")
	input: string
	expected: ClassificationRecord[]
}

function localeFromFilename(file: string): string {
	const base = basename(file, ".test.ts").replace(/^address\.|^addressit\.|^place\./, "")

	return base
}

/**
 * Recursively unwrap a literal object expression like `{ street: ["Main St"] }` into a plain JS object. Returns `null`
 * for anything that isn't a literal-of-literals (we intentionally don't try to evaluate variables or computed
 * properties — none of the test files use those).
 */
function objectLiteralToRecord(node: ts.ObjectLiteralExpression): ClassificationRecord | null {
	const out: Record<string, string[]> = {}

	for (const prop of node.properties) {
		if (!ts.isPropertyAssignment(prop)) return null
		const name = prop.name
		let key: string

		if (ts.isIdentifier(name)) {
			key = name.text
		} else if (ts.isStringLiteralLike(name)) {
			key = name.text
		} else return null
		const value = prop.initializer

		if (!ts.isArrayLiteralExpression(value)) return null
		const elements: string[] = []

		for (const el of value.elements) {
			if (ts.isStringLiteralLike(el)) {
				elements.push(el.text)
			} else return null
		}
		out[key] = elements
	}

	return out as ClassificationRecord
}

function extractAssertions(file: string): ExtractedAssertion[] {
	const source = readFileSync(file, "utf8")
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	const locale = localeFromFilename(file)
	const out: ExtractedAssertion[] = []

	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "assert" &&
			node.arguments.length >= 1
		) {
			const inputArg = node.arguments[0]

			if (!inputArg || !ts.isStringLiteralLike(inputArg)) {
				ts.forEachChild(node, visit)

				return
			}
			const expected: ClassificationRecord[] = []
			let allOk = true

			for (let i = 1; i < node.arguments.length; i++) {
				const arg = node.arguments[i]!

				if (!ts.isObjectLiteralExpression(arg)) {
					allOk = false
					break
				}
				const rec = objectLiteralToRecord(arg)

				if (!rec) {
					allOk = false
					break
				}
				expected.push(rec)
			}

			if (allOk) {
				out.push({ file: basename(file), locale, input: inputArg.text, expected })
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)

	return out
}

function discoverAssertions(testsDir: string): ExtractedAssertion[] {
	const all: ExtractedAssertion[] = []

	for (const entry of readdirSync(testsDir)) {
		// Only the address.*.test.ts / addressit.*.test.ts / venue.*.test.ts / intersection.test.ts
		// / compound_street.test.ts / place.*.test.ts / transit.test.ts / libpostal.test.ts /
		// functional.test.ts use the `assert(input, ...expected)` shape. CLI integration tests
		// (resolve-flag, benchmark-flag, runtime-pipeline, etc.) use vitest's `test()` directly.
		// We extract from all .test.ts files and skip the ones with zero matching calls — the
		// extractor is a no-op on those.
		if (!entry.endsWith(".test.ts")) continue
		const filePath = join(testsDir, entry)

		try {
			const assertions = extractAssertions(filePath)
			all.push(...assertions)
		} catch (err) {
			console.error(`[harness] WARN: failed to extract from ${entry}: ${(err as Error).message}`)
		}
	}

	return all
}

// -------------------------------------------------------------------------------------------------
// Neural output → the visible ClassificationRecord vocabulary
// -------------------------------------------------------------------------------------------------

/**
 * Visible classification labels in the assertion vocabulary — the fixture format inherited from the retired rule-based
 * suite: `country, dependency, house_number, level_designator, level, locality, postcode, region, street,
 * unit_designator, unit, venue`. Anything outside this set is invisible to the comparison and gets folded or dropped.
 */
const VISIBLE_TAGS = new Set([
	"country",
	"dependency",
	"house_number",
	"level_designator",
	"level",
	"locality",
	"postcode",
	"region",
	"street",
	"unit_designator",
	"unit",
	"venue",
])

/**
 * Fold the neural classifier's Stage 3 component tags into the visible classification set. The fold is principled but
 * lossy:
 *
 * - `street_prefix` + `street_prefix_particle` + `street` + `street_suffix` → `street` (concat in document order,
 *   preserving inter-token spacing implicitly via concatenation).
 * - `intersection_a` + `intersection_b` → `street` (two separate values, matching the fixtures' `{street: ["Main St",
 *   "Second Ave"]}` shape for intersections).
 * - `house_number`, `unit`, `venue`, `country`, `region`, `locality`, `postcode` → identity.
 * - `dependent_locality`, `subregion`, `attention`, `po_box`, `cedex`, JP-specific tags → dropped (no fixture
 *   equivalent). The dropped tags are surfaced in the per-assertion report so the harness consumer can see what was
 *   lost.
 */
function neuralTreeToVisibleRecord(flat: Partial<Record<ComponentTag, string>>): {
	record: ClassificationRecord
	dropped: Partial<Record<ComponentTag, string>>
} {
	const out: Record<string, string[]> = {}
	const dropped: Partial<Record<ComponentTag, string>> = {}

	const streetParts: string[] = []

	for (const tag of ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const) {
		const v = flat[tag]

		if (v) {
			streetParts.push(v)
		}
	}

	if (streetParts.length > 0) {
		out.street = [streetParts.join(" ")]
	}

	if (flat.intersection_a || flat.intersection_b) {
		const xs: string[] = []

		if (flat.intersection_a) {
			xs.push(flat.intersection_a)
		}

		if (flat.intersection_b) {
			xs.push(flat.intersection_b)
		}
		out.street = [...(out.street ?? []), ...xs]
	}

	for (const [tag, value] of Object.entries(flat) as Array<[ComponentTag, string]>) {
		if (
			tag === "street_prefix" ||
			tag === "street_prefix_particle" ||
			tag === "street" ||
			tag === "street_suffix" ||
			tag === "intersection_a" ||
			tag === "intersection_b"
		) {
			continue // already folded above
		}

		if (VISIBLE_TAGS.has(tag)) {
			out[tag] = [value]
		} else {
			dropped[tag] = value
		}
	}

	return { record: out as ClassificationRecord, dropped }
}

// -------------------------------------------------------------------------------------------------
// Comparison — case-insensitive superset match
// -------------------------------------------------------------------------------------------------

function normalize(s: string): string {
	return s.toLowerCase().trim()
}

/**
 * Pass if every tag in `expected` is present in `actual` AND the actual value (string-equality, case-folded, trimmed)
 * contains the expected value. We accept `actual` being a superset because the neural parser may emit extra components
 * the test doesn't pin down (e.g. it labels a country when the test only asserted street).
 */
function expectedMatchesActual(expected: ClassificationRecord, actual: ClassificationRecord): boolean {
	for (const [tag, expectedValues] of Object.entries(expected)) {
		const actualValues = actual[tag as keyof ClassificationRecord]

		if (!actualValues || !expectedValues) return false

		// For multi-value tags (intersection: ["Main St", "Second Ave"]) we require ALL of the
		// expected values to appear in actual, order-sensitive.
		if (expectedValues.length !== actualValues.length) return false

		for (let i = 0; i < expectedValues.length; i++) {
			if (normalize(expectedValues[i]!) !== normalize(actualValues[i]!)) {
				// Allow substring containment in either direction — the neural parser sometimes
				// over- or under-spans (e.g. "5th Avenue" vs "Avenue"). The fixture suite is the
				// authority on the EXPECTED span; we count a substring match as a partial pass.
				const exp = normalize(expectedValues[i]!)
				const act = normalize(actualValues[i]!)

				if (!exp.includes(act) && !act.includes(exp)) return false
			}
		}
	}

	return true
}

function anyExpectedMatches(expected: ClassificationRecord[], actual: ClassificationRecord): boolean {
	for (const e of expected) {
		if (expectedMatchesActual(e, actual)) return true
	}

	return false
}

// -------------------------------------------------------------------------------------------------
// Per-assertion runner
// -------------------------------------------------------------------------------------------------

interface AssertionResult {
	file: string
	locale: string
	input: string
	expected: ClassificationRecord[]
	neural_pass: boolean
	neural_actual: ClassificationRecord
	neural_dropped: Partial<Record<ComponentTag, string>>
	neural_tree_valid: boolean
	neural_tree_violations: TreeViolation[]
	/**
	 * #478 assembled-pipeline arm (only when `--assembled`): the full `runPipeline` parse, graded like neural.
	 */
	assembled_pass?: boolean
	assembled_actual?: ClassificationRecord
}

async function runAssertion(
	a: ExtractedAssertion,
	neuralClassifier: NeuralAddressClassifier,
	parseOpts: Parameters<NeuralAddressClassifier["parse"]>[1],
	pipeline?: ReturnType<typeof createRuntimePipeline>
): Promise<AssertionResult> {
	// neural — one tree, loose semantics: pass if ANY of the expected solutions is matched by
	// the top-1 neural output. This is the natural reading for a single-result parser; the
	// fixtures' multi-solution structure came from the retired multi-hypothesis rules API.
	const tree = await neuralClassifier.parse(a.input, parseOpts)
	const flat = decodeAsJSON(tree)
	const { record: neuralRecord, dropped } = neuralTreeToVisibleRecord(flat)
	const neuralPass = anyExpectedMatches(a.expected, neuralRecord)
	const treeValidity = validateTree(tree) // #37 — structural coherence of the neural parse

	// #478 assembled-pipeline arm: grade the full `runPipeline` parse (what production runs) — same
	// loose top-1 semantics + tree→visible-record conversion as neural. Off unless `--assembled`
	// wired the pipeline. This is the #566-lesson measurement: an assembled-pipeline regression is
	// invisible against raw-neural F1.
	let assembledPass: boolean | undefined
	let assembledRecord: ClassificationRecord | undefined

	if (pipeline) {
		const { tree: assembledTree } = await pipeline(a.input)
		assembledRecord = neuralTreeToVisibleRecord(decodeAsJSON(assembledTree)).record
		assembledPass = anyExpectedMatches(a.expected, assembledRecord)
	}

	return {
		file: a.file,
		locale: a.locale,
		input: a.input,
		expected: a.expected,
		neural_pass: neuralPass,
		neural_actual: neuralRecord,
		neural_dropped: dropped,
		neural_tree_valid: treeValidity.valid,
		neural_tree_violations: treeValidity.violations,
		assembled_pass: assembledPass,
		assembled_actual: assembledRecord,
	}
}

// -------------------------------------------------------------------------------------------------
// Falsehoods JSONL loader
// -------------------------------------------------------------------------------------------------

interface FalsehoodRow {
	input: string
	locale?: string
	expected: ClassificationRecord
	falsehood?: string
	expected_failure?: boolean
}

function loadFalsehoods(dir: string): ExtractedAssertion[] {
	const out: ExtractedAssertion[] = []

	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".jsonl")) continue
		const file = basename(entry, ".jsonl")
		const text = readFileSync(join(dir, entry), "utf8")

		for (const line of text.split("\n")) {
			if (!line.trim()) continue
			let row: FalsehoodRow

			try {
				row = JSON.parse(line)
			} catch (err) {
				console.error(`[harness] WARN: bad JSON in ${entry}: ${(err as Error).message}`)
				continue
			}
			out.push({
				file: `falsehoods/${entry}`,
				locale: row.locale ?? file,
				input: row.input,
				expected: [row.expected],
			})
		}
	}

	return out
}

// -------------------------------------------------------------------------------------------------
// Report
// -------------------------------------------------------------------------------------------------

interface FileStats {
	total: number
	neural_pass: number
}

function printReport(results: AssertionResult[]): void {
	const total = results.length
	const neuralPass = results.filter((r) => r.neural_pass).length
	const treeValid = results.filter((r) => r.neural_tree_valid).length
	const passAndValid = results.filter((r) => r.neural_pass && r.neural_tree_valid).length

	const byFile = new Map<string, FileStats>()

	for (const r of results) {
		const s = byFile.get(r.file) ?? { total: 0, neural_pass: 0 }
		s.total++

		if (r.neural_pass) {
			s.neural_pass++
		}
		byFile.set(r.file, s)
	}

	const byLocale = new Map<string, FileStats>()

	for (const r of results) {
		const s = byLocale.get(r.locale) ?? { total: 0, neural_pass: 0 }
		s.total++

		if (r.neural_pass) {
			s.neural_pass++
		}
		byLocale.set(r.locale, s)
	}

	console.log("# Neural Harness Report")
	console.log("")
	console.log(`**Assertions:** ${total}`)
	console.log("")
	console.log("## Overall")
	console.log("")
	console.log(`| Metric | Pass | Rate |`)
	console.log(`|--------|------|------|`)
	console.log(`| Neural | ${neuralPass} | ${((100 * neuralPass) / total).toFixed(1)}% |`)
	console.log(`| Neural tree structurally valid (#37) | ${treeValid} | ${((100 * treeValid) / total).toFixed(1)}% |`)
	console.log(
		`| Neural pass AND structurally valid | ${passAndValid} | ${((100 * passAndValid) / total).toFixed(1)}% |`
	)
	console.log("")

	// #478 assembled-pipeline arm (only when --assembled): what the ASSEMBLED pipeline (grouper +
	// reconcile + fast-path) gains or loses against raw neural on the same assertions.
	const hasAssembled = results.some((r) => r.assembled_pass !== undefined)

	if (hasAssembled) {
		const asmPass = results.filter((r) => r.assembled_pass).length
		const asmGainedVsNeural = results.filter((r) => r.assembled_pass && !r.neural_pass).length
		const asmLostVsNeural = results.filter((r) => !r.assembled_pass && r.neural_pass).length
		console.log("## Assembled pipeline (#478 — `runPipeline`, the gate)")
		console.log("")
		console.log(`| Metric | Count | Rate |`)
		console.log(`|--------|-------|------|`)
		console.log(`| Assembled pass | ${asmPass} | ${((100 * asmPass) / total).toFixed(1)}% |`)
		console.log(`| Assembled vs raw-neural (gained / lost) | +${asmGainedVsNeural} / -${asmLostVsNeural} | |`)
		console.log("")
	}

	console.log("## Per-file")
	console.log("")
	console.log("| File | Total | Neural | Neural % |")
	console.log("|------|-------|--------|----------|")
	const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].total - a[1].total)

	for (const [file, s] of sortedFiles) {
		console.log(`| ${file} | ${s.total} | ${s.neural_pass} | ${((100 * s.neural_pass) / s.total).toFixed(0)}% |`)
	}
	console.log("")

	console.log("## Per-locale")
	console.log("")
	console.log("| Locale | Total | Neural | Neural % |")
	console.log("|--------|-------|--------|----------|")
	const sortedLocales = [...byLocale.entries()].sort((a, b) => b[1].total - a[1].total)

	for (const [locale, s] of sortedLocales) {
		console.log(`| ${locale} | ${s.total} | ${s.neural_pass} | ${((100 * s.neural_pass) / s.total).toFixed(0)}% |`)
	}
	console.log("")

	// First 20 failures — the regression cluster the harness exists to surface.
	const failures = results.filter((r) => !r.neural_pass).slice(0, 20)

	if (failures.length > 0) {
		console.log(`## Failures (sample of first ${failures.length})`)
		console.log("")

		for (const r of failures) {
			console.log(`- \`${r.input}\` (${r.locale})`)
			console.log(`  - expected: \`${JSON.stringify(r.expected[0])}\``)
			console.log(`  - neural: \`${JSON.stringify(r.neural_actual)}\``)
		}
		console.log("")
	}
}

// -------------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs()
	console.error("--- harness-neural.ts ---")
	console.error("Tests dir:        ", args.testsDir)
	console.error("Falsehoods dir:   ", args.falsehoodsDir ?? "(none)")
	console.error("Model:            ", args.modelPath ?? "(default — package resolve)")
	console.error("Morphology:       ", args.morphologyEnabled ? "enabled" : "disabled")

	console.error("Extracting assertions...")
	const fromTests = discoverAssertions(args.testsDir)
	const fromFalsehoods = args.falsehoodsDir ? loadFalsehoods(args.falsehoodsDir) : []
	const all = [...fromTests, ...fromFalsehoods]
	console.error(`  ${fromTests.length} from tests, ${fromFalsehoods.length} from falsehoods, ${all.length} total`)

	console.error("Loading neural classifier...")
	let neural: NeuralAddressClassifier

	if (args.modelPath && args.tokenizerPath && args.modelCardPath) {
		const modelCard = JSON.parse(readFileSync(args.modelCardPath, "utf8"))
		const labels: readonly string[] = modelCard.labels
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizerPath),
			ONNXRunner.create(args.modelPath),
		])
		// Gaz-trained models (v4.2.0+) MUST be fed the lexicon + the postcode-anchor lookup with
		// near-postcode suppression — zero-filled clues depress country recall and fake an affix
		// crash (the ship config; see CONTRIBUTING_MODEL_WORK eval invariants).
		let gazetteerLexicon: GazetteerLexicon | undefined

		if (args.gazetteerLexiconPath) {
			gazetteerLexicon = parseGazetteerLexicon(JSON.parse(readFileSync(args.gazetteerLexiconPath, "utf8")))
		}
		let postcodeAnchorLookup: AnchorLookup | undefined

		if (args.anchorLookupPath) {
			postcodeAnchorLookup = parseAnchorLookup(JSON.parse(readFileSync(args.anchorLookupPath, "utf8")))
		}
		neural = new NeuralAddressClassifier({
			tokenizer,
			runner,
			labels,
			...(gazetteerLexicon ? { gazetteerLexicon, suppressGazetteerNearPostcode: true } : {}),
			...(postcodeAnchorLookup ? { postcodeAnchorLookup } : {}),
			// #511 Tier A: --conventions auto|<system> enables the address-system conventions mask.
			...(args.conventions ? { addressSystemConventions: args.conventions as "auto" } : {}),
			...(args.bridgeGaps ? { bridgePunctuationGaps: true } : {}),
		})
	} else {
		neural = await NeuralAddressClassifier.loadFromWeights()
	}

	let adminFST: ReturnType<typeof deserializeFST> | undefined

	if (args.adminFSTPath) {
		console.error("Loading admin FST...")
		adminFST = deserializeFST(readFileSync(args.adminFSTPath))
	}

	let morphologyFST: ReturnType<typeof deserializeFST> | undefined

	if (args.morphologyEnabled) {
		if (args.morphologyBinPath) {
			console.error("Loading morphology FST from", args.morphologyBinPath)
			morphologyFST = deserializeFST(readFileSync(args.morphologyBinPath))
		} else {
			console.error("Building morphology FST in-process...")
			const built = buildStreetMorphologyFST({
				dictionariesDir: repoRootPath("core", "data", "libpostal", "dictionaries"),
			})
			morphologyFST = built.matcher
			console.error(`  ${built.canonicalCount} canonicals / ${built.variantCount} variants`)
		}
	}

	const parseOpts = {
		...(adminFST ? { fst: adminFST as never } : {}),
		...(morphologyFST ? { fstStreetMorphology: morphologyFST as never } : {}),
		postcodeRepair: args.postcodeRepair,
		unitRepair: args.unitRepair,
	} as Parameters<NeuralAddressClassifier["parse"]>[1]

	// #478: the assembled runtime pipeline (reuses the neural classifier + admin FST). No resolver —
	// the arena grades COMPONENT parses (Stage 3 / grouper / reconcile), not coordinates.
	const pipeline = args.assembled
		? createRuntimePipeline({ classifier: neural, ...(adminFST ? { fst: adminFST as never } : {}) })
		: undefined

	if (pipeline) {
		console.error("Assembled-pipeline arm ON (--assembled): grading runPipeline alongside raw neural.")
	}

	console.error("Running harness...")
	const t0 = performance.now()
	const results: AssertionResult[] = []
	let i = 0

	for (const a of all) {
		i++

		try {
			results.push(await runAssertion(a, neural, parseOpts, pipeline))
		} catch (err) {
			console.error(`[harness] WARN: error on assertion ${i} (${a.input}): ${(err as Error).message}`)
		}

		if (i % 50 === 0) {
			const elapsed = (performance.now() - t0) / 1000
			console.error(`  ${i}/${all.length} (${elapsed.toFixed(1)}s)`)
		}
	}
	console.error(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

	printReport(results)

	if (args.outJson) {
		writeFileSync(args.outJson, JSON.stringify(results, null, 2))
		console.error(`Wrote ${results.length} results to ${args.outJson}`)
	}
}

runIfScript(import.meta, main)
