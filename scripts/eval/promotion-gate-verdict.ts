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

/** Sidecar-first reads (the scorers emit JSON beside the markdown since night-11; the regex
 * fallback keeps old out-dirs replayable). A sidecar that exists but can't parse is a loud
 * throw — never a silent fallback to presentation parsing. */
function sidecar(f: string): any | undefined {
	const raw = maybeRead(f)
	return raw === undefined ? undefined : JSON.parse(raw)
}
function tagF1(side: any | undefined, md: string, tag: string): number | undefined {
	if (side?.tags?.[tag]?.f1 !== undefined) return side.tags[tag].f1
	return scorerF1(md, tag)
}

function collect(tag: "fp32" | "int8"): Record<string, number | undefined> {
	const pl = read(`${tag}-per-locale.md`)
	const affix = read(`${tag}-affix.md`)
	const unit = read(`${tag}-unit.md`)
	const country = read(`${tag}-country.md`)
	const affixJ = sidecar(`${tag}-affix.json`)
	const unitJ = sidecar(`${tag}-unit.json`)
	const countryJ = sidecar(`${tag}-country.json`)
	const poboxJ = sidecar(`${tag}-pobox.json`)
	const intersectionJ = sidecar(`${tag}-intersection.json`)
	const plJ = sidecar(`${tag}-per-locale.json`)
	const pobox = maybeRead(`${tag}-pobox.md`)
	const intersection = maybeRead(`${tag}-intersection.md`)
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
		"us.street_prefix": tagF1(affixJ, affix, "street_prefix"),
		"us.street_suffix": tagF1(affixJ, affix, "street_suffix"),
		"us.unit_real": tagF1(unitJ, unit, "unit"),
		"us.country_homograph_f1": tagF1(countryJ, country, "country"),
		"fr.postcode": perLocale(pl, "postcode", "fr"),
		"fr.house_number": perLocale(pl, "house_number", "fr"),
		"de.native_locality": deNative ? Number(deNative[1]) : undefined,
		"fr.region": perLocale(pl, "region", "fr"),
		"us.po_box_real": poboxJ?.tags?.po_box?.f1 ?? (pobox ? scorerF1(pobox, "po_box") : undefined),
		"fr.cedex_real": poboxJ?.tags?.cedex?.f1 ?? (pobox ? scorerF1(pobox, "cedex") : undefined),
		// Graded as the WEAKER of the two spans — an intersection parse needs both.
		"us.intersection_real":
			intersectionJ ?
				Math.min(intersectionJ.tags?.intersection_a?.f1 ?? 0, intersectionJ.tags?.intersection_b?.f1 ?? 0)
			: intersection ?
				Math.min(scorerF1(intersection, "intersection_a") ?? 0, scorerF1(intersection, "intersection_b") ?? 0)
			:	undefined,
		// Arena leg runs once on the ship artifact (int8); the fp32 pass reads undefined and the
		// delta loop skips it. `| perturb | <n> | <v0>% | <neural>% |` from the three-bucket summary.
		"arena.perturb": (() => {
			const md = maybeRead("arenas.md")
			const m = md?.match(/\|\s*perturb\s*\|\s*\d+\s*\|\s*[\d.]+%\s*\|\s*([\d.]+)%/)
			return m ? Number(m[1]) : undefined
		})(),
	}
}

function maybeRead(f: string): string | undefined {
	try {
		return read(f)
	} catch {
		return undefined
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
