/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAddresses real-point resolver eval (Direction-C resolver-depth) — the NON-CIRCULAR accuracy
 *   track, and the head-to-head vs the Pelias parser. Unlike the WOF-bootstrap eval (which renders
 *   WOF places back into strings and resolves WOF→WOF), every row here is a REAL US address with a
 *   REAL government lat/lon from OpenAddresses, independent of the WOF gazetteer the resolver
 *   consults. So the great-circle error from the resolved admin centroid to OA's point is an
 *   honest, un-gamed signal.
 *
 *   Scores BOTH parsers through the same resolver: the neural classifier AND `v0` (our TypeScript
 *   port of the Pelias parser, via the flat→tree adapter). So "neural vs v0" here IS "mailwoman's
 *   neural parser vs the Pelias parser" on real addresses — no Docker Pelias stack needed, since v0
 *   already is that parser.
 *
 *   SELF-REPORTING (eval-integrity safeguard): pass `--out-md <path>` and the runner WRITES its own
 *   markdown table from the computed aggregates. Eval figures must never be hand-typed into docs —
 *   generate them here and include/commit the output verbatim.
 *
 *   Two-tier metric (per the DeepSeek resolver consult — a sub-10km coord bar is impossible for
 *   ADMIN-CENTROID resolution, since a city centroid is legitimately tens of km from edge
 *   addresses):
 *
 *   1. Admin-match Acc@1 — did we resolve to the expected locality (and/or region), by name? This is the
 *        granularity-independent resolver-quality number.
 *   2. Coord error p50/p90 — reported separately as the admin-centroid tier; the street-level tier
 *        (TIGER) will own the sub-km bar later.
 *
 *   Run: node --experimental-strip-types scripts/eval/oa-resolver-eval.ts\
 *   --eval data/eval/external/openaddresses-us-sample.jsonl --limit 2000\
 *   --model /tmp/v072-eval/model.onnx\
 *   --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card /tmp/v072-eval/model-card.json\
 *   --wof
 *   /mnt/playpen/mailwoman-data/wof/admin-global-priority.db,/mnt/playpen/mailwoman-data/wof/postalcode-us.db
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { createWofResolver } from "@mailwoman/core/resolver"
import { type ClassificationRecord, createAddressParser } from "mailwoman"
import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { v0RecordToTree } from "./v0-tree-adapter.ts"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface OaRow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
	source: string
}

/** Most-specific placetype wins (locality beats region beats country). */
const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}

interface Resolved {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
}

/** Collect ALL resolver-attributed nodes (we want per-placetype names, not just the most-specific). */
function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []
	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined
		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			const name = String(meta?.["resolver_name"] ?? n.value ?? "")
			out.push({ id: Number(n.placeId.slice(4)), name, placetype, lat: n.lat, lon: n.lon })
		}
		for (const c of n.children) visit(c)
	}
	for (const r of tree.roots) visit(r)
	return out
}

function mostSpecific(rs: Resolved[]): Resolved | null {
	let best: Resolved | null = null
	for (const r of rs) {
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) best = r
	}
	return best
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371
	const dLat = ((lat2 - lat1) * Math.PI) / 180
	const dLon = ((lon2 - lon1) * Math.PI) / 180
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
	return 2 * R * Math.asin(Math.sqrt(a))
}

const norm = (s: string | undefined): string => (s ?? "").toLowerCase().trim()

/**
 * Aggressive name normalization for gazetteer-alias locality matching. Lowercases, strips
 * diacritics + punctuation, expands the universal US place abbreviations (St→Saint, Mt→Mount,
 * Ft→Fort, Ste→Sainte), and de-spaces "Mc X" → "McX". Deliberately does NOT strip civic
 * suffixes (City/Town/Township/Village): in New England "Barre City" and "Barre Town" are
 * DISTINCT municipalities, so collapsing them would over-credit genuine wrong-place misses.
 * Pair with the WOF altname set (a place's own recorded variants) rather than loosening here.
 */
const ABBR: Record<string, string> = { st: "saint", ste: "sainte", mt: "mount", ft: "fort" }
const normName = (s: string | undefined): string => {
	if (!s) return ""
	const x = s
		.toLowerCase()
		.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "") // drop diacritics
		.replace(/[^a-z0-9]+/g, " ") // punctuation/hyphens → space (Butte-Silver Bow → butte silver bow)
		.trim()
	const toks = x
		.split(" ")
		.filter(Boolean)
		.map((t) => ABBR[t] ?? t)
	return toks.join(" ").replace(/\bmc (\w)/g, "mc$1").replace(/\s+/g, " ").trim()
}

