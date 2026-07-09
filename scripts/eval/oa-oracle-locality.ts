/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Oracle-locality diagnostic — decompose the US locality-resolution error into MODEL (tagging) vs
 *   RESOLVER/GAZETTEER (coverage / ranking / name-mismatch). The "ceiling analysis" technique.
 *
 *   The US OA coordinate eval (`oa-resolver-eval.ts`) gets locality-match ~84% overall but craters on
 *   rural states (SD ~62%, VT ~32%), identical across model versions — so it's not a model-version
 *   issue. Is that gap a MODEL problem (mis-tagging the locality span) or a RESOLVER/GAZETTEER
 *   problem (the place isn't findable / a same-name place outranks it / it's under a different
 *   name)?
 *
 *   THE ORACLE TEST: feed the resolver the GROUND-TRUTH locality (from the OA gold) instead of the
 *   model's parsed locality, resolve, and measure. If a row that currently misses NOW resolves with
 *   the gold locality, the model's tagging was the bottleneck (the GAP). If it STILL misses with
 *   the gold locality, the resolver/gazetteer is the bottleneck (the CEILING).
 *
 *   THREE ARMS, one pass, same resolver + WOF DB + `localityMatches` credit logic (apples-to-apples):
 *
 *   - CURRENT (model parse): v1.5.0 int8, the model tags locality; scored `placetype === "locality"`
 *       ONLY — reproduces `oa-resolver-eval.ts`.
 *   - ORACLE-STRICT (gold locality): an AddressTree built from the gold {locality, region, postcode};
 *       the model's locality tag is bypassed. Scored locality-only → the ceiling UNDER current
 *       scoring.
 *   - ORACLE-EXPANDED (gold locality): same tree, scored `locality∪localadmin∪borough` (the placetypes
 *       the resolver's `locality` tag expands to). The TRUE resolver/gazetteer ceiling. The
 *       expanded−strict delta is the SCORING artifact: New England towns + rural civil divisions
 *       are recorded as `localadmin`, which `oa-resolver-eval.ts` discards.
 *
 *   For expanded-oracle-still-fails rows, each is bucketed by querying the admin DB directly:
 *
 *   - COVERAGE — no in-region place sits on the gold point AND the gold name has no plausible variant
 *       there → the place is genuinely absent from admin-global-priority.db.
 *   - NAME-MISMATCH — an in-region place sits on the gold point (≤12 km) whose name is a variant of the
 *       gold (shares a base token after stripping a civic suffix City/Town/Township/Village) →
 *       covered, different surface form.
 *   - RANKING — the gold name IS present in the gold region but a same-name place elsewhere outranked
 *       it (wrong/no instance picked).
 *
 *   `--oracle-only` skips the model (fast bucketing iteration; the `current` column is then blank).
 *
 *   Run: node --experimental-strip-types scripts/eval/oa-oracle-locality.ts\
 *   --eval data/eval/external/openaddresses-us-sample.jsonl\
 *   --model $MAILWOMAN_DATA_ROOT/models/quantized/model-v150-step-40000-int8.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card neural-weights-en-us/model-card.json\
 *   --default-country US [--limit N] [--oracle-only] [--out-md <path>] [--examples-json <path>]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { runIfScript } from "@mailwoman/core/scripting"
import { dataRootPath } from "@mailwoman/core/utils"
import type { ParseOpts } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"

// Loose scan parity with the retired local argv helpers: unknown flags tolerated.
const { values: rawValues } = parseArgs({
	options: {
		"default-country": { type: "string" },
		eval: { type: "string" },
		"examples-json": { type: "string" },
		limit: { type: "string" },
		model: { type: "string" },
		"model-card": { type: "string" },
		"oracle-only": { type: "boolean" },
		"out-md": { type: "string" },
		tokenizer: { type: "string" },
		wof: { type: "string" },
	},
	strict: false,
	allowPositionals: true,
})
// Typed view: strict:false loosens TS inference, but declared options always parse to their schema type.
const values = rawValues as {
	"default-country"?: string
	eval?: string
	"examples-json"?: string
	limit?: string
	model?: string
	"model-card"?: string
	"oracle-only"?: boolean
	"out-md"?: string
	tokenizer?: string
	wof?: string
}
interface OaRow {
	input: string
	lat: number
	lon: number
	expected: { locality?: string; region?: string; postcode?: string }
	state: string
	source: string
}

interface Resolved {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
}

const PLACETYPE_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	localadmin: 4,
	borough: 4,
	county: 3,
	region: 2,
	country: 0,
}

