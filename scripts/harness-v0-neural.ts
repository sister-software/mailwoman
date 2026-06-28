/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   V0-vs-neural test harness. Reads the 30+ `mailwoman/test/address.*.test.ts` files (and sibling
 *   intersection/venue/compound_street tests), extracts every `assert(input, ...expected)` call via
 *   TS AST, and runs each input through BOTH the legacy rule-based parser (`createAddressParser`)
 *   and the neural parser (`NeuralAddressClassifier`).
 *
 *   Reports per-file / per-locale / per-tag pass rates, side-by-side. This is the "honest assessment"
 *   mentioned in the [Layer 1 eval
 *   doc](../docs/articles/evals/2026-05-28-layer-1-morphology-fst.md) — the neural classifier has
 *   never been measured against the rule-based pipeline's hand-tuned acceptance criteria, and that
 *   gap is exactly what drives v0.6.2's recipe.
 *
 *   Output: a markdown report on stdout + a JSON sidecar (`--out-json`) per-assertion containing `{
 *   file, locale, input, expected, v0_pass, neural_pass, v0_actual, neural_actual }` so downstream
 *   scripts can cluster failures by tag/locale/address-shape.
 *
 *   Usage: node --experimental-strip-types scripts/harness-v0-neural.ts\
 *   --tests mailwoman/test\
 *   --out-json /tmp/harness.json\
 *   [--model <onnx>] [--tokenizer <spm>] [--model-card <json>]\
 *   [--admin-fst <bin>] [--morphology-fst <bin> | --no-morphology]\
 *   [--falsehoods data/eval/falsehoods] # extra JSONL row files to include
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { type ComponentTag, decodeAsJson, type TreeViolation, validateTree } from "@mailwoman/core/decoder"
import {
	type AnchorLookup,
	type GazetteerLexicon,
	NeuralAddressClassifier,
	parseAnchorLookup,
	parseGazetteerLexicon,
} from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { deserializeFst } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { buildStreetMorphologyFst } from "@mailwoman/resolver-wof-sqlite/street-morphology-fst-builder"
import { type ClassificationRecord, createAddressParser, createRuntimePipeline } from "mailwoman"
import ts from "typescript"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..")

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
	adminFstPath?: string
	morphologyEnabled: boolean
	morphologyBinPath?: string
	falsehoodsDir?: string
	postcodeRepair: boolean
	unitRepair: boolean
	symmetricMatch: boolean
	/**
	 * #478: also grade the ASSEMBLED runtime pipeline (`createRuntimePipeline` — normalize → kind/ fast-path → grouper →
	 * reconcile → classify), not just the raw neural classifier. This is the #566-lesson gate: a pipeline regression
	 * (e.g. a reconcile/arbitration change) is invisible when the eval grades raw neural. Off by default → the existing
	 * v0-vs-raw-neural report is byte-stable.
	 */
	assembled: boolean
	/**
	 * #478 inc 3: run the assembled arm with per-component arbitration ON (`runPipeline`'s `arbitrate: true`). Only
	 * meaningful with `--assembled`. Lets the gate compare the arbitrated pipeline's `v0-only vs ASSEMBLED` against the
	 * non-arbitrated assembled baseline.
	 */
	arbitrate: boolean
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = {
		morphologyEnabled: true,
		postcodeRepair: false,
		unitRepair: false,
		symmetricMatch: false,
		assembled: false,
		arbitrate: false,
	}

	for (let i = 0; i < args.length; i++) {
		const a = args[i]

		if (a === "--tests" && args[i + 1]) out.testsDir = args[++i]
		else if (a === "--out-json" && args[i + 1]) out.outJson = args[++i]
		else if (a === "--model" && args[i + 1]) out.modelPath = args[++i]
		else if (a === "--tokenizer" && args[i + 1]) out.tokenizerPath = args[++i]
		else if (a === "--model-card" && args[i + 1]) out.modelCardPath = args[++i]
		else if (a === "--gazetteer-lexicon" && args[i + 1]) out.gazetteerLexiconPath = args[++i]
		else if (a === "--anchor-lookup" && args[i + 1]) out.anchorLookupPath = args[++i]
		else if (a === "--conventions" && args[i + 1]) out.conventions = args[++i]
		else if (a === "--bridge-gaps") out.bridgeGaps = true
		else if (a === "--admin-fst" && args[i + 1]) out.adminFstPath = args[++i]
		else if (a === "--morphology-fst" && args[i + 1]) out.morphologyBinPath = args[++i]
		else if (a === "--no-morphology") out.morphologyEnabled = false
		else if (a === "--falsehoods" && args[i + 1]) out.falsehoodsDir = args[++i]
		else if (a === "--postcode-repair") out.postcodeRepair = true
		else if (a === "--unit-repair") out.unitRepair = true
		else if (a === "--symmetric-match") out.symmetricMatch = true
		else if (a === "--assembled") out.assembled = true
		else if (a === "--arbitrate") out.arbitrate = true
	}

	if (!out.testsDir) {
		console.error("Usage: scripts/harness-v0-neural.ts --tests <dir> [--out-json <path>] [...]")
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

		if (ts.isIdentifier(name)) key = name.text
		else if (ts.isStringLiteralLike(name)) key = name.text
		else return null
		const value = prop.initializer

		if (!ts.isArrayLiteralExpression(value)) return null
		const elements: string[] = []

		for (const el of value.elements) {
			if (ts.isStringLiteralLike(el)) elements.push(el.text)
			else return null
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
// Neural output → v0-comparable ClassificationRecord
// -------------------------------------------------------------------------------------------------

/**
 * Visible classification labels in the v0 rule-based parser's solution model. `country, dependency, house_number,
 * level_designator, level, locality, postcode, region, street, unit_designator, unit, venue`. Anything outside this set
 * is invisible to the v0 comparison and gets folded or dropped.
 */
const V0_VISIBLE = new Set([
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
 * Fold the neural classifier's Stage 3 component tags into the v0 visible classification set. The fold is principled
 * but lossy:
 *
 * - `street_prefix` + `street_prefix_particle` + `street` + `street_suffix` → `street` (concat in document order,
 *   preserving inter-token spacing implicitly via concatenation).
 * - `intersection_a` + `intersection_b` → `street` (two separate values, matching v0's `{street: ["Main St", "Second
 *   Ave"]}` shape for intersections).
 * - `house_number`, `unit`, `venue`, `country`, `region`, `locality`, `postcode` → identity.
 * - `dependent_locality`, `subregion`, `attention`, `po_box`, `cedex`, JP-specific tags → dropped (no v0 equivalent). The
 *   dropped tags are surfaced in the per-assertion report so the harness consumer can see what was lost.
 */
function neuralTreeToV0Record(flat: Partial<Record<ComponentTag, string>>): {
	record: ClassificationRecord
	dropped: Partial<Record<ComponentTag, string>>
} {
	const out: Record<string, string[]> = {}
	const dropped: Partial<Record<ComponentTag, string>> = {}

	const streetParts: string[] = []

	for (const tag of ["street_prefix", "street_prefix_particle", "street", "street_suffix"] as const) {
		const v = flat[tag]

		if (v) streetParts.push(v)
	}

	if (streetParts.length > 0) out.street = [streetParts.join(" ")]

	if (flat.intersection_a || flat.intersection_b) {
		const xs: string[] = []

		if (flat.intersection_a) xs.push(flat.intersection_a)

		if (flat.intersection_b) xs.push(flat.intersection_b)
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

		if (V0_VISIBLE.has(tag)) {
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
				// over- or under-spans (e.g. "5th Avenue" vs "Avenue"). The v0 suite is the
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
	v0_pass: boolean
	v0_actual: ClassificationRecord[]
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

/**
 * Strict deep-equality on `ClassificationRecord`s, mirroring vitest's `toEqual`. v0's assert uses `toEqual` per
 * solution position, so the v0 path of the harness has to match exactly to stay consistent with the existing test
 * semantics.
 */
function classificationsEqual(a: ClassificationRecord, b: ClassificationRecord): boolean {
	const aKeys = Object.keys(a).sort()
	const bKeys = Object.keys(b).sort()

	if (aKeys.length !== bKeys.length) return false

	for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false

	for (const k of aKeys) {
		const av = (a as Record<string, string[]>)[k]!
		const bv = (b as Record<string, string[]>)[k]!

		if (av.length !== bv.length) return false

		for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false
	}

	return true
}

async function runAssertion(
	a: ExtractedAssertion,
	v0Parser: ReturnType<typeof createAddressParser>,
	neuralClassifier: NeuralAddressClassifier,
	parseOpts: Parameters<NeuralAddressClassifier["parse"]>[1],
	symmetricMatch: boolean,
	pipeline?: ReturnType<typeof createRuntimePipeline>,
	arbitrate = false
): Promise<AssertionResult> {
	const solutions = await v0Parser.parse(a.input)
	const v0Records: ClassificationRecord[] = solutions.map((s) => s.classifications as ClassificationRecord)
	let v0Pass: boolean

	if (symmetricMatch) {
		// Fair cross-architecture mode (external-lineage corpora, e.g. libpostal): score v0 with the
		// SAME loose subset matcher as neural — pass if any v0 solution matches an expected record.
		// The default exact-match (classificationsEqual) assumes COMPLETE v0-vocab expected records,
		// which remapped external cases (with dropped/unmappable tags) don't have → unfair to v0.
		v0Pass = v0Records.some((r) => anyExpectedMatches(a.expected, r))
	} else {
		// v0 — vitest semantics: expected[i] deep-equals solutions[i].classifications. All N
		// expected solutions must match position-for-position; pass only if all of them do.
		v0Pass = solutions.length >= a.expected.length

		if (v0Pass) {
			for (let i = 0; i < a.expected.length; i++) {
				if (!classificationsEqual(a.expected[i]!, v0Records[i]!)) {
					v0Pass = false
					break
				}
			}
		}
	}

	// neural — one tree, looser semantics: pass if ANY of the expected solutions is matched by
	// the top-1 neural output. This is the natural reading for a single-result parser; v0's
	// multi-solution structure simply isn't part of the neural API.
	const tree = await neuralClassifier.parse(a.input, parseOpts)
	const flat = decodeAsJson(tree)
	const { record: neuralRecord, dropped } = neuralTreeToV0Record(flat)
	const neuralPass = anyExpectedMatches(a.expected, neuralRecord)
	const treeValidity = validateTree(tree) // #37 — structural coherence of the neural parse

	// #478 assembled-pipeline arm: grade the full `runPipeline` parse (what production runs) — same
	// loose top-1 semantics + tree→v0-record conversion as neural. Off unless `--assembled` wired the
	// pipeline. This is the #566-lesson measurement: an assembled-pipeline regression is invisible
	// against raw-neural F1.
	let assembledPass: boolean | undefined
	let assembledRecord: ClassificationRecord | undefined

	if (pipeline) {
		const { tree: assembledTree } = await pipeline(a.input, arbitrate ? { arbitrate: true } : undefined)
		assembledRecord = neuralTreeToV0Record(decodeAsJson(assembledTree)).record
		assembledPass = anyExpectedMatches(a.expected, assembledRecord)
	}

	return {
		file: a.file,
		locale: a.locale,
		input: a.input,
		expected: a.expected,
		v0_pass: v0Pass,
		v0_actual: v0Records.slice(0, 3), // top 3 v0 solutions for the report
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
	v0_pass: number
	neural_pass: number
}

function printReport(results: AssertionResult[]): void {
	const total = results.length
	const v0Pass = results.filter((r) => r.v0_pass).length
	const neuralPass = results.filter((r) => r.neural_pass).length
	const treeValid = results.filter((r) => r.neural_tree_valid).length
	const passAndValid = results.filter((r) => r.neural_pass && r.neural_tree_valid).length
	const bothPass = results.filter((r) => r.v0_pass && r.neural_pass).length
	const onlyV0 = results.filter((r) => r.v0_pass && !r.neural_pass).length
	const onlyNeural = results.filter((r) => !r.v0_pass && r.neural_pass).length
	const bothFail = results.filter((r) => !r.v0_pass && !r.neural_pass).length

	const byFile = new Map<string, FileStats>()

	for (const r of results) {
		const s = byFile.get(r.file) ?? { total: 0, v0_pass: 0, neural_pass: 0 }
		s.total++

		if (r.v0_pass) s.v0_pass++

		if (r.neural_pass) s.neural_pass++
		byFile.set(r.file, s)
	}

	const byLocale = new Map<string, FileStats>()

	for (const r of results) {
		const s = byLocale.get(r.locale) ?? { total: 0, v0_pass: 0, neural_pass: 0 }
		s.total++

		if (r.v0_pass) s.v0_pass++

		if (r.neural_pass) s.neural_pass++
		byLocale.set(r.locale, s)
	}

	console.log("# v0-vs-Neural Harness Report")
	console.log("")
	console.log(`**Assertions:** ${total}`)
	console.log("")
	console.log("## Overall")
	console.log("")
	console.log(`| Parser | Pass | Rate |`)
	console.log(`|--------|------|------|`)
	console.log(`| v0 (rule-based) | ${v0Pass} | ${((100 * v0Pass) / total).toFixed(1)}% |`)
	console.log(`| Neural | ${neuralPass} | ${((100 * neuralPass) / total).toFixed(1)}% |`)
	console.log(`| Neural tree structurally valid (#37) | ${treeValid} | ${((100 * treeValid) / total).toFixed(1)}% |`)
	console.log(
		`| Neural pass AND structurally valid | ${passAndValid} | ${((100 * passAndValid) / total).toFixed(1)}% |`
	)
	console.log("")
	console.log(`| Category | Count | Rate |`)
	console.log(`|----------|-------|------|`)
	console.log(`| Both pass | ${bothPass} | ${((100 * bothPass) / total).toFixed(1)}% |`)
	console.log(`| v0 only | ${onlyV0} | ${((100 * onlyV0) / total).toFixed(1)}% |`)
	console.log(`| Neural only | ${onlyNeural} | ${((100 * onlyNeural) / total).toFixed(1)}% |`)
	console.log(`| Both fail | ${bothFail} | ${((100 * bothFail) / total).toFixed(1)}% |`)
	console.log("")

	// #478 assembled-pipeline arm (only when --assembled). The HEADLINE is `v0-only vs ASSEMBLED` —
	// the parses v0 gets that the ASSEMBLED pipeline (not just raw neural) drops. Arbitration must
	// drive this to ~0 "by construction"; comparing it to `v0-only vs raw-neural` shows what the
	// current pipeline (grouper + reconcile + fast-path, no arbitration yet) already captures or loses.
	const hasAssembled = results.some((r) => r.assembled_pass !== undefined)

	if (hasAssembled) {
		const asmPass = results.filter((r) => r.assembled_pass).length
		const onlyV0vsAsm = results.filter((r) => r.v0_pass && !r.assembled_pass).length
		const onlyAsm = results.filter((r) => !r.v0_pass && r.assembled_pass).length
		const asmGainedVsNeural = results.filter((r) => r.assembled_pass && !r.neural_pass).length
		const asmLostVsNeural = results.filter((r) => !r.assembled_pass && r.neural_pass).length
		console.log("## Assembled pipeline (#478 — `runPipeline`, the gate)")
		console.log("")
		console.log(`| Metric | Count | Rate |`)
		console.log(`|--------|-------|------|`)
		console.log(`| Assembled pass | ${asmPass} | ${((100 * asmPass) / total).toFixed(1)}% |`)
		console.log(
			`| **v0-only vs ASSEMBLED** (gate target → ~0) | ${onlyV0vsAsm} | ${((100 * onlyV0vsAsm) / total).toFixed(1)}% |`
		)
		console.log(`| v0-only vs raw-neural (for comparison) | ${onlyV0} | ${((100 * onlyV0) / total).toFixed(1)}% |`)
		console.log(`| Assembled-only (vs v0) | ${onlyAsm} | ${((100 * onlyAsm) / total).toFixed(1)}% |`)
		console.log(`| Assembled vs raw-neural (gained / lost) | +${asmGainedVsNeural} / -${asmLostVsNeural} | |`)
		console.log("")
	}

	console.log("## Per-file")
	console.log("")
	console.log("| File | Total | v0 | Neural | v0 % | Neural % |")
	console.log("|------|-------|----|--------|------|----------|")
	const sortedFiles = [...byFile.entries()].sort((a, b) => b[1].total - a[1].total)

	for (const [file, s] of sortedFiles) {
		console.log(
			`| ${file} | ${s.total} | ${s.v0_pass} | ${s.neural_pass} | ${((100 * s.v0_pass) / s.total).toFixed(0)}% | ${((100 * s.neural_pass) / s.total).toFixed(0)}% |`
		)
	}
	console.log("")

	console.log("## Per-locale")
	console.log("")
	console.log("| Locale | Total | v0 | Neural | v0 % | Neural % |")
	console.log("|--------|-------|----|--------|------|----------|")
	const sortedLocales = [...byLocale.entries()].sort((a, b) => b[1].total - a[1].total)

	for (const [locale, s] of sortedLocales) {
		console.log(
			`| ${locale} | ${s.total} | ${s.v0_pass} | ${s.neural_pass} | ${((100 * s.v0_pass) / s.total).toFixed(0)}% | ${((100 * s.neural_pass) / s.total).toFixed(0)}% |`
		)
	}
	console.log("")

	// First 20 v0-only failures (assertions where v0 passes and neural doesn't) — these are the
	// regression cluster the harness exists to surface.
	const v0OnlyFailures = results.filter((r) => r.v0_pass && !r.neural_pass).slice(0, 20)

	if (v0OnlyFailures.length > 0) {
		console.log(`## v0-only passes (sample of first ${v0OnlyFailures.length})`)
		console.log("")
		console.log("Cases where the rule-based parser succeeds and the neural parser fails. These")
		console.log("are the targeted-fix candidates for v0.6.2 corpus augmentation.")
		console.log("")

		for (const r of v0OnlyFailures) {
			console.log(`- \`${r.input}\` (${r.locale})`)
			console.log(`  - expected: \`${JSON.stringify(r.expected[0])}\``)
			console.log(`  - neural: \`${JSON.stringify(r.neural_actual)}\``)
		}
		console.log("")
	}

	// Neural-only passes — where neural succeeds and v0 fails. These are wins to celebrate.
	const neuralOnly = results.filter((r) => !r.v0_pass && r.neural_pass).slice(0, 10)

	if (neuralOnly.length > 0) {
		console.log(`## Neural-only passes (sample of first ${neuralOnly.length})`)
		console.log("")

		for (const r of neuralOnly) {
			console.log(`- \`${r.input}\` (${r.locale})`)
		}
		console.log("")
	}
}

// -------------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs()
	console.error("--- harness-v0-neural.ts ---")
	console.error("Tests dir:        ", args.testsDir)
	console.error("Falsehoods dir:   ", args.falsehoodsDir ?? "(none)")
	console.error("Model:            ", args.modelPath ?? "(default — package resolve)")
	console.error("Morphology:       ", args.morphologyEnabled ? "enabled" : "disabled")

	console.error("Extracting assertions...")
	const fromTests = discoverAssertions(args.testsDir)
	const fromFalsehoods = args.falsehoodsDir ? loadFalsehoods(args.falsehoodsDir) : []
	const all = [...fromTests, ...fromFalsehoods]
	console.error(`  ${fromTests.length} from tests, ${fromFalsehoods.length} from falsehoods, ${all.length} total`)

	console.error("Loading v0 parser...")
	const v0Parser = createAddressParser()

	console.error("Loading neural classifier...")
	let neural: NeuralAddressClassifier

	if (args.modelPath && args.tokenizerPath && args.modelCardPath) {
		const modelCard = JSON.parse(readFileSync(args.modelCardPath, "utf8"))
		const labels: readonly string[] = modelCard.labels
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(args.tokenizerPath),
			OnnxRunner.create(args.modelPath),
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

	let adminFst: ReturnType<typeof deserializeFst> | undefined

	if (args.adminFstPath) {
		console.error("Loading admin FST...")
		adminFst = deserializeFst(readFileSync(args.adminFstPath))
	}

	let morphologyFst: ReturnType<typeof deserializeFst> | undefined

	if (args.morphologyEnabled) {
		if (args.morphologyBinPath) {
			console.error("Loading morphology FST from", args.morphologyBinPath)
			morphologyFst = deserializeFst(readFileSync(args.morphologyBinPath))
		} else {
			console.error("Building morphology FST in-process...")
			const built = buildStreetMorphologyFst({
				dictionariesDir: resolve(REPO_ROOT, "core", "data", "libpostal", "dictionaries"),
			})
			morphologyFst = built.matcher
			console.error(`  ${built.canonicalCount} canonicals / ${built.variantCount} variants`)
		}
	}

	const parseOpts = {
		...(adminFst ? { fst: adminFst as never } : {}),
		...(morphologyFst ? { fstStreetMorphology: morphologyFst as never } : {}),
		postcodeRepair: args.postcodeRepair,
		unitRepair: args.unitRepair,
	} as Parameters<NeuralAddressClassifier["parse"]>[1]

	// #478: the assembled runtime pipeline (reuses the neural classifier + admin FST). No resolver —
	// the arena grades COMPONENT parses (Stage 3 / grouper / reconcile), not coordinates.
	const pipeline = args.assembled
		? createRuntimePipeline({ classifier: neural, ...(adminFst ? { fst: adminFst as never } : {}) })
		: undefined

	if (pipeline)
		console.error(
			`Assembled-pipeline arm ON (--assembled${args.arbitrate ? " --arbitrate" : ""}): grading runPipeline${args.arbitrate ? " with per-component arbitration" : ""} alongside raw neural.`
		)

	console.error("Running harness...")
	const t0 = performance.now()
	const results: AssertionResult[] = []
	let i = 0

	for (const a of all) {
		i++

		try {
			results.push(await runAssertion(a, v0Parser, neural, parseOpts, args.symmetricMatch, pipeline, args.arbitrate))
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

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