// Resolved region names are the gazetteer's CANONICAL full names ("California", "District of
// Columbia"); OA's expected.region is the USPS abbreviation ("CA", "DC"). Map full name → abbrev so
// region-match compares like-for-like. Embedded inline (not imported from @mailwoman/corpus, which
// has no exports map → fragile subpath import for a standalone script).
const STATE_NAME_TO_ABBR: Record<string, string> = {
	alabama: "AL",
	alaska: "AK",
	arizona: "AZ",
	arkansas: "AR",
	california: "CA",
	colorado: "CO",
	connecticut: "CT",
	delaware: "DE",
	"district of columbia": "DC",
	florida: "FL",
	georgia: "GA",
	hawaii: "HI",
	idaho: "ID",
	illinois: "IL",
	indiana: "IN",
	iowa: "IA",
	kansas: "KS",
	kentucky: "KY",
	louisiana: "LA",
	maine: "ME",
	maryland: "MD",
	massachusetts: "MA",
	michigan: "MI",
	minnesota: "MN",
	mississippi: "MS",
	missouri: "MO",
	montana: "MT",
	nebraska: "NE",
	nevada: "NV",
	"new hampshire": "NH",
	"new jersey": "NJ",
	"new mexico": "NM",
	"new york": "NY",
	"north carolina": "NC",
	"north dakota": "ND",
	ohio: "OH",
	oklahoma: "OK",
	oregon: "OR",
	pennsylvania: "PA",
	"rhode island": "RI",
	"south carolina": "SC",
	"south dakota": "SD",
	tennessee: "TN",
	texas: "TX",
	utah: "UT",
	vermont: "VT",
	virginia: "VA",
	washington: "WA",
	"west virginia": "WV",
	wisconsin: "WI",
	wyoming: "WY",
	"puerto rico": "PR",
}

/** True if the resolved region (full name OR already an abbrev) matches the expected USPS abbrev. */
function regionMatches(resolvedName: string | undefined, expectedAbbr: string | undefined): boolean {
	if (!resolvedName || !expectedAbbr) return false
	const exp = norm(expectedAbbr)
	const got = norm(resolvedName)
	return got === exp || STATE_NAME_TO_ABBR[got]?.toLowerCase() === exp
}

