/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PIP-containment metric (coordinate-first plan, #273).
 *
 *   Reads the `--out-resolved` dump from oa-resolver-eval.ts (per row: gold OA lat/lon + the
 *   neural-resolved locality's WOF id + the old name-match flag) and tests the NON-GAMEABLE truth:
 *   does the gold point lie INSIDE the polygon of the resolved WOF locality? This is
 *   name-surface-independent — it rewards a geographically-correct resolve even when WOF's
 *   canonical name ("Plauen") differs from OA's gold ("Plauen Vogtl"). Compares
 *   containment-accuracy vs the old name-match on the SAME rows.
 *
 *   Ported faithfully from scripts/eval/pip-containment.py (pure JSON + filesystem geojson, no
 *   numpy).
 *
 *   Usage: node scripts/eval/pip-containment.ts <resolved.json> [--label
 *   NAME] [--json OUT]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { globPaths, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { pyFixed } from "@mailwoman/core/numeric"
import { readWOFFeature } from "@mailwoman/core/resources/whosonfirst"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { geometryContains, type GeometryLiteral } from "@mailwoman/spatial"

/**
 * Artifact examples collected before the list is truncated.
 */
const MAX_LISTED_ARTIFACTS = 12

const WOF_REPOS = dataRootPath("wof", "repos")

async function adminRoots(): Promise<string[]> {
	let matched: string[]

	try {
		matched = await globPaths(`${WOF_REPOS}/whosonfirst-data/whosonfirst-data-admin-*/data`)
	} catch {
		matched = []
	}

	matched.sort()

	return [...matched, `${WOF_REPOS}/whosonfirst-data-admin-us/data`]
}

const ADMIN_ROOTS = await adminRoots()

const geomCache = new Map<number, GeometryLiteral | null>()

async function geomForID(wofID: number): Promise<GeometryLiteral | null> {
	if (geomCache.has(wofID)) return geomCache.get(wofID)!

	const feature = await readWOFFeature(Math.trunc(wofID), ADMIN_ROOTS)
	const geom = feature?.geometry ?? null

	geomCache.set(wofID, geom)

	return geom
}

type Counter = Record<string, number>

function inc(c: Counter, k: string): void {
	c[k] = (c[k] ?? 0) + 1
}

function get(c: Counter, k: string): number {
	return c[k] ?? 0
}

/**
 * Python `f"{x:+.1f}"` — fixed precision with an always-present sign.
 */
function pySigned(x: number, d: number): string {
	const s = pyFixed(x, d)

	return s.startsWith("-") ? s : "+" + s
}

function padL(s: string, w: number): string {
	return s.padEnd(w)
}

function pyStr(v: unknown): string {
	return v === undefined || v === null ? "None" : String(v)
}

function pct(num: number, den: number): string {
	// Local rather than `formatPercent`: this port renders with `pyFixed` (Python's round-half-even),
	// and `toFixed` rounds half-away — the bytes must match the retired .py report.
	return den ? `${pyFixed((100 * num) / den, 1)}%` : "—"
}

function line(label: string, c: Counter): string {
	const n = get(c, "n")

	if (!n) return `  ${label}: n=0`

	// PIP-containment is reported two ways: over ALL rows (strict) and over rows
	// that HAVE a polygon (coverage-adjusted), since WOF point-geometry localities
	// can never PIP-contain and would otherwise count as silent failures.
	return (
		`  ${padL(label, 10)} n=${padL(String(n), 5)} name-match=${padL(pct(get(c, "name"), n), 7)} ` +
		`PIP-containment=${padL(pct(get(c, "pip"), n), 7)} delta=${pySigned((100 * (get(c, "pip") - get(c, "name"))) / n, 1)}pp  ` +
		`PIP/poly=${padL(pct(get(c, "pip"), get(c, "poly")), 7)} poly-cov=${pct(get(c, "poly"), n)}`
	)
}

interface ResolvedRow {
	state?: string | null
	nameMatch?: unknown
	neuralLocID?: number | null
	lon: number
	lat: number
	input?: string
	expectedLoc?: unknown
	neuralLoc?: unknown
}

async function main(): Promise<number> {
	const { values, positionals } = parseArguments({
		options: { label: { type: "string" }, json: { type: "string" } },
		strict: false,
		allowPositionals: true,
	})

	const src: string | null = positionals[0] ?? null
	const labelArg: string | null = (values.label as string | undefined) ?? null
	const jsonOut: string | null = (values.json as string | undefined) ?? null

	if (!src) {
		console.error("usage: pip-containment.ts <resolved.json> [--label NAME] [--json OUT]")

		return 2
	}

	const rows = await readLocalJSONFile<ResolvedRow[]>(src)
	const overall: Counter = {}
	const byState: Record<string, Counter> = {}
	const artifactExamples: string[] = []
	let noPoly = 0

	for (const r of rows) {
		const st = r.state || "??"
		inc(overall, "n")
		byState[st] ??= {}
		inc(byState[st], "n")
		const nameOk = Boolean(r.nameMatch)

		if (nameOk) {
			inc(overall, "name")
			inc(byState[st]!, "name")
		}

		const lid = r.neuralLocID
		const contained = lid ? geometryContains(await geomForID(lid), r.lon, r.lat) : null

		if (contained !== null) {
			// a polygon existed and was tested (True or False)
			inc(overall, "poly")
			inc(byState[st]!, "poly")
		} else if (lid) {
			noPoly += 1
		}

		if (contained) {
			inc(overall, "pip")
			inc(byState[st]!, "pip")

			if (!nameOk && artifactExamples.length < MAX_LISTED_ARTIFACTS) {
				artifactExamples.push(`  "${r.input}"  gold="${pyStr(r.expectedLoc)}"  resolved="${pyStr(r.neuralLoc)}"`)
			}
		}
	}

	console.log(`\n=== PIP-containment vs name-match (${src}${labelArg ? " · " + labelArg : ""}) ===`)
	console.log(line("OVERALL", overall))

	for (const st of Object.keys(byState).toSorted()) {
		console.log(line(st, byState[st]!))
	}

	console.log(`\n  rows resolved-but-polygon-missing: ${noPoly}`)
	console.log(`\nMETRIC-ARTIFACT cases (name-match FAILED but gold point IS inside the resolved locality):`)

	for (const e of artifactExamples) {
		console.log(e)
	}

	if (jsonOut) {
		const n = get(overall, "n")

		const summary = {
			label: labelArg,
			source: src,
			n,
			name_match: n ? get(overall, "name") / n : null,
			pip_all: n ? get(overall, "pip") / n : null,
			pip_poly: get(overall, "poly") ? get(overall, "pip") / get(overall, "poly") : null,
			poly_coverage: n ? get(overall, "poly") / n : null,
			no_polygon: noPoly,
		}

		await writeLocalJSONFile(summary, jsonOut)

		console.error(`\nwrote summary → ${jsonOut}`)
	}

	return 0
}

runIfScript(import.meta, main)
