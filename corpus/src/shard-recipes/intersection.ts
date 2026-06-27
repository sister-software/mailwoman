/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `intersection` shard recipe — the REAL-pair intersection training shard (#487). The model scored
 *   0.0 on intersection_a/b because the training mix had ZERO intersection-labeled rows. This is
 *   the missing data. Ported from scripts/build-intersection-shard.mjs.
 *
 *   STREET PAIRS ARE REAL: the same TIGER 2023 EDGES extraction as the eval builder
 *   (scripts/eval/build-intersection-real.ts) — a node where two road edges (MTFCC S1*) with
 *   distinct FULLNAMEs meet is a real crossing. Real pairs avoid teaching fake street-street
 *   co-occurrences.
 *
 *   LEAKAGE POLICY (mirrors the affix shard's VT discipline):
 *
 *   - TRAIN counties: Cook IL (grid city) + Morris NJ (suburb).
 *   - GOLDEN (`--golden`) county: Washington VT (rural) ONLY — the corpus defaultHoldout state.
 *   - Every crossing in data/eval/external/intersection-real.jsonl is excluded from BOTH modes, by node
 *       id AND by order-insensitive name pair (the eval shares all three counties).
 *
 *   RENDERING: junction-format variety — padded/TIGHT `&` and `/`, `and`, `at`, `@`, leading-phrase
 *   `corner of` / `intersection of` — crossed with tails (bare / `, ST` / `, ST ZIP` / `, City, ST
 *   [ZIP]`) and case variants. ZIPs are the crossing's own TIGER edge ZIPL (real); the locality
 *   tail comes from the OA Cook-county ZIP→city majority map.
 *
 *   AUDIT: every emitted row is label-checked on the RAW SURFACE via the #519 char-offset span
 *   triple. Any violation FAILS the build (throws). A JSON audit report lands next to the output.
 *
 *   External inputs (`--edges-dir`, opts.edgesDir; both already on disk — do not re-download):
 *
 *   - <edges-dir>/tl_2023_{17031,34027,50023}_edges.shp (unzipped TIGER 2023 EDGES; default
 *       /tmp/tiger-edges)
 *   - /tmp/oa-cache/us__il__cook.zip (ZIP→city tails)
 */

import type { DuckDBConnection } from "@duckdb/node-api"
import type { ComponentTag } from "@mailwoman/core/types"
import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

import { stableSourceId } from "../adapter.js"
import { alignRow } from "../align.js"
import type { CanonicalRow, LabeledRow } from "../types.js"
import { makeMulberry32, type ShardRecipe } from "./scaffold.js"

interface County {
	fips: string
	state: string
	regime: string
}
const TRAIN_COUNTIES: readonly County[] = [
	{ fips: "17031", state: "IL", regime: "grid-city" },
	{ fips: "34027", state: "NJ", regime: "suburb" },
]
const GOLDEN_COUNTIES: readonly County[] = [{ fips: "50023", state: "VT", regime: "rural" }]

const EVAL_GOLD_PATH = String(repoRootPathBuilder("data", "eval", "external", "intersection-real.jsonl"))
const OA_COOK = { zip: "/tmp/oa-cache/us__il__cook.zip", csv: "us/il/cook.csv" }

/** One real crossing extracted from a county's TIGER EDGES shapefile. */
interface Crossing {
	a: string
	b: string
	zip: string | null
	node: number
	fips: string
	state: string
}

/**
 * Junction forms. Weights favor the common connectors; the tight (unpadded) variants and leading
 * phrases get enough mass to register (each ≥5%) — they're the audited gaps the old synth missed.
 */
interface Form {
	id: string
	w: number
	render: (a: string, b: string) => string
}
const FORMS: readonly Form[] = [
	{ id: "amp", w: 0.2, render: (a, b) => `${a} & ${b}` },
	{ id: "and", w: 0.2, render: (a, b) => `${a} and ${b}` },
	{ id: "at", w: 0.12, render: (a, b) => `${a} at ${b}` },
	{ id: "slash", w: 0.08, render: (a, b) => `${a} / ${b}` },
	{ id: "slash-tight", w: 0.06, render: (a, b) => `${a}/${b}` },
	{ id: "amp-tight", w: 0.05, render: (a, b) => `${a}&${b}` },
	{ id: "at-sign", w: 0.06, render: (a, b) => `${a} @ ${b}` },
	{ id: "corner-of", w: 0.115, render: (a, b) => `corner of ${a} and ${b}` },
	{ id: "intersection-of", w: 0.115, render: (a, b) => `intersection of ${a} and ${b}` },
]

/**
 * Tail forms. ~55% bare (the v0.7.2 lesson: an always-present tail taught the model to read
 * post-intersection text as a locality and fumble bare "X & Y"). City tails require a ZIP→city hit
 * (Cook only); ZIP tails require the edge to carry a ZIPL. Misses downgrade to the region tail.
 */
interface Tail {
	id: string
	w: number
}
const TAILS: readonly Tail[] = [
	{ id: "bare", w: 0.55 },
	{ id: "region", w: 0.16 },
	{ id: "region-zip", w: 0.09 },
	{ id: "city-region", w: 0.08 },
	{ id: "city-region-zip", w: 0.12 },
]

interface Casing {
	id: string
	w: number
	apply: (s: string) => string
}
const CASES: readonly Casing[] = [
	{ id: "as-is", w: 0.82, apply: (s) => s },
	{ id: "upper", w: 0.12, apply: (s) => s.toUpperCase() },
	{ id: "lower", w: 0.06, apply: (s) => s.toLowerCase() },
]

/**
 * Words a connector may contribute as O tokens. The audit rejects any O token outside this set — an
 * unlabeled street/locality token would surface here.
 */
const CONNECTOR_O_TOKENS = new Set(["and", "at", "of", "corner", "intersection"])

/**
 * Street names that would make the connector ambiguous or break verbatim alignment: embedded
 * connector punctuation, or a standalone "and"/"at" word.
 */
const BAD_NAME = /[,&@/]|\b(and|at)\b/i

/** Punctuation a connector form may leave between spans (besides whitespace): `, & @ /`. */
const CONNECTOR_PUNCT_RE = /^[\s,&@/]*$/

function weightedPick<T extends { w: number }>(items: readonly T[], random: () => number): T {
	const total = items.reduce((s, x) => s + x.w, 0)
	let r = random() * total
	for (const item of items) {
		r -= item.w
		if (r <= 0) return item
	}
	return items[items.length - 1]!
}

/** Minimal RFC-4180-ish splitter (handles quoted fields) — same as the affix builder. */
function splitCsv(line: string): string[] {
	const out: string[] = []
	let cur = ""
	let inQ = false
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (inQ) {
			if (c === '"') {
				if (line[i + 1] === '"') {
					cur += '"'
					i++
				} else inQ = false
			} else cur += c
		} else if (c === '"') inQ = true
		else if (c === ",") {
			out.push(cur)
			cur = ""
		} else cur += c
	}
	out.push(cur)
	return out
}

/** Order-insensitive crossing key, for eval-leakage exclusion + pair dedup. */
const pairKey = (a: string, b: string): string => [a.toLowerCase(), b.toLowerCase()].sort().join("\x1f")

/** Load the eval's crossings so neither train nor golden ever sees them. */
function readEvalExclusions(): { nodes: Set<number>; pairs: Set<string> } {
	const nodes = new Set<number>()
	const pairs = new Set<string>()
	if (!existsSync(EVAL_GOLD_PATH)) {
		console.error(`  WARN: eval gold not found at ${EVAL_GOLD_PATH} — no eval-leakage exclusion applied`)
		return { nodes, pairs }
	}
	for (const line of readFileSync(EVAL_GOLD_PATH, "utf8").split("\n")) {
		if (!line) continue
		const row = JSON.parse(line)
		nodes.add(Number(row.node))
		pairs.add(pairKey(row.components.intersection_a, row.components.intersection_b))
	}
	return { nodes, pairs }
}

/**
 * Extract real crossings from one county's TIGER EDGES shapefile. Same query shape as the eval
 * builder (2 incident distinct S1* FULLNAMEs at a node, both names >=6 chars), plus the edge ZIPL
 * so tails can carry the crossing's own ZIP. Hash-ordered for seed-stable determinism.
 */
async function extractCrossings(
	db: DuckDBConnection,
	edgesDir: string,
	county: County,
	seed: number
): Promise<Crossing[]> {
	const shp = `${edgesDir}/tl_2023_${county.fips}_edges.shp`
	const result = await db.runAndReadAll(`
		WITH incidence AS (
			SELECT TNIDF AS node, FULLNAME AS name, ZIPL AS zip
			FROM ST_Read('${shp}') WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
			UNION ALL
			SELECT TNIDT AS node, FULLNAME AS name, ZIPL AS zip
			FROM ST_Read('${shp}') WHERE MTFCC LIKE 'S1%' AND FULLNAME IS NOT NULL
		),
		nodes AS (
			SELECT node,
				list_sort(list_distinct(list(name))) AS names,
				max(zip) AS zip
			FROM incidence GROUP BY node
			HAVING len(list_distinct(list(name))) = 2
		)
		SELECT node, names[1] AS a, names[2] AS b, zip,
			hash(node::VARCHAR || '${seed}') AS h
		FROM nodes
		WHERE len(names[1]) >= 6 AND len(names[2]) >= 6
		ORDER BY h
	`)
	const out: Crossing[] = []
	for (const r of result.getRowObjects()) {
		out.push({
			a: String(r.a),
			b: String(r.b),
			zip: r.zip == null ? null : String(r.zip),
			node: Number(r.node),
			fips: county.fips,
			state: county.state,
		})
	}
	return out
}

/** ZIP → majority city from the cached OA Cook-county CSV (real ZIP/city pairings). */
function buildZipCityMap(): Map<string, string> {
	const r = spawnSync("unzip", ["-p", OA_COOK.zip, OA_COOK.csv], { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" })
	if (r.status !== 0) {
		console.error(`  WARN: unzip failed for ${OA_COOK.zip} — city tails disabled`)
		return new Map()
	}
	const lines = r.stdout.toString("utf8").split(/\r?\n/)
	if (lines.length < 2) return new Map()
	const header = splitCsv(lines[0]!).map((h) => h.trim().toLowerCase())
	const iCity = header.indexOf("city")
	const iPost = header.indexOf("postcode")
	const counts = new Map<string, Map<string, number>>() // zip → Map(city → n)
	for (let li = 1; li < lines.length; li++) {
		if (!lines[li]) continue
		const cells = splitCsv(lines[li]!)
		const city = (cells[iCity] ?? "").trim()
		const zip = (cells[iPost] ?? "").trim()
		if (!city || !/^\d{5}$/.test(zip) || BAD_NAME.test(city)) continue
		let byCity = counts.get(zip)
		if (!byCity) counts.set(zip, (byCity = new Map()))
		byCity.set(city, (byCity.get(city) ?? 0) + 1)
	}
	const map = new Map<string, string>()
	for (const [zip, byCity] of counts) {
		let best: { city: string; n: number } | null = null
		for (const [city, n] of byCity) if (!best || n > best.n) best = { city, n }
		if (best) map.set(zip, best.city)
	}
	return map
}

/**
 * Render one crossing → { raw, components, formId, tailId, caseId }. Components are inserted in
 * claim order (streets first) so alignment can't grab a region/postcode lookalike inside a street.
 */
function renderRow(
	random: () => number,
	crossing: Crossing,
	zipCity: Map<string, string>
): { raw: string; components: Partial<Record<ComponentTag, string>>; formId: string; tailId: string; caseId: string } {
	const form = weightedPick(FORMS, random)
	const body = form.render(crossing.a, crossing.b)

	let tail = weightedPick(TAILS, random)
	const city = crossing.zip ? (zipCity.get(crossing.zip) ?? null) : null
	// Downgrade unsatisfiable tails (no ZIP on the edge / no city for the ZIP) to the region tail.
	if ((tail.id === "region-zip" || tail.id === "city-region-zip") && !crossing.zip) tail = TAILS[1]!
	if ((tail.id === "city-region" || tail.id === "city-region-zip") && !city) tail = TAILS[1]!

	const components: Partial<Record<ComponentTag, string>> = { intersection_a: crossing.a, intersection_b: crossing.b }
	let raw = body
	if (tail.id === "region") {
		raw = `${body}, ${crossing.state}`
		components.region = crossing.state
	} else if (tail.id === "region-zip") {
		raw = `${body}, ${crossing.state} ${crossing.zip}`
		components.region = crossing.state
		components.postcode = crossing.zip!
	} else if (tail.id === "city-region") {
		raw = `${body}, ${city}, ${crossing.state}`
		components.locality = city!
		components.region = crossing.state
	} else if (tail.id === "city-region-zip") {
		raw = `${body}, ${city}, ${crossing.state} ${crossing.zip}`
		components.locality = city!
		components.region = crossing.state
		components.postcode = crossing.zip!
	}

	const casing = weightedPick(CASES, random)
	raw = casing.apply(raw)
	// Components keep their original case; alignRow matches case-insensitively and labels the
	// tokens of the (cased) raw — the parquet row carries tokens+labels only.
	return { raw, components, formId: form.id, tailId: tail.id, caseId: casing.id }
}

/**
 * Label-correctness audit for one aligned row, on the RAW SURFACE via the #519 span triple. Returns
 * a list of violations (empty = clean). Re-derives the span checks independent of `alignRow`'s own
 * assertion, so a builder bug can't vouch for itself.
 */
function auditRow(row: LabeledRow, components: Partial<Record<ComponentTag, string>>): string[] {
	const errors: string[] = []
	const { raw, tokens, labels, span_starts, span_ends, span_tags } = row
	if (tokens.length !== labels.length) errors.push("tokens/labels length mismatch")

	if (!span_starts || !span_ends || !span_tags) {
		errors.push("missing the char-offset span triple (#519)")
		return errors
	}
	if (span_starts.length !== span_ends.length || span_starts.length !== span_tags.length) {
		errors.push(`span triple not parallel: ${span_starts.length}/${span_ends.length}/${span_tags.length}`)
		return errors
	}
	for (let i = 0; i < span_starts.length; i++) {
		if (!(span_starts[i]! >= 0 && span_starts[i]! < span_ends[i]! && span_ends[i]! <= raw.length)) {
			errors.push(`span ${span_tags[i]}@[${span_starts[i]}, ${span_ends[i]}) out of bounds`)
		}
		if (i > 0 && span_starts[i]! < span_ends[i - 1]!) {
			errors.push(`spans unsorted/overlapping at index ${i}`)
		}
	}
	if (errors.length > 0) return errors

	const compCount = Object.keys(components).length
	if (span_tags.length !== compCount) errors.push(`span count ${span_tags.length} != components ${compCount}`)

	// Raw-surface reconstruction: each component's single span slices raw to the component verbatim.
	for (const [tag, value] of Object.entries(components)) {
		if (value == null) continue
		const indices = span_tags.map((t, i) => (t === tag ? i : -1)).filter((i) => i >= 0)
		if (indices.length !== 1) {
			errors.push(`${tag}: expected 1 span, got ${indices.length}`)
			continue
		}
		const idx = indices[0]!
		const got = raw.slice(span_starts[idx]!, span_ends[idx]!)
		if (got.toLowerCase() !== value.toLowerCase()) errors.push(`${tag} span "${got}" != component "${value}"`)
	}

	// Negative space: every char outside the spans must be connector material.
	let cursor = 0
	const uncovered: string[] = []
	for (let i = 0; i < span_starts.length; i++) {
		if (span_starts[i]! > cursor) uncovered.push(raw.slice(cursor, span_starts[i]!))
		cursor = span_ends[i]!
	}
	if (cursor < raw.length) uncovered.push(raw.slice(cursor))
	for (const segment of uncovered) {
		const words = segment.match(/[\p{L}\p{N}]+/gu) ?? []
		for (const word of words) {
			if (!CONNECTOR_O_TOKENS.has(word.toLowerCase())) errors.push(`illegal uncovered word "${word}"`)
		}
		const punctOnly = segment.replace(/[\p{L}\p{N}]+/gu, "")
		if (!CONNECTOR_PUNCT_RE.test(punctOnly)) errors.push(`illegal uncovered punctuation in "${segment}"`)
	}
	return errors
}

export const intersectionRecipe: ShardRecipe = {
	name: "intersection",
	description: "Real-pair intersection rows (US): TIGER 2023 EDGES crossings → audited intersection_a/b labels",
	mode: "generate",
	options: [{ flag: "--edges-dir <dir>", description: "Unzipped TIGER 2023 EDGES dir. Default /tmp/tiger-edges" }],
	async run(opts, write) {
		// Legacy build-intersection-shard.mjs seeded `mulberry32(opts.seed)`.
		const random = makeMulberry32(opts.seed)
		const count = opts.count ?? 40000
		const source = opts.sourceName ?? "synth-intersection"
		const edgesDir = opts.edgesDir ?? "/tmp/tiger-edges"
		const counties = opts.golden ? GOLDEN_COUNTIES : TRAIN_COUNTIES
		const exclusions = readEvalExclusions()
		console.error(`  eval exclusions: ${exclusions.nodes.size} nodes, ${exclusions.pairs.size} pairs`)

		const { DuckDBInstance } = await import("@duckdb/node-api")
		const instance = await DuckDBInstance.create()
		const db = await instance.connect()
		await db.run("INSTALL spatial; LOAD spatial;")

		// Pool real crossings: eval-excluded, connector-safe names, one crossing per distinct pair.
		const pool: Crossing[] = []
		const seenPairs = new Set<string>()
		const stats = { evalExcluded: 0, badName: 0, dupPair: 0 }
		for (const county of counties) {
			const crossings = await extractCrossings(db, edgesDir, county, opts.seed)
			let kept = 0
			for (const c of crossings) {
				const key = pairKey(c.a, c.b)
				if (exclusions.nodes.has(c.node) || exclusions.pairs.has(key)) {
					stats.evalExcluded++
					continue
				}
				if (BAD_NAME.test(c.a) || BAD_NAME.test(c.b) || c.a.includes(c.b) || c.b.includes(c.a)) {
					stats.badName++
					continue
				}
				if (seenPairs.has(key)) {
					stats.dupPair++
					continue
				}
				seenPairs.add(key)
				pool.push(c)
				kept++
			}
			console.error(`  ${county.fips} (${county.state}, ${county.regime}): ${crossings.length} crossings, ${kept} kept`)
		}
		if (pool.length === 0) {
			throw new Error(`No crossings found — are the TIGER EDGES shapefiles present in ${edgesDir}?`)
		}

		const zipCity = opts.golden ? new Map<string, string>() : buildZipCityMap()
		if (!opts.golden) console.error(`  zip→city map: ${zipCity.size} ZIPs (OA Cook)`)

		let emitted = 0
		let skipped = 0
		let guard = 0
		const formCounts: Record<string, number> = {}
		const tailCounts: Record<string, number> = {}
		const caseCounts: Record<string, number> = {}
		const countyCounts: Record<string, number> = {}
		const usedCrossings = new Set<number>()
		const seenRaw = new Set<string>()
		const auditErrors: Array<{ raw: string; violations: string[] }> = []
		const samples: Array<{ form: string; raw: string; tokens: readonly string[]; labels: readonly string[] }> = []

		while (emitted < count && guard++ < count * 10) {
			const crossing = pool[Math.floor(random() * pool.length)]!
			const { raw, components, formId, tailId, caseId } = renderRow(random, crossing, zipCity)
			if (seenRaw.has(raw)) {
				skipped++
				continue
			}

			if (opts.golden) {
				seenRaw.add(raw)
				write(JSON.stringify({ raw, components, country: "US", form: formId }) + "\n")
				formCounts[formId] = (formCounts[formId] ?? 0) + 1
				tailCounts[tailId] = (tailCounts[tailId] ?? 0) + 1
				caseCounts[caseId] = (caseCounts[caseId] ?? 0) + 1
				countyCounts[crossing.fips] = (countyCounts[crossing.fips] ?? 0) + 1
				usedCrossings.add(crossing.node)
				emitted++
				continue
			}

			const canonical: CanonicalRow = {
				raw,
				components,
				country: "US",
				locale: "en-US",
				source,
				source_id: stableSourceId(source, components),
				corpus_version: "0.4.0",
				license: "TIGER/Line 2023 EDGES (US Census, public domain) real street pairs; OA Cook IL zip-to-city tails",
			}
			// Verbatim-only alignment: raw is built from the component values, so a fuzzy fallback could
			// only ever mislabel (e.g. claim a lookalike window for a near-duplicate street).
			const aligned = alignRow(canonical, { maxEditDistance: 0 })
			if (aligned.kind !== "labeled" || !aligned.row) {
				skipped++
				continue
			}
			const violations = auditRow(aligned.row, components)
			if (violations.length > 0) {
				auditErrors.push({ raw, violations })
				continue
			}

			seenRaw.add(raw)
			write(JSON.stringify({ ...aligned.row, synth_method: "intersection", synth_base_id: null }) + "\n")
			formCounts[formId] = (formCounts[formId] ?? 0) + 1
			tailCounts[tailId] = (tailCounts[tailId] ?? 0) + 1
			caseCounts[caseId] = (caseCounts[caseId] ?? 0) + 1
			countyCounts[crossing.fips] = (countyCounts[crossing.fips] ?? 0) + 1
			usedCrossings.add(crossing.node)
			if (samples.length < FORMS.length && !samples.some((s) => s.form === formId)) {
				samples.push({ form: formId, raw, tokens: aligned.row.tokens, labels: aligned.row.labels })
			}
			emitted++
		}

		const report = {
			mode: opts.golden ? "golden" : "train",
			rows: emitted,
			skipped,
			pool: { crossings: pool.length, used: usedCrossings.size, ...stats },
			per_county: countyCounts,
			forms: formCounts,
			tails: tailCounts,
			cases: caseCounts,
			audit: { errors: auditErrors.length, examples: auditErrors.slice(0, 10) },
			seed: opts.seed,
			source: "TIGER2023 EDGES via DuckDB ST_Read; node = 2 distinct S1* FULLNAMEs; eval crossings excluded",
			samples,
		}
		writeFileSync(opts.output.replace(/\.jsonl$/, ".report.json"), JSON.stringify(report, null, "\t"))
		console.error(
			`Done: emitted ${emitted} rows (skipped ${skipped}) from ${usedCrossings.size}/${pool.length} real crossings. → ${opts.output}\n` +
				`  forms: ${JSON.stringify(formCounts)}\n` +
				`  tails: ${JSON.stringify(tailCounts)}\n` +
				`  cases: ${JSON.stringify(caseCounts)}\n` +
				`  audit: ${auditErrors.length} violation(s)`
		)
		if (auditErrors.length > 0) {
			throw new Error(`AUDIT FAILED — first violation: ${JSON.stringify(auditErrors[0])}`)
		}
		return { emitted, skipped }
	},
}
