/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAddresses real-point resolver eval (Direction-C resolver-depth, plan item 3) — the
 *   NON-CIRCULAR accuracy track. Unlike the WOF-bootstrap eval (which renders WOF places back into
 *   strings and resolves WOF→WOF), every row here is a REAL US address with a REAL government
 *   lat/lon from OpenAddresses, independent of the WOF gazetteer the resolver consults. So the
 *   great-circle error from the resolved admin centroid to OA's point is an honest, un-gamed signal.
 *
 *   Two-tier metric (per the DeepSeek resolver consult — a sub-10km coord bar is impossible for
 *   ADMIN-CENTROID resolution, since a city centroid is legitimately tens of km from edge
 *   addresses):
 *     1. Admin-match Acc@1 — did we resolve to the expected locality (and/or region), by name? This
 *        is the granularity-independent resolver-quality number.
 *     2. Coord error p50/p90 — reported separately as the admin-centroid tier; the street-level tier
 *        (TIGER) will own the sub-km bar later.
 *
 *   Run:
 *     node --experimental-strip-types scripts/eval/oa-resolver-eval.ts \
 *       --eval data/eval/external/openaddresses-us-sample.jsonl --limit 2000 \
 *       --model /tmp/v072-eval/model.onnx \
 *       --tokenizer /mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model \
 *       --model-card /tmp/v072-eval/model-card.json \
 *       --wof /mnt/playpen/mailwoman-data/wof/admin-global-priority.db,/mnt/playpen/mailwoman-data/wof/postalcode-us.db
 */

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { createWofResolver } from "@mailwoman/core/resolver"
import { readFileSync, writeFileSync } from "node:fs"

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

// Resolved region names are the gazetteer's CANONICAL full names ("California", "District of
// Columbia"); OA's expected.region is the USPS abbreviation ("CA", "DC"). Map full name → abbrev so
// region-match compares like-for-like. Embedded inline (not imported from @mailwoman/corpus, which
// has no exports map → fragile subpath import for a standalone script).
const STATE_NAME_TO_ABBR: Record<string, string> = {
	alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
	connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
	hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
	louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
	mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
	"new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
	ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
	"south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
	virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
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

	const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WofSqlitePlaceLookup({ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths })
	const resolver = createWofResolver(backend as never)

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
	const byState = new Map<string, Agg>()
	const overall: Agg = { n: 0, localityMatch: 0, regionMatch: 0, resolved: 0, errs: [] }
	const bump = (a: Agg, locMatch: boolean, regMatch: boolean, resolved: boolean, err: number | null): void => {
		a.n++
		if (locMatch) a.localityMatch++
		if (regMatch) a.regionMatch++
		if (resolved) a.resolved++
		if (err !== null) a.errs.push(err)
	}

	let i = 0
	for (const row of rows) {
		i++
		if (i % 500 === 0) console.error(`  ${i}/${rows.length}`)
		let resolved: Resolved[] = []
		try {
			resolved = collectResolved(await resolver.resolveTree(await neural.parse(row.input, parseOpts), resolveOpts))
		} catch {
			/* unresolved */
		}
		const best = mostSpecific(resolved)
		// Admin-match: by NAME (OA has no WOF id). A locality row matches if any resolved locality's
		// name equals the expected locality; region likewise. Name comes from the gazetteer via the
		// resolved node; fall back to the node's own value when the resolver didn't stamp a name.
		const locName = norm(resolved.find((r) => r.placetype === "locality")?.name)
		const regResolved = resolved.find((r) => r.placetype === "region")
		const locMatch = !!row.expected.locality && locName === norm(row.expected.locality)
		// Region match is name-or-abbrev tolerant (expected.region is the USPS abbrev like "CA").
		const regMatch = regionMatches(regResolved?.name, row.expected.region)
		const err = best ? haversineKm(best.lat, best.lon, row.lat, row.lon) : null

		const st = row.state || "??"
		if (!byState.has(st)) byState.set(st, { n: 0, localityMatch: 0, regionMatch: 0, resolved: 0, errs: [] })
		bump(byState.get(st)!, locMatch, regMatch, !!best, err)
		bump(overall, locMatch, regMatch, !!best, err)
	}

	const pct = (x: number, n: number): string => (n ? `${((100 * x) / n).toFixed(1)}%` : "—")
	console.log(`# OpenAddresses real-point resolver eval (${overall.n} rows, non-circular)\n`)
	console.log(`Model: ${arg("model") || "(shipped weights)"} | WOF shards: ${wofPaths.length}\n`)
	console.log(`| scope | n | locality-match | region-match | resolved | coord p50 (km) | coord p90 (km) |`)
	console.log(`|---|--:|--:|--:|--:|--:|--:|`)
	const printAgg = (label: string, a: Agg): void => {
		console.log(
			`| ${label} | ${a.n} | ${pct(a.localityMatch, a.n)} | ${pct(a.regionMatch, a.n)} | ${pct(a.resolved, a.n)} | ${percentile(a.errs, 50)?.toFixed(1) ?? "—"} | ${percentile(a.errs, 90)?.toFixed(1) ?? "—"} |`
		)
	}
	printAgg("**overall**", overall)
	for (const st of [...byState.keys()].sort()) printAgg(st, byState.get(st)!)

	console.log(
		`\nCoord error is the ADMIN-CENTROID tier (locality/region centroid → OA's real address point);` +
			` a city centroid is legitimately tens of km from edge addresses, so the headline is the` +
			` admin-MATCH rate, not the coord error. Street-level (TIGER) will own a sub-km tier later.`
	)

	if (arg("out-json")) {
		writeFileSync(
			arg("out-json"),
			JSON.stringify(
				{ overall, byState: Object.fromEntries([...byState].map(([k, v]) => [k, { ...v, errs: undefined }])) },
				null,
				2
			)
		)
		console.error(`wrote → ${arg("out-json")}`)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
