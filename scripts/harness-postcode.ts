/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode-only regression harness, per-country.
 *
 *   Built to answer DeepSeek's turn-12 question: "Are we actually bad at postcodes per country?"
 *   Postcode patterns (CEDEX = FR, A1A 1A1 = CA, SW1A 1AA = GB, 12345-6789 = US) are
 *   regex-detectable shapes; the model SHOULD crush this. The v0.6.x evals show postcode recall in
 *   the 70-80% range — well below what pattern-matching would imply. This script settles whether
 *   tokenizer fragmentation / data imbalance is the binding constraint, and creates the regression
 *   fence for v0.7+ releases.
 *
 *   Sources:
 *
 *   1. `mailwoman/test/*.test.ts` — extracted via TS AST. Locale derived from filename (e.g.
 *        `address.gbr.test.ts` → GB).
 *   2. `data/eval/falsehoods/*.jsonl` — explicit `locale` field per row.
 *   3. `data/eval/golden/v0.1.2/*.jsonl` — explicit `country` field per row.
 *
 *   Filtering: keep only entries whose expected shape includes a `postcode` value.
 *
 *   Matching: case-insensitive, trimmed exact match. If the row has multiple expected solutions (test
 *   assertions can list alternatives), pass if ANY solution's postcode matches the model's output.
 *
 *   Gate: with `--gate`, exit nonzero if any country with >`--min-count` (default 10) entries has
 *   postcode accuracy below `--floor` (default 0.9).
 *
 *   Usage: node --experimental-strip-types scripts/harness-postcode.ts\
 *   --model /mnt/playpen/mailwoman-data/models/quantized/model-v060-step-100000-int8.onnx\
 *   --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --tests mailwoman/test\
 *   --falsehoods data/eval/falsehoods\
 *   --golden data/eval/golden/v0.1.2\
 *   [--admin-fst /mnt/playpen/mailwoman-data/wof/fst-global-priority.bin]\
 *   [--out-json /tmp/postcode-harness.json]\
 *   [--gate] [--floor 0.9] [--min-count 10]
 */

import { type ComponentTag, decodeAsJson } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { OnnxRunner } from "@mailwoman/neural/onnx-runner"
import { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { deserializeFst } from "@mailwoman/resolver-wof-sqlite/fst-serialize"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import ts from "typescript"

// -------------------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------------------

interface Args {
	modelPath: string
	tokenizerPath: string
	modelCardPath: string
	testsDir?: string
	falsehoodsDir?: string
	goldenDir?: string
	adminFstPath?: string
	outJson?: string
	gate: boolean
	floor: number
	minCount: number
}

function parseArgs(): Args {
	const args = process.argv.slice(2)
	const out: Partial<Args> = { gate: false, floor: 0.9, minCount: 10 }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--model" && args[i + 1]) out.modelPath = args[++i]
		else if (a === "--tokenizer" && args[i + 1]) out.tokenizerPath = args[++i]
		else if (a === "--model-card" && args[i + 1]) out.modelCardPath = args[++i]
		else if (a === "--tests" && args[i + 1]) out.testsDir = args[++i]
		else if (a === "--falsehoods" && args[i + 1]) out.falsehoodsDir = args[++i]
		else if (a === "--golden" && args[i + 1]) out.goldenDir = args[++i]
		else if (a === "--admin-fst" && args[i + 1]) out.adminFstPath = args[++i]
		else if (a === "--out-json" && args[i + 1]) out.outJson = args[++i]
		else if (a === "--gate") out.gate = true
		else if (a === "--floor" && args[i + 1]) out.floor = Number(args[++i])
		else if (a === "--min-count" && args[i + 1]) out.minCount = Number(args[++i])
	}
	if (!out.modelPath || !out.tokenizerPath || !out.modelCardPath) {
		console.error(
			"Usage: harness-postcode.ts --model <onnx> --tokenizer <spm> --model-card <json> [--tests <dir>] [--falsehoods <dir>] [--golden <dir>] [--admin-fst <bin>] [--out-json <path>] [--gate] [--floor 0.9] [--min-count 10]"
		)
		process.exit(1)
	}
	return out as Args
}

