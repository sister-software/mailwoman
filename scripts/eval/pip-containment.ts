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
 *   Usage: node --experimental-strip-types scripts/eval/pip-containment.ts <resolved.json> [--label
 *   NAME] [--json OUT]
 */

import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const WOF_REPOS = "/mnt/playpen/mailwoman-data/wof/repos"

function adminRoots(): string[] {
	let matched: string[] = []
	try {
		matched = [...globSync(`${WOF_REPOS}/whosonfirst-data/whosonfirst-data-admin-*/data`)]
	} catch {
		matched = []
	}
	matched.sort()
	return [...matched, `${WOF_REPOS}/whosonfirst-data-admin-us/data`]
}

const ADMIN_ROOTS = adminRoots()

type Ring = number[][]
type Geometry = { type?: string; coordinates?: unknown } | null

const geomCache = new Map<number, Geometry>()

function geomForId(wofId: number): Geometry {
	if (geomCache.has(wofId)) return geomCache.get(wofId)!
	const s = String(Math.trunc(wofId))
	// WOF path: split the id into 3-char chunks (last chunk is the remainder).
	const chunks: string[] = []
	let i = 0
	while (i < s.length) {
		chunks.push(s.slice(i, i + 3))
		i += 3
	}
	const rel = chunks.join("/") + `/${s}.geojson`
	let geom: Geometry = null
	for (const root of ADMIN_ROOTS) {
		const fp = join(root, rel)
		if (existsSync(fp)) {
			try {
				geom = (JSON.parse(readFileSync(fp, "utf-8")).geometry as Geometry) ?? null
			} catch {
				geom = null
			}
			break
		}
	}
	geomCache.set(wofId, geom)
	return geom
}

function inRing(x: number, y: number, ring: Ring): boolean {
	let inside = false
	const n = ring.length
	let j = n - 1
	for (let i = 0; i < n; i++) {
		const xi = ring[i]![0]!
		const yi = ring[i]![1]!
		const xj = ring[j]![0]!
		const yj = ring[j]![1]!
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside
		}
		j = i
	}
	return inside
}

function inPolygon(x: number, y: number, poly: Ring[]): boolean {
	// poly = [outer, hole1, ...] — even-odd handles holes
	let c = false
	for (const ring of poly) {
		if (inRing(x, y, ring)) c = !c
	}
	return c
}

function contains(geom: Geometry, lon: number, lat: number): boolean | null {
	if (!geom) return null // no polygon available
	const t = geom.type
	if (t === "Polygon") return inPolygon(lon, lat, geom.coordinates as Ring[])
	if (t === "MultiPolygon") return (geom.coordinates as Ring[][]).some((p) => inPolygon(lon, lat, p))
	return null // Point geometry etc. — can't contain
}

type Counter = Record<string, number>
function inc(c: Counter, k: string): void {
	c[k] = (c[k] ?? 0) + 1
}
function get(c: Counter, k: string): number {
	return c[k] ?? 0
}

/** Python `format(x, ".{d}f")` — round-half-to-even (banker's), unlike JS `toFixed` (half-away). */
function pyFixed(x: number, d: number): string {
	if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
	const neg = x < 0 || Object.is(x, -0)
	const [intPart, fracRaw = ""] = Math.abs(x).toFixed(99).split(".")
	const frac = fracRaw
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

/** Python `f"{x:+.1f}"` — fixed precision with an always-present sign. */
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
	neuralLocId?: number | null
	lon: number
	lat: number
	input?: string
	expectedLoc?: unknown
	neuralLoc?: unknown
}

function main(): number {
	// --- arg parsing: <resolved.json> [--label NAME] [--json OUT] ---------------
	const args = process.argv.slice(2)
	let src: string | null = null
	let labelArg: string | null = null
	let jsonOut: string | null = null
	let i = 0
	while (i < args.length) {
		const a = args[i]
		if (a === "--label") {
			labelArg = args[i + 1]!
			i += 2
		} else if (a === "--json") {
			jsonOut = args[i + 1]!
			i += 2
		} else {
			src = a!
			i += 1
		}
	}
	if (!src) {
		console.error("usage: pip-containment.ts <resolved.json> [--label NAME] [--json OUT]")
		return 2
	}

	const rows: ResolvedRow[] = JSON.parse(readFileSync(src, "utf-8"))
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
		const lid = r.neuralLocId
		const contained = lid ? contains(geomForId(lid), r.lon, r.lat) : null
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
			if (!nameOk && artifactExamples.length < 12) {
				artifactExamples.push(`  "${r.input}"  gold="${pyStr(r.expectedLoc)}"  resolved="${pyStr(r.neuralLoc)}"`)
			}
		}
	}

	console.log(`\n=== PIP-containment vs name-match (${src}${labelArg ? " · " + labelArg : ""}) ===`)
	console.log(line("OVERALL", overall))
	for (const st of Object.keys(byState).sort()) {
		console.log(line(st, byState[st]!))
	}
	console.log(`\n  rows resolved-but-polygon-missing: ${noPoly}`)
	console.log(`\nMETRIC-ARTIFACT cases (name-match FAILED but gold point IS inside the resolved locality):`)
	for (const e of artifactExamples) console.log(e)

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
		writeFileSync(jsonOut, JSON.stringify(summary, null, 2))
		console.error(`\nwrote summary → ${jsonOut}`)
	}
	return 0
}

if (import.meta.main) {
	process.exit(main())
}
