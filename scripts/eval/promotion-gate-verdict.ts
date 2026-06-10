/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Verdict assembler for promotion-gate.sh (#479). Parses the battery outputs the runner
 *   teed into --out-dir, checks every number against the gate spec's floors, enforces the
 *   fp32↔int8 delta cap, and writes verdict.json. Exit 0 = all floors met; exit 1 = any miss.
 *
 *   Parsing contract: the scorers emit pipe-tables (`| tag | P | R | F1 |` from the affix
 *   scorers, `| tag | golden | … |` from per-locale-f1, the de-order summary line). If a
 *   harness output format changes, THIS file is the single place the gate's parsing breaks —
 *   loudly (a floor whose number can't be found is a FAIL, never a skip).
 */

import { readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
	options: {
		gate: { type: "string" },
		"out-dir": { type: "string" },
		"with-int8": { type: "boolean", default: false },
	},
})
if (!args.gate || !args["out-dir"]) throw new Error("--gate and --out-dir required")

const gate = JSON.parse(readFileSync(args.gate, "utf8")) as {
	label: string
	floors: Record<string, number>
	int8_vs_fp32_max_delta_pp?: number
}
const dir = args["out-dir"]
const read = (f: string) => readFileSync(path.join(dir, f), "utf8")

/** Pull `| <tag> | … | <F1> |`-style F1 from an affix/country scorer table (P, R, F1 columns). */
function scorerF1(md: string, tag: string): number | undefined {
	const m = md.match(new RegExp(`\\|\\s*${tag}\\s*\\|\\s*[\\d.]+\\s*\\|\\s*[\\d.]+\\s*\\|\\s*([\\d.]+)`))
	return m ? Number(m[1]) : undefined
}

/** Pull the per-locale table's per-tag percentage for a locale column (US first, FR second). */
function perLocale(md: string, tag: string, locale: "us" | "fr"): number | undefined {
	const m = md.match(new RegExp(`\\|\\s*${tag}\\s*\\|\\s*([\\d.]+)%\\s*\\|\\s*([\\d.—-]+)%?`))
	if (!m) return undefined
	return Number(locale === "us" ? m[1] : m[2]) || undefined
}

function collect(tag: "fp32" | "int8"): Record<string, number | undefined> {
	const pl = read(`${tag}-per-locale.md`)
	const affix = read(`${tag}-affix.md`)
	const unit = read(`${tag}-unit.md`)
	const country = read(`${tag}-country.md`)
	const deorder = read(`${tag}-deorder.md`)
	const deNative = deorder.match(/native DE\s*\|\s*[\d.]+%\s*\|\s*([\d.]+)%/)
	// Locale summary row: `| us | <n> | <macro>% | <micro>% | <exact>% |`
	const micro = pl.match(/\|\s*us\s*\|\s*\d+\s*\|\s*[\d.]+%\s*\|\s*([\d.]+)%/)
	return {
		"us.postcode": perLocale(pl, "postcode", "us"),
		"us.locality": perLocale(pl, "locality", "us"),
		"us.region": perLocale(pl, "region", "us"),
		"us.street": perLocale(pl, "street", "us"),
		"us.micro": micro ? Number(micro[1]) : undefined,
		"us.street_prefix": scorerF1(affix, "street_prefix"),
		"us.street_suffix": scorerF1(affix, "street_suffix"),
		"us.unit_real": scorerF1(unit, "unit"),
		"us.country_homograph_f1": scorerF1(country, "country"),
		"fr.postcode": perLocale(pl, "postcode", "fr"),
		"fr.house_number": perLocale(pl, "house_number", "fr"),
		"de.native_locality": deNative ? Number(deNative[1]) : undefined,
	}
}

const fp32 = collect("fp32")
const int8 = args["with-int8"] ? collect("int8") : undefined
const graded = int8 ?? fp32 // floors are graded on the ship artifact when present

const results: Record<string, { floor: number; actual: number | undefined; pass: boolean }> = {}
let failed = false
for (const [key, floor] of Object.entries(gate.floors)) {
	const actual = graded[key]
	const pass = actual !== undefined && actual >= floor
	if (!pass) failed = true
	results[key] = { floor, actual, pass }
}

const deltas: Record<string, number> = {}
if (int8 && gate.int8_vs_fp32_max_delta_pp !== undefined) {
	for (const key of Object.keys(gate.floors)) {
		const a = fp32[key]
		const b = int8[key]
		if (a === undefined || b === undefined) continue
		const d = Math.abs(a - b)
		deltas[key] = Number(d.toFixed(2))
		if (d > gate.int8_vs_fp32_max_delta_pp) {
			failed = true
			results[`int8_delta.${key}`] = { floor: gate.int8_vs_fp32_max_delta_pp, actual: d, pass: false }
		}
	}
}

const verdict = {
	label: gate.label,
	graded_artifact: int8 ? "int8" : "fp32",
	verdict: failed ? "FAIL" : "PASS",
	results,
	int8_vs_fp32_deltas: deltas,
	generated_at_dir: dir,
}
writeFileSync(path.join(dir, "verdict.json"), JSON.stringify(verdict, null, "\t"))

console.log(`\n== promotion gate [${gate.label}] — ${verdict.verdict} ==`)
for (const [k, r] of Object.entries(results)) {
	console.log(`  ${r.pass ? "✓" : "✗"} ${k}: ${r.actual ?? "NOT FOUND"} (floor ${r.floor})`)
}
process.exit(failed ? 1 : 0)