// -------------------------------------------------------------------------------------------------
// Locale code → ISO 3166 alpha-2 country code
// -------------------------------------------------------------------------------------------------

/**
 * Test files use ISO 3166 alpha-3 codes in filenames (`address.gbr.test.ts`); falsehoods use
 * BCP-47-ish `en-GB` codes; golden v0.1.2 uses bare alpha-2. We normalize everything to alpha-2 for
 * grouping. `nzd` in test filenames is a non-standard alias for NZ (New Zealand dollar code
 * mistakenly used as country code). Mapping covers all locales present in the tree as of
 * 2026-05-29.
 */
const ALPHA3_TO_ALPHA2: Record<string, string> = {
	aus: "AU",
	bra: "BR",
	cze: "CZ",
	deu: "DE",
	esp: "ES",
	fra: "FR",
	gbr: "GB",
	hrv: "HR",
	ind: "IN",
	nld: "NL",
	nor: "NO",
	nzd: "NZ", // non-standard but consistent in this repo
	pol: "PL",
	prt: "PT",
	rom: "RO",
	svk: "SK",
	swe: "SE",
	usa: "US",
}

function localeToCountry(locale: string): string {
	// Filename-derived: "usa", "gbr", etc.
	if (ALPHA3_TO_ALPHA2[locale]) return ALPHA3_TO_ALPHA2[locale]!
	// BCP-47-ish: "en-GB", "en-CA", "fr-FR"
	const m = /^[a-z]{2,3}-([A-Z]{2})$/.exec(locale)
	if (m) return m[1]!
	// Already alpha-2: "US", "FR"
	if (/^[A-Z]{2}$/.test(locale)) return locale
	// Falsehoods use lowercase locale-bare (e.g. "postcodes", "streets" from the basename
	// when no locale field is present) — these collapse into UNKNOWN.
	return "UNKNOWN"
}

// -------------------------------------------------------------------------------------------------
// Assertion extraction — TS AST → list of (input, expected-postcodes)
// -------------------------------------------------------------------------------------------------

interface Sample {
	source: string // file or jsonl name
	country: string // alpha-2 country code (or UNKNOWN)
	input: string
	expectedPostcodes: string[] // any of these is a pass
}

function localeFromFilename(file: string): string {
	const base = basename(file, ".test.ts").replace(/^address\.|^addressit\.|^place\./, "")
	return base
}

interface ParsedExpected {
	postcode?: string
}

function objectLiteralToExpected(node: ts.ObjectLiteralExpression): ParsedExpected | null {
	for (const prop of node.properties) {
		if (!ts.isPropertyAssignment(prop)) return null
		const name = prop.name
		let key: string
		if (ts.isIdentifier(name)) key = name.text
		else if (ts.isStringLiteralLike(name)) key = name.text
		else return null
		if (key !== "postcode") continue
		const value = prop.initializer
		if (!ts.isArrayLiteralExpression(value)) return null
		const elements: string[] = []
		for (const el of value.elements) {
			if (ts.isStringLiteralLike(el)) elements.push(el.text)
			else return null
		}
		// Tests assert exactly one postcode per solution. Take the first.
		return { postcode: elements[0] }
	}
	return {}
}

function extractFromTestFile(file: string): Sample[] {
	const source = readFileSync(file, "utf8")
	const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	const locale = localeFromFilename(file)
	const country = localeToCountry(locale)
	const out: Sample[] = []

	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "assert" &&
			node.arguments.length >= 1
		) {
			const inputArg = node.arguments[0]
			if (inputArg && ts.isStringLiteralLike(inputArg)) {
				const expectedPostcodes: string[] = []
				for (let i = 1; i < node.arguments.length; i++) {
					const arg = node.arguments[i]!
					if (!ts.isObjectLiteralExpression(arg)) continue
					const parsed = objectLiteralToExpected(arg)
					if (parsed?.postcode) expectedPostcodes.push(parsed.postcode)
				}
				if (expectedPostcodes.length > 0) {
					out.push({ source: basename(file), country, input: inputArg.text, expectedPostcodes })
				}
			}
		}
		ts.forEachChild(node, visit)
	}
	visit(sf)
	return out
}