// --- helpers shared with oa-resolver-eval.ts (kept in sync; standalone to avoid a fragile import) ---

const ABBR: Record<string, string> = { st: "saint", ste: "sainte", mt: "mount", ft: "fort" }
const normName = (s: string | undefined): string => {
	if (!s) return ""
	const x = s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
	const toks = x
		.split(" ")
		.filter(Boolean)
		.map((t) => ABBR[t] ?? t)

	return toks
		.join(" ")
		.replace(/\bmc (\w)/g, "mc$1")
		.replace(/\s+/g, " ")
		.trim()
}

function percentile(xs: number[], p: number): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []
	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined

		if (n.placeID?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceID ?? "").split(":")[0] ?? ""
			const name = String(meta?.["resolver_name"] ?? n.value ?? "")
			out.push({ id: Number(n.placeID.slice(4)), name, placetype, lat: n.lat, lon: n.lon })
		}

		for (const interp of (n.interpretations ?? []) as ReadonlyArray<{
			tag: string
			placeID?: string
			sourceID?: string
			lat?: number
			lon?: number
			metadata?: Record<string, unknown>
		}>) {
			if (interp.placeID?.startsWith("wof:") && interp.lat !== undefined && interp.lon !== undefined) {
				const placetype = String(interp.sourceID ?? interp.tag).split(":")[0] ?? ""
				const name = String(interp.metadata?.["resolver_name"] ?? n.value ?? "")
				out.push({ id: Number(interp.placeID.slice(4)), name, placetype, lat: interp.lat, lon: interp.lon })
			}
		}

		for (const c of n.children) {
			visit(c)
		}
	}

	for (const r of tree.roots) {
		visit(r)
	}

	return out
}

function mostSpecific(rs: Resolved[]): Resolved | null {
	let best: Resolved | null = null

	for (const r of rs) {
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) {
			best = r
		}
	}

	return best
}

// The placetypes the resolver's `locality` tag expands to (DEFAULT_PLACETYPE_MAP + expandPlacetypeFilter
// in core/resolver). New England "towns" and many rural-state civil divisions are recorded as
// `localadmin` (or `borough`), NOT `locality` — so a locality-tag resolve legitimately lands a
// localadmin. `oa-resolver-eval.ts` scores `placetype === "locality"` ONLY, which is blind to those
// hits. We surface both filters to isolate that scoring artifact.
const LOCALITY_EXPANDED = new Set(["locality", "localadmin", "borough"])
/** The production `oa-resolver-eval.ts` filter: strictly `placetype === "locality"`. */
const localityStrict = (rs: Resolved[]): Resolved | undefined => rs.find((r) => r.placetype === "locality")
/** The resolver-faithful filter: any placetype the `locality` tag expands to, most-specific first. */
const localityExpanded = (rs: Resolved[]): Resolved | undefined => {
	const hits = rs.filter((r) => LOCALITY_EXPANDED.has(r.placetype))
	let best: Resolved | undefined

	for (const r of hits)
		if (!best || (PLACETYPE_RANK[r.placetype] ?? -1) > (PLACETYPE_RANK[best.placetype] ?? -1)) {
			best = r
		}

	return best
}

