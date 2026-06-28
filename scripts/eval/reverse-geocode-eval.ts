/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reverse-geocoding eval (#484) — the honest-eval harness, inverted. The OA held-out rows carry a
 *   REAL government lat/lon plus gold locality/region; instead of parsing the address string we
 *   feed the COORDINATE to `WofReverseGeocoder` and score whether the gold admin components appear
 *   in the returned hierarchy. No parser, no model — this isolates the reverse stack (R*Tree bbox →
 *   PIP → approximate descent → ancestor chain).
 *
 *   Default slice: the US/VT corpus holdout (`SPLIT_MANIFEST defaultHoldouts`), the same leakage-free
 *   geography honest-eval.ts grades forward resolution on. Leakage matters less here (no trained
 *   model is involved), but using the same slice keeps the numbers comparable.
 *
 *   Metrics:
 *
 *   - **region-match%** — a `region` node in the hierarchy whose name (or `names` alias — gold uses
 *       "VT", WOF says "Vermont") matches the gold region.
 *   - **locality-match%** — any node at localadmin grain or finer whose name/alias matches the gold
 *       locality.
 *   - **containment histogram** — polygon vs approximate (the honesty signal; VT localities are mostly
 *       point-geometry in WOF, so expect approximate to dominate at the locality grain).
 *   - **deepest-placetype distribution** — the empirical answer to the scoping doc's granularity
 *       question (stop at locality vs descend to neighbourhood).
 *   - **ms/query** — mean + p50/p90 over the slice.
 *
 *   SELF-REPORTING (eval-integrity safeguard, same convention as oa-resolver-eval.ts): the runner
 *   prints its own markdown — never hand-type figures into docs.
 *
 *   Run (after `yarn compile`):
 *
 *   Node --experimental-strip-types scripts/eval/reverse-geocode-eval.ts\
 *   --admin-db $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db\
 *   --polygons-db /tmp/v440-stage/en-us/v4.4.0/wof-polygons.db\
 *   --states VT
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { dataRootPath } from "@mailwoman/core/utils"
import { placetypeDepth, WofReverseGeocoder } from "@mailwoman/resolver-wof-sqlite"

const { values: args } = parseArgs({
	options: {
		eval: { type: "string", default: "data/eval/external/openaddresses-us-sample.jsonl" },
		states: { type: "string", default: "VT" },
		"admin-db": { type: "string", default: dataRootPath("wof", "admin-global-priority.db") },
		"polygons-db": { type: "string", default: "/tmp/v440-stage/en-us/v4.4.0/wof-polygons.db" },
		limit: { type: "string" },
		"max-approx-km": { type: "string" },
	},
})

interface EvalRow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
}

/** Case-fold + strip diacritics + collapse punctuation — same normalization as the resolver's. */
function normalizeName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

/**
 * The SURFACE-normalized variant (reported as a separate, labeled metric — never silently folded
 * into the strict one): expands the St↔Saint abbreviation and strips the trailing Town/City/Village
 * status suffix. Both are gold-surface artifacts the honest-eval work already documented (OA says
 * "Saint Albans Town" / "Barre City", WOF says "St. Albans" / "Barre" — same place, different
 * convention), the name-match analogue of the PIP-vs-name-match artifact class.
 */
function normalizeNameLoose(s: string): string {
	return normalizeName(s)
		.replace(/\bst\b/g, "saint")
		.replace(/\s+(town|city|village)$/g, "")
		.trim()
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}

const states = new Set(
	args.states
		.split(",")
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean)
)
const limit = args.limit ? Number(args.limit) : Infinity
const maxApproximateKm = args["max-approx-km"] ? Number(args["max-approx-km"]) : undefined

const rows: EvalRow[] = []
const rl = createInterface({ input: createReadStream(args.eval), crlfDelay: Infinity })
for await (const line of rl) {
	if (!line.trim()) continue
	const row = JSON.parse(line) as EvalRow
	if (!states.has(row.state?.toUpperCase())) continue
	rows.push(row)
	if (rows.length >= limit) break
}
if (rows.length === 0) {
	console.error(`no rows matched states=${[...states].join(",")} in ${args.eval}`)
	process.exit(1)
}

const rg = new WofReverseGeocoder({ adminDbPath: args["admin-db"], polygonDbPath: args["polygons-db"] })
// Alias lookups (gold "VT" vs WOF "Vermont") go straight at the admin DB's `names` table.
const aliasDb = new DatabaseSync(args["admin-db"], { readOnly: true })
const aliasStmt = aliasDb.prepare(`SELECT 1 FROM names WHERE id = ? AND name = ? COLLATE NOCASE LIMIT 1`)
const aliasCache = new Map<string, boolean>()
function nameOrAliasMatches(id: number | string, canonicalName: string, gold: string): boolean {
	if (normalizeName(canonicalName) === normalizeName(gold)) return true
	const key = `${id}\u0000${gold.toLowerCase()}`
	let hit = aliasCache.get(key)
	if (hit === undefined) {
		hit = aliasStmt.get(Number(id), gold) !== undefined
		aliasCache.set(key, hit)
	}
	return hit
}