function discoverFromTests(testsDir: string): Sample[] {
	const all: Sample[] = []
	for (const entry of readdirSync(testsDir)) {
		if (!entry.endsWith(".test.ts")) continue
		try {
			all.push(...extractFromTestFile(join(testsDir, entry)))
		} catch (err) {
			console.error(`[postcode-harness] WARN: ${entry}: ${(err as Error).message}`)
		}
	}
	return all
}

// -------------------------------------------------------------------------------------------------
// Falsehoods + Golden loaders
// -------------------------------------------------------------------------------------------------

interface FalsehoodRow {
	input: string
	locale?: string
	expected: { postcode?: string[] }
}

function loadFalsehoods(dir: string): Sample[] {
	const out: Sample[] = []
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".jsonl")) continue
		const text = readFileSync(join(dir, entry), "utf8")
		for (const line of text.split("\n")) {
			if (!line.trim()) continue
			let row: FalsehoodRow
			try {
				row = JSON.parse(line)
			} catch {
				continue
			}
			const postcodes = row.expected?.postcode
			if (!postcodes || postcodes.length === 0) continue
			const country = row.locale ? localeToCountry(row.locale) : "UNKNOWN"
			out.push({
				source: `falsehoods/${entry}`,
				country,
				input: row.input,
				expectedPostcodes: postcodes,
			})
		}
	}
	return out
}

interface GoldenRow {
	raw: string
	components: { postcode?: string }
	country?: string
}

function loadGolden(dir: string): Sample[] {
	const out: Sample[] = []
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".jsonl")) continue
		const text = readFileSync(join(dir, entry), "utf8")
		for (const line of text.split("\n")) {
			if (!line.trim()) continue
			let row: GoldenRow
			try {
				row = JSON.parse(line)
			} catch {
				continue
			}
			const postcode = row.components?.postcode
			if (!postcode) continue
			const country = row.country ?? "UNKNOWN"
			out.push({
				source: `golden/${entry}`,
				country,
				input: row.raw,
				expectedPostcodes: [postcode],
			})
		}
	}
	return out
}

// -------------------------------------------------------------------------------------------------
// Matching + report
// -------------------------------------------------------------------------------------------------

function normalize(s: string): string {
	return s.toLowerCase().trim()
}

interface SampleResult {
	source: string
	country: string
	input: string
	expectedPostcodes: string[]
	actualPostcode: string | null
	pass: boolean
}

function evaluate(sample: Sample, flat: Partial<Record<ComponentTag, string>>): SampleResult {
	const actual = flat.postcode ?? null
	let pass = false
	if (actual) {
		const actualNorm = normalize(actual)
		for (const exp of sample.expectedPostcodes) {
			if (normalize(exp) === actualNorm) {
				pass = true
				break
			}
		}
	}
	return { ...sample, actualPostcode: actual, pass }
}

interface CountryStats {
	total: number
	pass: number
}

function printReport(results: SampleResult[]): {
	byCountry: Map<string, CountryStats>
	overall: CountryStats
} {
	const byCountry = new Map<string, CountryStats>()
	for (const r of results) {
		const s = byCountry.get(r.country) ?? { total: 0, pass: 0 }
		s.total++
		if (r.pass) s.pass++
		byCountry.set(r.country, s)
	}
	const overall = { total: results.length, pass: results.filter((r) => r.pass).length }

	console.log("# Postcode-Only Harness Report")
	console.log("")
	console.log(`**Total entries:** ${overall.total}`)
	console.log(
		`**Overall postcode exact-match:** ${overall.pass}/${overall.total} (${((100 * overall.pass) / overall.total).toFixed(1)}%)`
	)
	console.log("")
	console.log("## Per-country")
	console.log("")
	console.log("| Country | Total | Match | Rate | Below 90% floor |")
	console.log("|---------|-------|-------|------|----------------|")
	const rows = [...byCountry.entries()].sort((a, b) => b[1].total - a[1].total)
	for (const [country, s] of rows) {
		const rate = s.pass / s.total
		const flag = s.total >= 10 && rate < 0.9 ? "❌" : ""
		console.log(`| ${country} | ${s.total} | ${s.pass} | ${(100 * rate).toFixed(1)}% | ${flag} |`)
	}
	console.log("")

	const failures = results.filter((r) => !r.pass).slice(0, 30)
	if (failures.length > 0) {
		console.log("## Sample of first 30 failures")
		console.log("")
		for (const f of failures) {
			console.log(`- ${f.country} [${f.source}] \`${f.input}\``)
			console.log(
				`  - expected: ${JSON.stringify(f.expectedPostcodes)}, actual: \`${f.actualPostcode ?? "(missing)"}\``
			)
		}
		console.log("")
	}

	return { byCountry, overall }
}