async function main(): Promise<void> {
	const evalPath = values["eval"] || "data/eval/external/openaddresses-us-sample.jsonl"
	const limit = Number(values["limit"] || "0") || Infinity
	const dbPath = values["wof"] || dataRootPath("wof", "admin-global-priority.db")
	const dc = values["default-country"] || "US"

	const rows: OaRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	// --- model (CURRENT arm). `--oracle-only` skips the model entirely (fast bucketing iteration; the
	// `current` column is then blank — the oracle arms + buckets don't depend on the model). ---
	const oracleOnly = values["oracle-only"] ?? false
	let neural: { parse: (text: string, opts?: ParseOpts) => Promise<AddressTree> } | null = null
	let parseOpts: ParseOpts = {}

	if (!oracleOnly) {
		const { NeuralAddressClassifier } = await import("@mailwoman/neural")
		const { ONNXRunner } = await import("@mailwoman/neural/onnx-runner")
		const { MailwomanTokenizer } = await import("@mailwoman/neural/tokenizer")
		const modelCard = JSON.parse(readFileSync(values["model-card"] || "neural-weights-en-us/model-card.json", "utf8"))
		const [tokenizer, runner] = await Promise.all([
			MailwomanTokenizer.loadFromFile(
				values["tokenizer"] || dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
			),
			ONNXRunner.create(values["model"] || dataRootPath("models", "quantized", "model-v150-step-40000-int8.onnx")),
		])
		neural = new NeuralAddressClassifier({ tokenizer, runner, labels: modelCard.labels })
		parseOpts = { postcodeRepair: true }
	}

	// --- resolver (shared by both arms) ---
	const { WOFSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
	const backend = new WOFSqlitePlaceLookup({ databasePath: dbPath })
	const resolver = createWOFResolver(backend as never)
	const resolveOpts = dc && dc.toLowerCase() !== "none" ? { defaultCountry: dc } : {}

	// --- localityMatches credit logic (identical to oa-resolver-eval.ts) ---
	const adminDb = new DatabaseSync(dbPath, { readOnly: true })
	const namesStmt = adminDb.prepare("SELECT name FROM names WHERE id = ?")
	const altCache = new Map<number, Set<string>>()
	const altNamesFor = (id: number): Set<string> => {
		let set = altCache.get(id)

		if (!set) {
			set = new Set<string>()

			for (const r of namesStmt.all(id) as { name: string }[]) {
				const n = normName(r.name)

				if (n) {
					set.add(n)
				}
			}
			altCache.set(id, set)
		}

		return set
	}
	const ancestorNamesStmt = adminDb.prepare(
		"SELECT nm.name FROM ancestors a JOIN names nm ON nm.id = a.ancestor_id " +
			"WHERE a.id = ? AND a.ancestor_placetype IN ('county', 'region', 'macrocounty', 'macroregion')"
	)
	const ancestorTokCache = new Map<number, Set<string>>()
	const ancestorTokensFor = (id: number): Set<string> => {
		let set = ancestorTokCache.get(id)

		if (!set) {
			set = new Set<string>()

			for (const r of ancestorNamesStmt.all(id) as { name: string }[]) {
				for (const t of normName(r.name).split(" "))
					if (t.length >= 4) {
						set.add(t)
					}
			}
			ancestorTokCache.set(id, set)
		}

		return set
	}
	const localityMatches = (expected: string | undefined, locNode: Resolved | undefined): boolean => {
		if (!expected || !locNode) return false
		const e = normName(expected)

		if (!e) return false

		if (normName(locNode.name) === e || altNamesFor(locNode.id).has(e)) return true
		const base = normName(locNode.name)

		if (base && e.startsWith(base + " ")) {
			const quals = e
				.slice(base.length + 1)
				.split(" ")
				.filter(Boolean)
			const anc = ancestorTokensFor(locNode.id)

			if (quals.length > 0 && quals.every((q) => q.length >= 3 && [...anc].some((a) => a.startsWith(q)))) return true
		}

		return false
	}

	// --- DB probes for the 3-bucket classification of oracle-still-fails rows ---
	// FTS join key is `wof_id` (UNINDEXED). Find US localities whose canonical name OR alt_names match
	// the gold locality text, then check region-containment via the ancestors chain.
	const ftsStmt = adminDb.prepare(
		`SELECT spr.id AS id, spr.name AS name, spr.placetype AS placetype, spr.latitude AS lat, spr.longitude AS lon
		 FROM place_search JOIN spr ON spr.id = place_search.wof_id
		 WHERE place_search MATCH ? AND spr.country = 'US'
		   AND spr.is_current != 0 AND spr.is_deprecated = 0
		   AND spr.placetype IN ('locality','localadmin','borough')
		 LIMIT 50`
	)
	const regionAncestorStmt = adminDb.prepare("SELECT 1 FROM ancestors WHERE id = ? AND ancestor_id = ? LIMIT 1")
	// Nearest in-region locality/localadmin/borough to a point — backs the COVERAGE vs NAME-MISMATCH
	// split. If a place sits on the gold point within the gold region, the place IS covered (just under
	// a different name = NAME-MISMATCH); if nothing is near, it's a genuine COVERAGE gap. Joined to
	// ancestors so it's scoped to the gold region; ordered by squared planar distance (fine at US
	// latitudes for a ~10 km radius). The bbox pre-filter keeps it cheap.
	const nearestInRegionStmt = adminDb.prepare(
		`SELECT spr.id AS id, spr.name AS name, spr.placetype AS placetype, spr.latitude AS lat, spr.longitude AS lon
		 FROM spr JOIN ancestors a ON a.id = spr.id AND a.ancestor_id = ?
		 WHERE spr.country = 'US' AND spr.is_current != 0 AND spr.is_deprecated = 0
		   AND spr.placetype IN ('locality','localadmin','borough')
		   AND spr.latitude BETWEEN ? AND ? AND spr.longitude BETWEEN ? AND ?
		 ORDER BY (spr.latitude - ?) * (spr.latitude - ?) + (spr.longitude - ?) * (spr.longitude - ?)
		 LIMIT 1`
	)
	const sanitizeFTS = (s: string): string => {
		// Mirror the spirit of sanitizeFTSQuery: quote tokens so punctuation can't break the MATCH.
		const toks = s
			.toLowerCase()
			.replace(/[^a-z0-9\s]+/g, " ")
			.split(/\s+/)
			.filter(Boolean)

		if (toks.length === 0) return ""

		return toks.map((t) => `"${t}"`).join(" ")
	}
	// region abbrev (OA gold) -> WOF region id, resolved once per state via the resolver path.
	const regionIDCache = new Map<string, number | null>()
	const regionIDFor = async (abbrev: string): Promise<number | null> => {
		if (regionIDCache.has(abbrev)) return regionIDCache.get(abbrev)!
		const rNode: AddressNode = {
			tag: "region" as never,
			value: abbrev,
			start: 0,
			end: abbrev.length,
			confidence: 1,
			children: [],
		}
		const out = await resolver.resolveTree({ raw: abbrev, roots: [rNode] }, resolveOpts)
		const reg = collectResolved(out).find((r) => r.placetype === "region")
		const id = reg ? reg.id : null
		regionIDCache.set(abbrev, id)

		return id
	}

	// --- aggregation ---
	interface Agg {
		n: number
		locMatch: number
		resolved: number
		errs: number[]
	}
	const newAgg = (): Agg => ({ n: 0, locMatch: 0, resolved: 0, errs: [] })
	const bump = (a: Agg, loc: boolean, resolved: boolean, err: number | null): void => {
		a.n++

		if (loc) {
			a.locMatch++
		}

		if (resolved) {
			a.resolved++
		}

		if (err !== null) {
			a.errs.push(err)
		}
	}
	// Three arms:
	//   current        = model parse, scored with the production `locality`-strict filter (reproduces oa-resolver-eval).
	//   oracleStrict   = gold locality, scored locality-strict — the ceiling UNDER the current scoring filter.
	//   oracleExpanded = gold locality, scored locality∪localadmin∪borough — the TRUE resolver/gazetteer ceiling.
	const arm = {
		current: { overall: newAgg(), byState: new Map<string, Agg>() },
		oracleStrict: { overall: newAgg(), byState: new Map<string, Agg>() },
		oracleExpanded: { overall: newAgg(), byState: new Map<string, Agg>() },
	}
	type ArmKey = keyof typeof arm
	const recordTo = (which: ArmKey, state: string, loc: boolean, resolved: boolean, err: number | null): void => {
		const m = arm[which].byState

		if (!m.has(state)) {
			m.set(state, newAgg())
		}
		bump(m.get(state)!, loc, resolved, err)
		bump(arm[which].overall, loc, resolved, err)
	}

	// Buckets for oracle-still-fails.
	const buckets = {
		coverage: [] as OracleFail[],
		nameMismatch: [] as OracleFail[],
		ranking: [] as OracleFail[],
		other: [] as OracleFail[],
	}
	interface OracleFail {
		input: string
		state: string
		goldLoc: string
		goldRegion: string
		resolvedLoc: string | null
		resolvedLocID: number | null
		errKm: number | null
		note: string
	}

	// --- build the oracle tree for one row: region(gold) > locality(gold) + postcode(gold) ---
	const buildOracleTree = (row: OaRow): AddressTree => {
		const goldLoc = row.expected.locality ?? ""
		const goldReg = row.expected.region ?? ""
		const goldPc = row.expected.postcode ?? ""
		const roots: AddressNode[] = []
		let cursor = 0
		const mk = (tag: string, value: string): AddressNode => {
			const n: AddressNode = {
				tag: tag as never,
				value,
				start: cursor,
				end: cursor + value.length,
				confidence: 1,
				children: [],
			}
			cursor += value.length + 1

			return n
		}

		// region as PARENT of locality (so the resolver scopes the locality lookup to the region's
		// descendants + inherits its country) — mirrors the western containment the resolver expects.
		if (goldReg) {
			const region = mk("region", goldReg)

			if (goldLoc) {
				const loc = mk("locality", goldLoc)
				region.children.push(loc)
			}
			roots.push(region)
		} else if (goldLoc) {
			roots.push(mk("locality", goldLoc))
		}

		if (goldPc) {
			roots.push(mk("postcode", goldPc))
		}

		return { raw: `${goldLoc} ${goldReg} ${goldPc}`.trim(), roots }
	}

	let i = 0

	for (const row of rows) {
		i++

		if (i % 500 === 0) {
			console.error(`  ${i}/${rows.length}`)
		}
		const state = row.state || "??"

		// --- CURRENT arm: model parse (skipped under --oracle-only) ---
		if (neural) {
			let cResolved: Resolved[] = []

			try {
				const tree = await neural.parse(row.input, parseOpts)
				cResolved = collectResolved(await resolver.resolveTree(tree, resolveOpts))
			} catch {
				/* unresolved */
			}
			const locNode = localityStrict(cResolved)
			const best = mostSpecific(cResolved)
			recordTo(
				"current",
				state,
				localityMatches(row.expected.locality, locNode),
				!!best,
				best ? haversineKm(best.lat, best.lon, row.lat, row.lon) : null
			)
		}

		// --- ORACLE arm: gold locality ---
		let oResolved: Resolved[] = []

		try {
			oResolved = collectResolved(await resolver.resolveTree(buildOracleTree(row), resolveOpts))
		} catch {
			/* unresolved */
		}
		const oBest = mostSpecific(oResolved)
		const oErr = oBest ? haversineKm(oBest.lat, oBest.lon, row.lat, row.lon) : null
		const oLocStrict = localityStrict(oResolved)
		const oLocExpanded = localityExpanded(oResolved)
		const oMatchStrict = localityMatches(row.expected.locality, oLocStrict)
		const oMatchExpanded = localityMatches(row.expected.locality, oLocExpanded)
		recordTo("oracleStrict", state, oMatchStrict, !!oBest, oErr)
		recordTo("oracleExpanded", state, oMatchExpanded, !!oBest, oErr)

		// --- bucket rows where even the EXPANDED oracle fails (the true resolver/gazetteer ceiling miss) ---
		const oLocNode = oLocExpanded

		if (!oMatchExpanded) {
			const goldLoc = row.expected.locality ?? ""
			const goldReg = row.expected.region ?? ""
			const fail: OracleFail = {
				input: row.input,
				state,
				goldLoc,
				goldRegion: goldReg,
				resolvedLoc: oLocNode?.name ?? null,
				resolvedLocID: oLocNode?.id ?? null,
				errKm: oBest ? haversineKm(oBest.lat, oBest.lon, row.lat, row.lon) : null,
				note: "",
			}
			const ftsQ = sanitizeFTS(goldLoc)
			let inRegionByName: { id: number; name: string; lat: number; lon: number } | null = null
			let anyByName = false
			const regionID = await regionIDFor(goldReg)

			if (ftsQ) {
				const cands = ftsStmt.all(ftsQ) as { id: number; name: string; placetype: string; lat: number; lon: number }[]

				for (const c of cands) {
					// require the gold name to actually MATCH this candidate (FTS is fuzzy/prefix-ish).
					const nameHits = normName(c.name) === normName(goldLoc) || altNamesFor(c.id).has(normName(goldLoc))

					if (!nameHits) continue
					anyByName = true

					if (regionID !== null && regionAncestorStmt.get(c.id, regionID)) {
						if (!inRegionByName) {
							inRegionByName = { id: c.id, name: c.name, lat: c.lat, lon: c.lon }
						}
					}
				}
			}
			// Is there ANY in-region place sitting ON the gold point (covered under a different name)?
			// Independent of the resolved node: a small bbox query over in-region localities/localadmins.
			const DEG = 0.18 // ~20 km bbox pre-filter at US latitudes
			let nearest: { id: number; name: string; placetype: string; lat: number; lon: number; km: number } | null = null

			if (regionID !== null) {
				const r = nearestInRegionStmt.get(
					regionID,
					row.lat - DEG,
					row.lat + DEG,
					row.lon - DEG,
					row.lon + DEG,
					row.lat,
					row.lat,
					row.lon,
					row.lon
				) as { id: number; name: string; placetype: string; lat: number; lon: number } | undefined

				if (r) {
					nearest = { ...r, km: haversineKm(r.lat, r.lon, row.lat, row.lon) }
				}
			}
			const NEAR_KM = 12 // a town centroid within this radius of the gold address ⇒ the place IS covered

			// NAME-MISMATCH requires the nearest in-region place to be a plausible NAME VARIANT of the gold —
			// not merely the closest township. Variant ⇔ the gold base (gold minus a trailing civic suffix:
			// City/Town/Township/Twp/Village/Borough) shares ≥1 normalized token with the nearest place's
			// name. This separates the civic-suffix class ('Barre City' → 'Barre', 'Saint Albans Town' →
			// 'St. Albans') from a genuine COVERAGE gap whose nearest neighbor is an unrelated place ('Pennco'
			// / 'Dakota Dunes' → an unrelated township).
			const CIVIC = new Set(["city", "town", "township", "twp", "village", "borough", "vlg", "cdp"])
			const baseToks = (s: string): string[] =>
				normName(s)
					.split(" ")
					.filter((t) => t && !CIVIC.has(t))
			const isNameVariant = (gold: string, cand: string): boolean => {
				const g = new Set(baseToks(gold))

				return baseToks(cand).some((t) => g.has(t))
			}

			if (inRegionByName) {
				// gold name IS present in the gold region (locality/localadmin/borough), but the expanded oracle
				// resolved a DIFFERENT instance (a same-name place elsewhere outranked it) or none — a RANKING miss.
				const what = fail.resolvedLocID === null ? "picked none" : `picked #${fail.resolvedLocID} (${fail.resolvedLoc})`
				fail.note = `gold name in-region as #${inRegionByName.id} (${inRegionByName.name}, ${haversineKm(inRegionByName.lat, inRegionByName.lon, row.lat, row.lon).toFixed(1)}km from gold pt); ${what}`
				buckets.ranking.push(fail)
			} else if (nearest && nearest.km <= NEAR_KM && isNameVariant(goldLoc, nearest.name)) {
				// no exact gold-name in-region, but a NAME-VARIANT in-region place sits on the gold point.
				// (e.g. OA 'Barre City' / 'Essex Junction Village' → WOF 'Barre' / 'Essex Junction' on the point.)
				fail.note = `no exact gold-name in-region; nearest in-region NAME-VARIANT '${nearest.name}' (${nearest.placetype}) @${nearest.km.toFixed(1)}km`
				buckets.nameMismatch.push(fail)
			} else if (!anyByName) {
				fail.note = `gold name '${goldLoc}' has NO US locality/localadmin/borough row; nearest in-region ${nearest ? `'${nearest.name}' @${nearest.km.toFixed(1)}km (not a name variant)` : `none within ${NEAR_KM}km`}`
				buckets.coverage.push(fail)
			} else {
				// gold name exists somewhere in the US but NOT in the gold region, and nothing in-region sits on
				// the point → coverage gap for THIS region.
				fail.note = `gold name exists in US but NOT in region ${goldReg}; nearest in-region ${nearest ? `'${nearest.name}' @${nearest.km.toFixed(1)}km` : "none in bbox"}`
				buckets.coverage.push(fail)
			}
		}
	}

	// ---- report ----
	const pct = (x: number, n: number): string => (n ? `${((100 * x) / n).toFixed(1)}%` : "—")
	const p = (xs: number[], q: number): string => percentile(xs, q)?.toFixed(1) ?? "—"
	const lines: string[] = []
	const N = arm.current.overall.n || arm.oracleExpanded.overall.n
	lines.push(`# OA oracle-locality diagnostic — MODEL vs RESOLVER/GAZETTEER (${N} rows)`)
	lines.push("")
	lines.push(
		`Model (CURRENT): ${values["model"] || "" || "(default v1.5.0 int8)"} | DB: ${dbPath} | default-country: ${dc}`
	)
	lines.push("")
	lines.push(`## Current (model parse) vs Oracle (gold locality) — locality-match`)
	lines.push("")
	lines.push(`- **current** = model parse, scored \`placetype === "locality"\` only (reproduces oa-resolver-eval.ts).`)
	lines.push(
		`- **oracle (strict)** = gold locality span, same \`locality\`-only scoring → ceiling UNDER the current scoring filter.`
	)
	lines.push(
		`- **oracle (expanded)** = gold locality span, scored \`locality∪localadmin∪borough\` (the placetypes the resolver's \`locality\` tag expands to) → the TRUE resolver/gazetteer ceiling.`
	)
	lines.push("")
	lines.push(
		`| scope | n | current loc | oracle strict | oracle EXPANDED | GAP=oracleExp−current | current p50/p90 km | oracle p50/p90 km |`
	)
	lines.push(`|---|--:|--:|--:|--:|--:|--:|--:|`)
	const states = [...new Set([...arm.current.byState.keys(), ...arm.oracleExpanded.byState.keys()])].sort()
	const mkRow = (label: string, c: Agg, os: Agg, oe: Agg): string => {
		const gap = c.n ? ((100 * oe.locMatch) / Math.max(1, oe.n) - (100 * c.locMatch) / c.n).toFixed(1) : "0.0"

		return `| ${label} | ${c.n} | ${pct(c.locMatch, c.n)} | ${pct(os.locMatch, os.n)} | ${pct(oe.locMatch, oe.n)} | +${gap}pp | ${p(c.errs, 50)} / ${p(c.errs, 90)} | ${p(oe.errs, 50)} / ${p(oe.errs, 90)} |`
	}
	lines.push(mkRow("**overall**", arm.current.overall, arm.oracleStrict.overall, arm.oracleExpanded.overall))

	for (const st of states) {
		lines.push(
			mkRow(
				st,
				arm.current.byState.get(st) ?? newAgg(),
				arm.oracleStrict.byState.get(st) ?? newAgg(),
				arm.oracleExpanded.byState.get(st) ?? newAgg()
			)
		)
	}
	lines.push("")
	lines.push(
		`GAP = oracle(expanded) − current = the upper bound on what fixing TAGGING + SCORING could recover. ` +
			`oracle(strict) − current isolates the MODEL's tagging contribution under the CURRENT scoring filter; ` +
			`oracle(expanded) − oracle(strict) is the SCORING artifact (localadmin/borough hits the eval discards). ` +
			`The oracle(expanded) column is the resolver/gazetteer CEILING: best-case locality-match if tagging were perfect.`
	)
	lines.push("")
	const totalFails =
		buckets.coverage.length + buckets.nameMismatch.length + buckets.ranking.length + buckets.other.length
	lines.push(
		`## Expanded-oracle-still-fails: 3-bucket breakdown (${totalFails} rows where even gold locality + expanded scoring STILL missed)`
	)
	lines.push("")
	lines.push(`| bucket | count | % of oracle-fails | % of all rows |`)
	lines.push(`|---|--:|--:|--:|`)
	const bucketRow = (label: string, arr: OracleFail[]): string =>
		`| ${label} | ${arr.length} | ${pct(arr.length, totalFails)} | ${pct(arr.length, N)} |`
	lines.push(bucketRow("COVERAGE (no in-region place on the gold point)", buckets.coverage))
	lines.push(bucketRow("NAME-MISMATCH (in-region place on the point, different name)", buckets.nameMismatch))
	lines.push(bucketRow("RANKING (gold name in-region but wrong/no instance picked)", buckets.ranking))
	lines.push(bucketRow("other / unclassified", buckets.other))
	lines.push("")
	// Per-state bucket split (focus SD/VT).
	const stateOfBucket = (arr: OracleFail[]): Record<string, number> => {
		const m: Record<string, number> = {}

		for (const f of arr) {
			m[f.state] = (m[f.state] ?? 0) + 1
		}

		return m
	}
	lines.push(`### Bucket counts by state`)
	lines.push("")
	lines.push(`| state | coverage | name-mismatch | ranking | other |`)
	lines.push(`|---|--:|--:|--:|--:|`)
	const cov = stateOfBucket(buckets.coverage)
	const nm = stateOfBucket(buckets.nameMismatch)
	const rk = stateOfBucket(buckets.ranking)
	const ot = stateOfBucket(buckets.other)

	for (const st of states) {
		lines.push(`| ${st} | ${cov[st] ?? 0} | ${nm[st] ?? 0} | ${rk[st] ?? 0} | ${ot[st] ?? 0} |`)
	}
	lines.push("")
	const examples = (label: string, arr: OracleFail[], k = 5): void => {
		lines.push(`### ${label} — examples (${Math.min(k, arr.length)} of ${arr.length})`)
		lines.push("")

		for (const f of arr.slice(0, k)) {
			lines.push(`- [${f.state}] gold loc **${f.goldLoc}** (${f.goldRegion}) — ${f.note}`)
			lines.push(`  - input: \`${f.input}\``)
		}
		lines.push("")
	}
	examples("COVERAGE", buckets.coverage)
	examples("NAME-MISMATCH", buckets.nameMismatch)
	examples("RANKING", buckets.ranking)

	if (buckets.other.length > 0) {
		examples("OTHER", buckets.other)
	}

	const report = lines.join("\n")
	console.log(report)

	if (values["out-md"] || "") {
		writeFileSync(values["out-md"] || "", report + "\n")
		console.error(`wrote markdown → ${values["out-md"] || ""}`)
	}

	if (values["examples-json"] || "") {
		writeFileSync(
			values["examples-json"] || "",
			JSON.stringify(
				{
					coverage: buckets.coverage,
					nameMismatch: buckets.nameMismatch,
					ranking: buckets.ranking,
					other: buckets.other,
				},
				null,
				2
			)
		)
		console.error(`wrote examples → ${values["examples-json"] || ""}`)
	}
}

runIfScript(main)