function looseMatches(canonicalName: string, gold: string): boolean {
	return normalizeNameLoose(canonicalName) === normalizeNameLoose(gold)
}

let regionMatch = 0
let regionScored = 0
let localityMatch = 0
let localityMatchLoose = 0
let localityScored = 0
const containmentCounts = new Map<string, number>()
const deepestCounts = new Map<string, number>()
const localityMatchByContainment = new Map<string, { n: number; match: number }>()
const timesMs: number[] = []
const misses: string[] = []
let empty = 0

for (const row of rows) {
	const t0 = performance.now()
	const result = await rg.reverseGeocode(row.lat, row.lon, maxApproximateKm ? { maxApproximateKm } : {})
	timesMs.push(performance.now() - t0)

	const deepest = result.hierarchy[0]
	if (!deepest) {
		empty++
		continue
	}
	containmentCounts.set(result.containment, (containmentCounts.get(result.containment) ?? 0) + 1)
	deepestCounts.set(deepest.placetype, (deepestCounts.get(deepest.placetype) ?? 0) + 1)

	if (row.expected.region) {
		regionScored++
		const region = result.hierarchy.find((p) => p.placetype === "region")
		if (region && nameOrAliasMatches(region.id, region.name, row.expected.region)) regionMatch++
	}
	if (row.expected.locality) {
		localityScored++
		const bucket = localityMatchByContainment.get(result.containment) ?? { n: 0, match: 0 }
		bucket.n++
		const fine = result.hierarchy.filter((p) => placetypeDepth(p.placetype) >= placetypeDepth("localadmin"))
		const matched = fine.some((p) => nameOrAliasMatches(p.id, p.name, row.expected.locality!))
		const matchedLoose = matched || fine.some((p) => looseMatches(p.name, row.expected.locality!))
		if (matchedLoose) localityMatchLoose++
		if (matched) {
			localityMatch++
			bucket.match++
		} else if (misses.length < 12 && !matchedLoose) {
			misses.push(
				`  "${row.input}" → gold="${row.expected.locality}" got=[${fine.map((p) => `${p.placetype}:${p.name}`).join(", ")}] (${result.containment})`
			)
		}
		localityMatchByContainment.set(result.containment, bucket)
	}
}

rg.close()
aliasDb.close()

const pct = (num: number, den: number): string => (den ? `${((100 * num) / den).toFixed(1)}%` : "—")
const sortedMs = [...timesMs].sort((a, b) => a - b)
const meanMs = timesMs.reduce((a, b) => a + b, 0) / timesMs.length

console.log(`### Reverse-geocode eval — ${[...states].join("/")} slice of \`${args.eval}\``)
console.log("")
console.log(`Admin DB: \`${args["admin-db"]}\` · polygons: \`${args["polygons-db"]}\``)
console.log("")
console.log(`| metric | value |`)
console.log(`| --- | ---: |`)
console.log(`| rows | ${rows.length} |`)
console.log(`| empty hierarchy | ${empty} |`)
console.log(`| region-match | ${pct(regionMatch, regionScored)} (${regionMatch}/${regionScored}) |`)
console.log(`| locality-match (strict) | ${pct(localityMatch, localityScored)} (${localityMatch}/${localityScored}) |`)
console.log(
	`| locality-match (surface-normalized: St↔Saint, Town/City/Village suffix) | ${pct(localityMatchLoose, localityScored)} (${localityMatchLoose}/${localityScored}) |`
)
console.log(`| ms/query mean | ${meanMs.toFixed(2)} |`)
console.log(
	`| ms/query p50 / p90 | ${percentile(sortedMs, 0.5).toFixed(2)} / ${percentile(sortedMs, 0.9).toFixed(2)} |`
)
console.log("")
console.log(`Containment histogram:`)
for (const [kind, n] of [...containmentCounts].sort((a, b) => b[1] - a[1])) {
	const bucket = localityMatchByContainment.get(kind)
	console.log(
		`- \`${kind}\`: ${n} (${pct(n, rows.length - empty)}) — locality-match ${pct(bucket?.match ?? 0, bucket?.n ?? 0)}`
	)
}
console.log("")
console.log(`Deepest-placetype distribution (the granularity question):`)
for (const [pt, n] of [...deepestCounts].sort((a, b) => b[1] - a[1])) {
	console.log(`- \`${pt}\`: ${n} (${pct(n, rows.length - empty)})`)
}
if (misses.length > 0) {
	console.log("")
	console.log(`First locality misses (surface-normalized misses excluded — these are the genuine wrong-place class):`)
	for (const m of misses) console.log(m)
}