// -------------------------------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs()
	console.error("--- harness-postcode.ts ---")
	console.error("Model:           ", args.modelPath)
	console.error("Tokenizer:       ", args.tokenizerPath)
	console.error(
		"Gate:            ",
		args.gate ? `enabled (floor=${args.floor}, min-count=${args.minCount})` : "disabled"
	)

	console.error("Loading samples...")
	const fromTests = args.testsDir ? discoverFromTests(args.testsDir) : []
	const fromFalsehoods = args.falsehoodsDir ? loadFalsehoods(args.falsehoodsDir) : []
	const fromGolden = args.goldenDir ? loadGolden(args.goldenDir) : []
	const all = [...fromTests, ...fromFalsehoods, ...fromGolden]
	console.error(
		`  ${fromTests.length} from tests, ${fromFalsehoods.length} from falsehoods, ${fromGolden.length} from golden, ${all.length} total`
	)

	console.error("Loading neural classifier...")
	const modelCard = JSON.parse(readFileSync(args.modelCardPath, "utf8"))
	const labels: readonly string[] = modelCard.labels
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(args.tokenizerPath),
		OnnxRunner.create(args.modelPath),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels })

	let adminFst: ReturnType<typeof deserializeFst> | undefined
	if (args.adminFstPath) {
		console.error("Loading admin FST:", args.adminFstPath)
		adminFst = deserializeFst(readFileSync(args.adminFstPath))
	}
	const parseOpts = adminFst
		? ({ fst: adminFst as never } as Parameters<NeuralAddressClassifier["parse"]>[1])
		: undefined

	console.error("Running harness...")
	const t0 = performance.now()
	const results: SampleResult[] = []
	let i = 0
	for (const sample of all) {
		i++
		try {
			const tree = await neural.parse(sample.input, parseOpts)
			const flat = decodeAsJson(tree)
			results.push(evaluate(sample, flat))
		} catch (err) {
			console.error(`[postcode-harness] WARN: ${i} (${sample.input}): ${(err as Error).message}`)
		}
		if (i % 200 === 0) {
			console.error(`  ${i}/${all.length} (${((performance.now() - t0) / 1000).toFixed(1)}s)`)
		}
	}
	console.error(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

	const { byCountry } = printReport(results)

	if (args.outJson) {
		const summary = {
			model: args.modelPath,
			tokenizer: args.tokenizerPath,
			overall: {
				total: results.length,
				pass: results.filter((r) => r.pass).length,
			},
			byCountry: Object.fromEntries(byCountry),
			results,
		}
		writeFileSync(args.outJson, JSON.stringify(summary, null, 2))
		console.error(`Wrote summary to ${args.outJson}`)
	}

	if (args.gate) {
		const violations: string[] = []
		for (const [country, s] of byCountry) {
			if (s.total < args.minCount) continue
			const rate = s.pass / s.total
			if (rate < args.floor) {
				violations.push(
					`${country}: ${(100 * rate).toFixed(1)}% (${s.pass}/${s.total}) below floor ${(100 * args.floor).toFixed(0)}%`
				)
			}
		}
		if (violations.length > 0) {
			console.error("")
			console.error("GATE FAILED:")
			for (const v of violations) console.error(`  - ${v}`)
			process.exit(1)
		}
		console.error("Gate passed.")
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
