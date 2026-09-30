/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare name matching with polygon containment for resolved rows. Containment checks whether each gold coordinate
 *   lies inside the resolved WOF locality, independent of name spelling.
 */

import { wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { pyFixed } from "@mailwoman/core/numeric"
import { readWOFFeature } from "@mailwoman/core/resources/whosonfirst"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { geometryContains, type GeometryLiteral } from "@mailwoman/spatial"
import { Globerator } from "spliterator/node/fs"

/**
 * Maximum number of artifact examples printed.
 */
const MAX_LISTED_ARTIFACTS = 12

async function adminRoots(): Promise<string[]> {
	const pattern = wofReposPath("whosonfirst-data/whosonfirst-data-admin-*/data")
	const matched = await Globerator.from(pattern, { absolute: true }).toSorted()

	return [...matched, wofReposPath("whosonfirst-data-admin-us/data").toString()]
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
 * Format a signed fixed-precision value like Python's `f"{x:+.1f}"`.
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
	// Preserve Python-compatible rounding from the original report.
	return den ? `${pyFixed((100 * num) / den, 1)}%` : "—"
}

function line(label: string, c: Counter): string {
	const n = get(c, "n")

	if (!n) return `  ${label}: n=0`

	// Report containment across all rows and separately across rows with polygon geometry.
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
			// A polygon was tested, whether or not it contained the point.
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
