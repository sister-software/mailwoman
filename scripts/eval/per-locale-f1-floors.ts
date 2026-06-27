/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-locale F1 floor gate (#375 S48). Reads the `--out-json` written by
 *   `scripts/eval/per-locale-f1.ts` ({ reports: FileReport[], spread }) and checks each locale's
 *   micro-F1 against a minimum floor. The point is discipline: "beat Pelias" and a healthy
 *   AGGREGATE F1 can hide a single locale rotting, because the US-heavy golden set dominates the
 *   mean (see project-per-locale-f1-baseline). A per-locale floor turns each locale into its own
 *   tripwire — add a locale, or regress an existing one below its floor, and this surfaces it by
 *   name.
 *
 *   NON-BLOCKING by default: it prints a table and exits 0 even on a breach, so it can ride along in
 *   CI as a visible signal without gating merges. Pass --blocking to make a breach exit 1 (for a
 *   dedicated guard job).
 *
 *   Ported faithfully from scripts/eval/per-locale-f1-floors.py (pure JSON + regex, no numpy).
 *
 *   Usage: node --experimental-strip-types scripts/eval/per-locale-f1.ts ... --out-json
 *   /tmp/plf1.json node --experimental-strip-types scripts/eval/per-locale-f1-floors.ts --report
 *   /tmp/plf1.json [--floors floors.json --blocking] node --experimental-strip-types
 *   scripts/eval/per-locale-f1-floors.ts --self-test
 */

import { readFileSync } from "node:fs"

// locale key -> minimum acceptable micro-F1 (regression floor). null = no floor yet (SKIP, not guessed).
const DEFAULT_FLOORS: Record<string, number | null> = {
	us: 0.8, // baseline canonical micro ~0.82 → floor a couple points under
	fr: 0.64, // baseline canonical micro ~0.66
	de: null, // pending #397 (model path) before a parser-F1 floor is honest
	es: null,
	it: null,
	nl: null,
}

// Substrings that map a golden FILE name to a locale key. Tried longest-first so "en-us" wins over "us".
const FILE_ALIASES: Record<string, string> = {
	"en-us": "us",
	"fr-fr": "fr",
	"de-de": "de",
	"es-es": "es",
	"it-it": "it",
	"nl-nl": "nl",
	us: "us",
	fr: "fr",
	de: "de",
	es: "es",
	it: "it",
	nl: "nl",
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function localeOf(fileName: string): string | null {
	// Match against the extension-stripped stem, on alphanumeric word boundaries — otherwise EVERY
	// `.jsonl` file matches "nl" (it lives inside "jso-NL"), which the self-test caught. Longest alias
	// first so "en-us" wins over "us".
	const stem = fileName.toLowerCase().replace(/\.[a-z0-9]+$/, "")
	for (const alias of Object.keys(FILE_ALIASES).sort((a, b) => b.length - a.length)) {
		if (new RegExp(`(?<![a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`).test(stem)) {
			return FILE_ALIASES[alias]!
		}
	}
	return null
}

interface Row {
	file: string
	locale: string | null
	microF1: number
	floor: number | null
	status: string
}

/** One row per report: locale, micro-F1, floor, status (PASS / BELOW / SKIP / UNKNOWN_LOCALE). */
function evaluate(reports: Array<Record<string, unknown>>, floors: Record<string, number | null>): Row[] {
	const rows: Row[] = []
	for (const r of reports) {
		const fileName = (r.file as string) ?? "?"
		const micro = Number(r.microF1 ?? 0.0)
		const loc = localeOf(fileName)
		let status: string
		let floor: number | null
		if (loc === null) {
			status = "UNKNOWN_LOCALE"
			floor = null
		} else {
			floor = loc in floors ? floors[loc]! : null
			if (floor === null) {
				status = "SKIP"
			} else {
				status = micro >= floor ? "PASS" : "BELOW"
			}
		}
		rows.push({ file: fileName, locale: loc, microF1: micro, floor, status })
	}
	return rows
}

/** Python `format(x, ".{d}f")` — round-half-to-even (banker's), unlike JS `toFixed` (half-away). */
function pyFixed(x: number, d: number): string {
	if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
	const neg = x < 0 || Object.is(x, -0)
	const [intPart, fracRaw = ""] = Math.abs(x).toFixed(99).split(".")
	let frac = fracRaw
	if (frac.length <= d) {
		const body = d > 0 ? `${intPart}.${frac.padEnd(d, "0")}` : intPart!
		return (neg ? "-" : "") + body
	}
	const keep = frac.slice(0, d)
	const rest = frac.slice(d)
	let roundUp: boolean
	if (rest[0]! > "5") roundUp = true
	else if (rest[0]! < "5") roundUp = false
	else if (rest.slice(1).replace(/0+$/, "").length > 0) roundUp = true
	else {
		const lastKept = d > 0 ? (keep[d - 1] ?? "0") : (intPart![intPart!.length - 1] ?? "0")
		roundUp = parseInt(lastKept, 10) % 2 === 1
	}
	let digits = intPart! + keep
	if (roundUp) {
		const arr = digits.split("")
		let i = arr.length - 1
		for (; i >= 0; i--) {
			if (arr[i] === "9") arr[i] = "0"
			else {
				arr[i] = String(parseInt(arr[i]!, 10) + 1)
				break
			}
		}
		if (i < 0) arr.unshift("1")
		digits = arr.join("")
	}
	const di = digits.length - d
	const body = d > 0 ? `${digits.slice(0, di) || "0"}.${digits.slice(di)}` : digits.slice(0, di) || "0"
	return (neg ? "-" : "") + body
}

function padL(s: string, w: number): string {
	return s.padEnd(w)
}

function padR(s: string, w: number): string {
	return s.padStart(w)
}

function render(rows: Row[]): string {
	const out = [
		"",
		"Per-locale F1 floor gate (#375)",
		"-".repeat(60),
		`${padL("file", 26)} ${padL("locale", 7)} ${padR("micro-F1", 9)} ${padR("floor", 7)}  status`,
	]
	for (const r of rows) {
		const floor = r.floor !== null ? pyFixed(r.floor, 3) : "  —  "
		out.push(
			`${padL(r.file, 26)} ${padL(r.locale ?? "?", 7)} ${padR(pyFixed(r.microF1, 3), 9)} ${padR(floor, 7)}  ${r.status}`
		)
	}
	return out.join("\n")
}

function runSelfTest(): number {
	const fixture = {
		reports: [
			{ file: "canonical-en-us.jsonl", microF1: 0.83 }, // PASS (>= 0.80)
			{ file: "canonical-fr-fr.jsonl", microF1: 0.6 }, // BELOW (< 0.64)
			{ file: "canonical-de-de.jsonl", microF1: 0.7 }, // SKIP (no floor)
			{ file: "mystery-xx.jsonl", microF1: 0.5 }, // UNKNOWN_LOCALE
		],
	}
	const rows = evaluate(fixture.reports, DEFAULT_FLOORS)
	const got: Record<string, string> = {}
	for (const r of rows) got[r.file] = r.status
	const expected: Record<string, string> = {
		"canonical-en-us.jsonl": "PASS",
		"canonical-fr-fr.jsonl": "BELOW",
		"canonical-de-de.jsonl": "SKIP",
		"mystery-xx.jsonl": "UNKNOWN_LOCALE",
	}
	console.log(render(rows))
	const ok = JSON.stringify(got) === JSON.stringify(expected)
	console.log("\nself-test:", ok ? "PASS" : `FAIL got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`)
	return ok ? 0 : 1
}

interface Args {
	report?: string
	floors?: string
	blocking: boolean
	selfTest: boolean
}

function parseArgs(): Args {
	const argv = process.argv.slice(2)
	const a: Args = { blocking: false, selfTest: false }
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i]
		if (k === "--report") a.report = argv[++i]
		else if (k === "--floors") a.floors = argv[++i]
		else if (k === "--blocking") a.blocking = true
		else if (k === "--self-test") a.selfTest = true
	}
	return a
}

function main(): number {
	const args = parseArgs()

	if (args.selfTest) return runSelfTest()
	if (!args.report) {
		console.error("error: --report is required (or pass --self-test)")
		return 2
	}

	let floors = DEFAULT_FLOORS
	if (args.floors) {
		floors = { ...DEFAULT_FLOORS, ...JSON.parse(readFileSync(args.floors, "utf-8")) }
	}

	const data = JSON.parse(readFileSync(args.report, "utf-8"))
	const reports: Array<Record<string, unknown>> = data.reports ?? (Array.isArray(data) ? data : [])
	const rows = evaluate(reports, floors)
	console.log(render(rows))

	const below = rows.filter((r) => r.status === "BELOW")
	if (below.length > 0) {
		const names = below.map((r) => `${r.locale} (${pyFixed(r.microF1, 3)} < ${pyFixed(r.floor!, 3)})`).join(", ")
		console.error(`\n⚠ ${below.length} locale(s) below floor: ${names}`)
		if (args.blocking) return 1
	} else {
		console.error("\n✓ all floored locales at or above their floor")
	}
	return 0
}

if (import.meta.main) {
	process.exit(main())
}