function percentile(xs: number[], p: number): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/openaddresses-us-sample.jsonl")
	const limit = Number(arg("limit", "0")) || Infinity
	const wofPaths = arg("wof", "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db")
		.split(",")
		.map((s) => s.trim())

	const rows: OaRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	const { NeuralAddressClassifier } = await import("@mailwoman/neural")
	const { OnnxRunner } = await import("@mailwoman/neural/onnx-runner")
	const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
	const modelCard = JSON.parse(readFileSync(arg("model-card"), "utf8"))
	const [tokenizer, runner] = await Promise.all([
		MailwomanTokenizer.loadFromFile(arg("tokenizer")),
		OnnxRunner.create(arg("model")),
	])
	const neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })

	// v0 = our TypeScript port of the Pelias parser. Scoring it through the same resolver makes this a
	// real "neural vs Pelias parser" head-to-head on non-circular addresses.
	const v0 = createAddressParser()

	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WofSqlitePlaceLookup({ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths })
	const resolver = createWofResolver(backend as never)

	// Gazetteer-alias locality matching. A resolved place counts as a locality match if OA's
	// expected name equals ANY of that place's WOF `names` rows (normalized) — not just its
	// single canonical name. This credits forms WOF records as the SAME place (Butte ↔
	// Butte-Silver Bow, Saint ↔ St. Johnsbury, Mt ↔ Mount Pleasant) WITHOUT loosening genuine
	// wrong-place misses: different WOF ids carry disjoint name sets, so Saint Albans never
	// matches St. Johnsbury. The admin db (shard 0) is opened read-only; `names` is indexed on
	// id, and lookups are cached + only fire on a near-miss, so the cost is negligible.
	const adminDb = new DatabaseSync(wofPaths[0]!, { readOnly: true })
	const namesStmt = adminDb.prepare("SELECT name FROM names WHERE id = ?")
	const altCache = new Map<number, Set<string>>()
	const altNamesFor = (id: number): Set<string> => {
		let set = altCache.get(id)
		if (!set) {
			set = new Set<string>()
			for (const r of namesStmt.all(id) as { name: string }[]) {
				const n = normName(r.name)
				if (n) set.add(n)
			}
			altCache.set(id, set)
		}
		return set
	}
	const localityMatches = (expected: string | undefined, locNode: Resolved | undefined): boolean => {
		if (!expected || !locNode) return false
		const e = normName(expected)
		if (!e) return false
		return normName(locNode.name) === e || altNamesFor(locNode.id).has(e)
	}

	const parseOpts = { postcodeRepair: true } as Parameters<typeof neural.parse>[1]
	const resolveOpts = { defaultCountry: "US" }

	// Per-state aggregation so no single dense state (Cook County / Chicago) dominates the headline.
	interface Agg {
		n: number
		localityMatch: number
		regionMatch: number
		resolved: number
		errs: number[]
	}
	const newAgg = (): Agg => ({ n: 0, localityMatch: 0, regionMatch: 0, resolved: 0, errs: [] })
	const bump = (a: Agg, locMatch: boolean, regMatch: boolean, resolved: boolean, err: number | null): void => {
		a.n++
		if (locMatch) a.localityMatch++
		if (regMatch) a.regionMatch++
		if (resolved) a.resolved++
		if (err !== null) a.errs.push(err)
	}

	/** Resolve one tree, return the admin-match flags + coord error vs OA's ground-truth point. */
	const scoreTree = (
		row: OaRow,
		resolved: Resolved[]
	): {
		locMatch: boolean
		regMatch: boolean
		resolved: boolean
		err: number | null
		resolvedLoc?: string
		resolvedReg?: string
	} => {
		const best = mostSpecific(resolved)
		// Admin-match is by NAME (OA carries no WOF id): a row matches if OA's expected locality
		// equals the resolved place's canonical name OR any of its WOF altnames (see
		// localityMatches); region is name-or-abbrev tolerant.
		const locNode = resolved.find((r) => r.placetype === "locality")
		const locRaw = locNode?.name
		const regResolved = resolved.find((r) => r.placetype === "region")
		return {
			locMatch: localityMatches(row.expected.locality, locNode),
			regMatch: regionMatches(regResolved?.name, row.expected.region),
			resolved: !!best,
			err: best ? haversineKm(best.lat, best.lon, row.lat, row.lon) : null,
			// Raw resolved names for the --errors-json per-row dump: a present-but-wrong resolvedLoc
			// => resolver ranking/disambiguation miss; an absent one => coverage/parse miss.
			resolvedLoc: locRaw,
			resolvedReg: regResolved?.name,
		}
	}

	// Two parsers, each with its own overall + per-state aggregates.
	const agg = {
		neural: { overall: newAgg(), byState: new Map<string, Agg>() },
		v0: { overall: newAgg(), byState: new Map<string, Agg>() },
	}
	const record = (
		who: "neural" | "v0",
		row: OaRow,
		s: { locMatch: boolean; regMatch: boolean; resolved: boolean; err: number | null }
	): void => {
		const st = row.state || "??"
		const m = agg[who].byState
		if (!m.has(st)) m.set(st, newAgg())
		bump(m.get(st)!, s.locMatch, s.regMatch, s.resolved, s.err)
		bump(agg[who].overall, s.locMatch, s.regMatch, s.resolved, s.err)
	}

	// Per-row failure dump (--errors-json): one record per row where neural OR v0 missed locality,
	// carrying each parser's resolved admin names so failures can be bucketed offline (resolve-wrong
	// vs unresolved vs neural-only vs v0-only). Aggregates are unaffected.
	const collectErrors = !!arg("errors-json")
	const errorRows: Record<string, unknown>[] = []

	let i = 0
	for (const row of rows) {
		i++
		if (i % 500 === 0) console.error(`  ${i}/${rows.length}`)

		// neural
		let nResolved: Resolved[] = []
		try {
			nResolved = collectResolved(await resolver.resolveTree(await neural.parse(row.input, parseOpts), resolveOpts))
		} catch {
			/* unresolved */
		}
		const ns = scoreTree(row, nResolved)
		record("neural", row, ns)

		// v0 (Pelias parser) via the flat→tree adapter
		let vResolved: Resolved[] = []
		try {
			const sol = await v0.parse(row.input)
			const rec = (sol[0]?.classifications ?? {}) as ClassificationRecord
			const tree = v0RecordToTree(row.input, rec).tree as AddressTree
			vResolved = collectResolved(await resolver.resolveTree(tree, resolveOpts))
		} catch {
			/* unresolved */
		}
		const vs = scoreTree(row, vResolved)
		record("v0", row, vs)

		if (collectErrors && (!ns.locMatch || !vs.locMatch)) {
			errorRows.push({
				input: row.input,
				state: row.state ?? "??",
				expected: row.expected,
				neural: { locMatch: ns.locMatch, resolved: ns.resolved, resolvedLoc: ns.resolvedLoc, resolvedReg: ns.resolvedReg, errKm: ns.err },
				v0: { locMatch: vs.locMatch, resolved: vs.resolved, resolvedLoc: vs.resolvedLoc, resolvedReg: vs.resolvedReg, errKm: vs.err },
			})
		}
	}
	if (collectErrors) {
		writeFileSync(arg("errors-json"), JSON.stringify(errorRows, null, 2))
		console.error(`wrote ${errorRows.length} failure rows → ${arg("errors-json")}`)
	}

	// ---- report (self-emitted; eval figures are NEVER hand-typed into docs) ----
	const pct = (x: number, n: number): string => (n ? `${((100 * x) / n).toFixed(1)}%` : "—")
	const p = (xs: number[], q: number): string => percentile(xs, q)?.toFixed(1) ?? "—"
	const lines: string[] = []
	lines.push(`# OpenAddresses real-point resolver eval (${agg.neural.overall.n} rows, non-circular)`)
	lines.push("")
	lines.push(`Model: ${arg("model") || "(shipped weights)"} | WOF shards: ${wofPaths.length}`)
	lines.push("")
	lines.push(`## Head-to-head — neural vs v0 (Pelias parser), both through the same resolver`)
	lines.push("")
	lines.push(`| parser | locality-match | region-match | resolved | coord p50 km | coord p90 km | p99 km |`)
	lines.push(`|---|--:|--:|--:|--:|--:|--:|`)
	const overallRow = (label: string, a: Agg): string =>
		`| ${label} | ${pct(a.localityMatch, a.n)} | ${pct(a.regionMatch, a.n)} | ${pct(a.resolved, a.n)} | ${p(a.errs, 50)} | ${p(a.errs, 90)} | ${p(a.errs, 99)} |`
	lines.push(overallRow("**neural**", agg.neural.overall))
	lines.push(overallRow("v0 (Pelias)", agg.v0.overall))
	lines.push("")
	lines.push(`## Neural per-state (locality-match)`)
	lines.push("")
	lines.push(`| state | n | neural loc | v0 loc | neural reg | v0 reg |`)
	lines.push(`|---|--:|--:|--:|--:|--:|`)
	for (const st of [...agg.neural.byState.keys()].sort()) {
		const nn = agg.neural.byState.get(st)!
		const vv = agg.v0.byState.get(st) ?? newAgg()
		lines.push(
			`| ${st} | ${nn.n} | ${pct(nn.localityMatch, nn.n)} | ${pct(vv.localityMatch, vv.n)} | ${pct(nn.regionMatch, nn.n)} | ${pct(vv.regionMatch, vv.n)} |`
		)
	}
	lines.push("")
	lines.push(
		`Coord error is the ADMIN-CENTROID tier (locality/region centroid → OA's real address point);` +
			` a city centroid is legitimately tens of km from edge addresses, so the headline is the` +
			` admin-MATCH rate, not the coord error. Street-level (TIGER) will own a sub-km tier later.`
	)
	const report = lines.join("\n")
	console.log(report)

	if (arg("out-md")) {
		writeFileSync(arg("out-md"), report + "\n")
		console.error(`wrote markdown → ${arg("out-md")}`)
	}
	if (arg("out-json")) {
		const dump = (g: { overall: Agg; byState: Map<string, Agg> }) => ({
			overall: { ...g.overall, errs: undefined, errN: g.overall.errs.length },
			coord: {
				p50: percentile(g.overall.errs, 50),
				p90: percentile(g.overall.errs, 90),
				p99: percentile(g.overall.errs, 99),
			},
			byState: Object.fromEntries([...g.byState].map(([k, v]) => [k, { ...v, errs: undefined }])),
		})
		writeFileSync(arg("out-json"), JSON.stringify({ neural: dump(agg.neural), v0: dump(agg.v0) }, null, 2))
		console.error(`wrote json → ${arg("out-json")}`)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
