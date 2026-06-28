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
 *   `--postcode-anchor` adds a `neural+anchor` row: neural's admin match, but the COORDINATE taken
 *   from the postcode anchor's own centroid (`@mailwoman/neural/postcode-anchor` over the
 *   postalcode shards, `--postcode-shards`). On German this drops coord p50 9.9 km → 1.2 km (p99
 *   318 → 11 km) with admin match unchanged — the postcode tier between admin-centroid and
 *   street-level.
 *
 *   Run: node --experimental-strip-types scripts/eval/oa-resolver-eval.ts\
 *   --eval data/eval/external/openaddresses-us-sample.jsonl --limit 2000\
 *   --model /tmp/v072-eval/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card /tmp/v072-eval/model-card.json
 *
 *   `--wof` defaults to `admin-global-priority.db,postcode-locality-intl.db` — coordinate-first
 *   locality resolution is ON by default (no-op where the candidate table has no rows, e.g. US).
 *   Pass `--wof <admin.db>` alone for the admin-only baseline, or append a postcode shard
 *   (postalcode-*.db) to also resolve the postcode node.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { lookupGermanState } from "@mailwoman/codex/de"
import { lookupFrenchRegion } from "@mailwoman/codex/fr"
import { COARSE_CLASSES } from "@mailwoman/core/coarse-placer"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath, mailwomanDataRoot } from "@mailwoman/core/utils"
import { createWofResolver, expandPlacetypeFilter } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import {
	type ClassificationRecord,
	createAddressParser,
	createRuntimePipeline,
	loadDefaultPlaceCountry,
} from "mailwoman"

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
/** Pull the #476 address-point hit (street-node metadata) out of a resolved tree, if any. */
function findAddressPointHit(tree: AddressTree): { lat: number; lon: number } | null {
	const stack = [...tree.roots]

	while (stack.length > 0) {
		const n = stack.pop()!
		const ap = n.metadata?.address_point as { lat: number; lon: number } | undefined

		if (n.tag === "street" && ap) return ap
		stack.push(...n.children)
	}

	return null
}

/** Pull the #483 interpolated estimate (street-node metadata) out of a resolved tree, if any. */
function findInterpolatedHit(tree: AddressTree): { lat: number; lon: number } | null {
	const stack = [...tree.roots]

	while (stack.length > 0) {
		const n = stack.pop()!
		const ip = n.metadata?.interpolated_point as { lat: number; lon: number } | undefined

		if (n.tag === "street" && ip) return ip
		stack.push(...n.children)
	}

	return null
}

function collectResolved(tree: AddressTree): Resolved[] {
	const out: Resolved[] = []
	const visit = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined

		if (n.placeId?.startsWith("wof:") && n.lat !== undefined && n.lon !== undefined) {
			const placetype = String(n.sourceId ?? "").split(":")[0] ?? ""
			const name = String(meta?.["resolver_name"] ?? n.value ?? "")
			out.push({ id: Number(n.placeId.slice(4)), name, placetype, lat: n.lat, lon: n.lon })
		}

		// Multi-role completion (#415/#416): a dual-role region carries extra roles (e.g. `locality`) as
		// INTERPRETATIONS on the same node, not separate children. Surface each resolved interpretation as
		// its own Resolved so the eval finds the completed locality (placetype/coord/name come from the
		// interpretation).
		for (const interp of (n.interpretations ?? []) as ReadonlyArray<{
			tag: string
			placeId?: string
			sourceId?: string
			lat?: number
			lon?: number
			metadata?: Record<string, unknown>
		}>) {
			if (interp.placeId?.startsWith("wof:") && interp.lat !== undefined && interp.lon !== undefined) {
				const placetype = String(interp.sourceId ?? interp.tag).split(":")[0] ?? ""
				const name = String(interp.metadata?.["resolver_name"] ?? n.value ?? "")
				out.push({ id: Number(interp.placeId.slice(4)), name, placetype, lat: interp.lat, lon: interp.lon })
			}
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

const norm = (s: string | undefined): string => (s ?? "").toLowerCase().trim()

/**
 * Aggressive name normalization for gazetteer-alias locality matching. Lowercases, strips diacritics + punctuation,
 * expands the universal US place abbreviations (St→Saint, Mt→Mount, Ft→Fort, Ste→Sainte), and de-spaces "Mc X" → "McX".
 * Deliberately does NOT strip civic suffixes (City/Town/Township/Village): in New England "Barre City" and "Barre Town"
 * are DISTINCT municipalities, so collapsing them would over-credit genuine wrong-place misses. Pair with the WOF
 * altname set (a place's own recorded variants) rather than loosening here.
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

	return toks
		.join(" ")
		.replace(/\bmc (\w)/g, "mc$1")
		.replace(/\s+/g, " ")
		.trim()
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

/**
 * True if the resolved region matches the expected one, comparing like-for-like across the surface forms each side
 * uses. Three paths, tried in order:
 *
 * 1. Verbatim — both already the same string (US `Berlin`==`Berlin`, or two identical abbrevs).
 * 2. US — the resolver returns a state's CANONICAL full name (`California`) while OA's expected is the USPS abbrev (`CA`);
 *    map full name → abbrev so they compare.
 * 3. DE — the resolver returns WOF's ENGLISH exonym (`Saxony`) while OA's expected is the German name (`Sachsen`);
 *    `lookupGermanState` folds code / German name / English name → one ISO 3166-2:DE code on BOTH sides. Strict:
 *    distinct states (Bavaria vs Saxony) still miss, so this corrects the cross-language mismatch without loosening a
 *    genuine wrong-region.
 * 4. FR — `lookupFrenchRegion` folds an ISO 3166-2:FR code or a région name (accents optional) to one code on both sides,
 *    the same diacritic-insensitive fix for `Île-de-France` vs `Ile-de-France`.
 *
 * The code spaces don't overlap on real inputs (a USPS abbrev is never a German or French region name, and the
 * German/French names are disjoint), so trying all of them is safe regardless of the row's country.
 */
function regionMatches(resolvedName: string | undefined, expected: string | undefined): boolean {
	if (!resolvedName || !expected) return false
	const exp = norm(expected)
	const got = norm(resolvedName)

	if (got === exp) return true

	if (STATE_NAME_TO_ABBR[got]?.toLowerCase() === exp) return true
	const gotDe = lookupGermanState(resolvedName)

	if (gotDe !== null && gotDe === lookupGermanState(expected)) return true
	const gotFr = lookupFrenchRegion(resolvedName)

	return gotFr !== null && gotFr === lookupFrenchRegion(expected)
}

function percentile(xs: number[], p: number): number | null {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)

	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

async function main(): Promise<void> {
	const evalPath = arg("eval", "data/eval/external/openaddresses-us-sample.jsonl")
	const limit = Number(arg("limit", "0")) || Infinity
	// Default attaches the coordinate-first candidate shard (postcode-locality-intl.db) alongside the
	// admin gazetteer, so locality resolution is coordinate-first by default for the locales it covers
	// (DE/FR/GB/NL functional). It no-ops where the table has no rows (e.g. US), so US stays unchanged.
	// Override `--wof` to measure the admin-only baseline.
	const wofPaths = arg(
		"wof",
		`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
	)
		.split(",")
		.map((s) => s.trim())

	const rows: OaRow[] = readFileSync(evalPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.slice(0, limit === Infinity ? undefined : limit)

	// Full SHIP-CONFIG via the canonical ProductionScorer (#722): createScorer reads the model-card's
	// `requires` block and feeds EVERY declared channel — anchor + gazetteer + conventions(=auto) +
	// suppress-gaz-near-postcode — and fails closed (strict) if a declared channel can't be fed. This
	// grades the parse the library + server actually ship, not the hand-built anchor-only classifier
	// this eval used before. `--model-anchor-lookup` still pins the anchor source (else createScorer's
	// default /mnt pilot + the repo gazetteer lexicon). `--ablate-to-anchor` drops back to anchor-only
	// (gazetteer + conventions OFF) for the #722 before/after comparison.
	const { createScorer } = await import("@mailwoman/neural/scorer")
	const modelAnchorPath = arg("model-anchor-lookup", "")
	const ablateToAnchor = process.argv.includes("--ablate-to-anchor")
	const neural = await createScorer({
		modelPath: arg("model"),
		tokenizerPath: arg("tokenizer"),
		modelCardPath: arg("model-card"),
		...(modelAnchorPath ? { anchorLookupPath: modelAnchorPath } : {}),
		strict: true,
		tier: "server",
		...(ablateToAnchor ? { overrides: { gazetteer: false, conventions: false } } : {}),
	})
	console.error(
		ablateToAnchor
			? "[scorer] ABLATED to anchor-only (gazetteer + conventions OFF) — #722 before/after baseline"
			: "[scorer] full ship-config via createScorer (anchor + gazetteer + conventions=auto + suppress)"
	)

	// v0 = our TypeScript port of the Pelias parser. Scoring it through the same resolver makes this a
	// real "neural vs Pelias parser" head-to-head on non-circular addresses.
	const v0 = createAddressParser()

	// `--candidate-db <candidate.db>` swaps the FTS backend for the byte-range candidate-table lookup
	// (the SAME backend + ranking the browser demo uses). This is the "CLI matches demo" gate: run the
	// eval both ways and confirm US locality/coord don't regress before defaulting the CLI to it.
	const candidateDb = arg("candidate-db", "")
	// `--postal-city-alias-db <db>` (#475) attaches the opt-in postal-city alias scorer on the FTS
	// path: a user-typed postal city resolves to its geographic locality. Run the eval with and
	// without to measure the lift. No-op on the candidate backend (it folds aliases at build time).
	const postalCityAliasDb = arg("postal-city-alias-db", "")
	const { WofSqlitePlaceLookup, WofCandidateTableLookup, WofPostalCityAliasLookup } =
		await import("@mailwoman/resolver-wof-sqlite")
	const postalCityAliases = postalCityAliasDb
		? new WofPostalCityAliasLookup({ databasePath: postalCityAliasDb })
		: undefined
	const backend = candidateDb
		? new WofCandidateTableLookup({ databasePath: candidateDb })
		: new WofSqlitePlaceLookup({
				databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths,
				postalCityAliases,
			})

	if (candidateDb) console.error(`[backend] candidate-table lookup over ${candidateDb} (demo-parity ranking)`)

	if (postalCityAliases) console.error(`[backend] postal-city alias scorer enabled (#475): ${postalCityAliasDb}`)
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
	// Hierarchy-aware regional-qualifier credit (#386). OpenAddresses tags many German localities with
	// a disambiguating district suffix WOF's canonical name drops — gold `Plauen Vogtl`/`Chemnitz Sachs`
	// resolve to `Plauen`/`Chemnitz` (the point lands inside; PIP confirms it), but a bare string compare
	// reads a miss. Rather than a hardcoded suffix blacklist (a provenance-first violation), credit
	// the qualifier ONLY when it matches the resolved place's OWN WOF ancestry: `Vogtl`→county `Vogtland`,
	// `Sachs`→region `Sachsen`. List-free and non-gameable — a genuinely wrong place won't carry the
	// gold's qualifier among its ancestors. `und`/non-latin ancestor names normalize to empty under
	// normName (Cyrillic/CJK are stripped), so the token set is latin-only without a language filter.
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
				for (const t of normName(r.name).split(" ")) if (t.length >= 4) set.add(t)
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
		// Near-miss: gold `<resolved name> <qualifier…>`. Credit only when EVERY trailing qualifier is an
		// abbreviation-prefix (≥3 chars) of one of the resolved place's ancestor-name tokens. The base
		// must equal the resolved name exactly, so this can only ADD credit to an already-correct place.
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

	// #690: --normalize-case title-cases all-caps input before the model (detection-gated). Off by default.
	const normalizeCase = process.argv.includes("--normalize-case")
	const parseOpts = { postcodeRepair: true, ...(normalizeCase ? { normalizeCase: true } : {}) } as Parameters<
		typeof neural.parse
	>[1]
	// `defaultCountry` is the hard country filter applied to admin lookups when the parse carries no
	// resolved country node. It MUST match the dataset's locale — hardcoding "US" silently filters a
	// non-US eval to US places (a German "Berlin" then loses to a tiny US Berlin). Settable via
	// `--default-country <ISO|none>`; `none` disables the filter so ranking alone decides.
	const dc = arg("default-country", "US")
	// `--hierarchy-completion` (#405, generalizes #387's `--city-state-fallback`): recover the locality
	// the parser drops for a DUAL-ROLE place (city-state or capital-seat province), via the precomputed
	// coincident-roles relation (#403). Opt-in, default-off → by default this eval is byte-identical;
	// pass it to measure the before/after. Applied to BOTH the neural and rules resolve paths (they
	// share `resolveOpts`), so the comparison stays fair. `--city-state-fallback` kept as an alias.
	const hierarchyCompletion =
		process.argv.includes("--hierarchy-completion") || process.argv.includes("--city-state-fallback")
	const resolveOpts = {
		...(dc && dc.toLowerCase() !== "none" ? { defaultCountry: dc } : {}),
		...(hierarchyCompletion ? { hierarchyCompletion: true } : {}),
	}

	// Postcode-anchor fusion (opt-in via `--postcode-anchor`). The resolver supplies the admin/place
	// identity, but its coordinate is the place CENTROID — legitimately tens of km from edge addresses.
	// The postcode anchor supplies the postcode's OWN centroid, the finer tier between admin-centroid and
	// street. The `neural+anchor` row keeps neural's admin match but takes the COORDINATE from the anchor
	// when it has a placed candidate for the eval's country, else falls back to the resolver coord. So the
	// row isolates exactly what the anchor sharpens: where, not which place.
	// `--address-points <db>` (#476): the street-level exact-point tier. Adds `addressPoints` to
	// resolveOpts; the `neural+addrpt` row keeps neural's admin flags but takes the COORDINATE from
	// the address-point hit when present (the tier's whole contribution is "where", street-level).
	const addressPointsDb = arg("address-points", "")
	let addressPoints: import("@mailwoman/resolver").AddressPointLookup | null = null

	if (addressPointsDb) {
		const { AddressPointSqliteLookup } = await import("@mailwoman/resolver-wof-sqlite")
		addressPoints = new AddressPointSqliteLookup(addressPointsDb)
	}
	// `--interpolation <segments-db>` (#483): the house-number interpolation tier (StreetInterpolator,
	// tiger-range). Adds `interpolation` to resolveOpts; the `neural+interp` row takes the COORDINATE
	// from the exact point when present, else the interpolated estimate, else the admin centroid — the
	// full street-level coordinate cascade. The delta vs `neural+addrpt` is interpolation's lift on the
	// long tail of valid-but-unlisted numbers the exact tier misses.
	const interpolationDb = arg("interpolation", "")
	let interpolation: import("@mailwoman/resolver").InterpolationLookup | null = null

	if (interpolationDb) {
		const { StreetInterpolator } = await import("@mailwoman/resolver-wof-sqlite")
		interpolation = new StreetInterpolator({ dbPath: interpolationDb })
	}
	// `--cascade` (#718 situs-eval): grade the PRODUCTION coordinate path (mailwoman/geocode-core.ts) —
	// per-row, per-state situs + interpolation shards via ShardProvider — so the eval reports the SHIPPED
	// coordinate (address_point > interpolated > admin) across ALL states, not the admin centroid the
	// neural headline alone reports. The diagnostic that motivated this: the headline read 3.3 km p50 /
	// 10 km p90 (admin centroid) while the production cascade over the same rows is ~0 m p50 / 1 km p90,
	// 85.9% within 100 m — the eval simply wasn't grading what ships. The single-state
	// --address-points/--interpolation flags still work for a one-state run; --cascade supersedes them
	// with multi-state per-row selection. --data-root locates the shards (<root>/address-points/,
	// <root>/interpolation/).
	const cascadeOn = process.argv.includes("--cascade")
	const dataRoot = arg("data-root", mailwomanDataRoot())
	let cascadeProvider: import("mailwoman/geocode-core").ShardProvider | null = null

	if (cascadeOn) {
		const { ShardProvider } = await import("mailwoman/geocode-core")
		const { AddressPointSqliteLookup, StreetInterpolator } = await import("@mailwoman/resolver-wof-sqlite")
		cascadeProvider = new ShardProvider({ AddressPointSqliteLookup, StreetInterpolator }, dataRoot)
	}
	// The addrpt + interp arms run when EITHER a single-state shard was given OR --cascade is on.
	const runAddrPt = !!addressPoints || cascadeOn
	const runInterp = !!interpolation || cascadeOn
	const useAnchor = process.argv.includes("--postcode-anchor")
	// `--anchor-rerank` (#369 S8): feed the postcode anchor's country posterior into the resolver's
	// locality re-rank (`ResolveOpts.anchorPosterior`), to measure whether the merged re-ranker pulls
	// resolves into the right country's polygon when no locale gate is set (`--default-country none`).
	const anchorRerank = process.argv.includes("--anchor-rerank")
	let postcodeLookup: {
		lookup(pc: string): Array<{ country: string; lat: number; lon: number }>
		close(): void
	} | null = null
	let extractAnchors: typeof import("@mailwoman/neural/postcode-anchor").extractPostcodeAnchors | null = null

	if (useAnchor || anchorRerank) {
		const shards = arg(
			"postcode-shards",
			`${dataRootPath("wof", "postalcode-us.db")},${dataRootPath("wof", "postalcode-intl.db")}`
		)
			.split(",")
			.map((s) => s.trim())
		const { WofPostcodeLookup } = await import("@mailwoman/resolver-wof-sqlite")
		postcodeLookup = new WofPostcodeLookup(shards)
		extractAnchors = (await import("@mailwoman/neural/postcode-anchor")).extractPostcodeAnchors
	}
	// Minimum anchor confidence to trust the anchor's coordinate over the resolver's. A penalized
	// house-number span scores ~0.2 (single-country × house-number penalty); a genuinely ambiguous
	// real code scores ≥0.52 (valid in ≤3 countries). The 0.5 floor keeps the latter and rejects the
	// former, so a span the position prior flags as a house number falls back to the resolver coordinate
	// (the right city centroid) instead of placing the address at a far-away same-shaped ZIP.
	const anchorMinConf = Number(arg("anchor-min-conf", "0.5"))
	/** The postcode anchor's centroid for a raw address, preferring the eval's country (`dc`). */
	const anchorCoordFor = (input: string): { lat: number; lon: number } | null => {
		if (!postcodeLookup || !extractAnchors) return null
		const prefer = (dc && dc.toLowerCase() !== "none" ? dc : "").toUpperCase()
		// Pick the placed span with the HIGHEST position-aware confidence, above the trust floor. The
		// anchor down-weights a digit-only code that shares its segment with a street word (`12345 Main
		// St` reads as a house number, not a postcode), so a real trailing postcode (`… City, ST 90210`)
		// out-ranks an earlier house number on its own merit — no "take the last span" crutch needed.
		// Ties break toward the later span (the postcode trails the locality in a rendered address).
		let best: { lat: number; lon: number; conf: number; start: number } | null = null

		for (const a of extractAnchors(input, postcodeLookup)) {
			if (a.confidence < anchorMinConf) continue
			const placed = a.candidates.filter((c) => c.lat !== 0 || c.lon !== 0)

			if (placed.length === 0) continue
			// When the eval fixes a country, accept ONLY a placed candidate from it — never fall back to
			// another country's centroid (a US ZIP that is coordless here but a valid 5-digit shape in
			// DE/FR/IT must not borrow Europe's point). With no country fixed, take the first placed.
			const pick = prefer ? placed.find((c) => c.country.toUpperCase() === prefer) : placed[0]

			if (!pick) continue

			if (!best || a.confidence > best.conf || (a.confidence === best.conf && a.span.start >= best.start)) {
				best = { lat: pick.lat, lon: pick.lon, conf: a.confidence, start: a.span.start }
			}
		}

		return best ? { lat: best.lat, lon: best.lon } : null
	}

	/**
	 * The postcode anchor's country posterior for a raw address (highest-confidence placed anchor), fed into the
	 * resolver's locality re-rank via `ResolveOpts.anchorPosterior` (#369 S8).
	 */
	const anchorPosteriorFor = (input: string): Record<string, number> | undefined => {
		if (!postcodeLookup || !extractAnchors) return undefined
		let best: { posterior: Record<string, number>; conf: number } | null = null

		for (const a of extractAnchors(input, postcodeLookup)) {
			if (a.candidates.length === 0) continue

			if (!best || a.confidence > best.conf) best = { posterior: a.posterior, conf: a.confidence }
		}

		return best?.posterior
	}

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
		resolvedLocId?: number
		resolvedReg?: string
	} => {
		const best = mostSpecific(resolved)
		// Admin-match is by NAME (OA carries no WOF id): a row matches if OA's expected locality
		// equals the resolved place's canonical name OR any of its WOF altnames (see
		// localityMatches); region is name-or-abbrev tolerant.
		// Credit the placetypes the resolver's `locality` tag actually expands to — locality ∪ borough ∪
		// localadmin (New England civil "towns" are `localadmin` in WOF, not `locality`). Mirrors the
		// resolver's PLACETYPE_FILTER_GROUPS.locality so this metric counts exactly what the resolver
		// treats as a locality; the old bare `=== "locality"` filter silently discarded correct localadmin
		// hits and under-reported rural US locality-match by tens of points (#375 oracle-locality diagnostic).
		const locNode =
			resolved.find((r) => r.placetype === "locality") ??
			resolved.find((r) => expandPlacetypeFilter(["locality"]).includes(r.placetype))
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
			resolvedLocId: locNode?.id,
			resolvedReg: regResolved?.name,
		}
	}

	// Two parsers, each with its own overall + per-state aggregates.
	const agg = {
		neural: { overall: newAgg(), byState: new Map<string, Agg>() },
		v0: { overall: newAgg(), byState: new Map<string, Agg>() },
	}
	// `neural+anchor`: neural's admin flags, but the coordinate replaced by the postcode-anchor centroid
	// when available. Only the coord error column differs from `neural`.
	const neuralAnchorAgg = { overall: newAgg(), byState: new Map<string, Agg>() }
	const neuralAddrPtAgg = { overall: newAgg(), byState: new Map<string, Agg>() }
	let addressPointHits = 0
	const neuralInterpAgg = { overall: newAgg(), byState: new Map<string, Agg>() }
	let interpHits = 0
	const diagInterp = process.env.MAILWOMAN_DIAG_INTERP === "1"
	let interpPrecond = 0 // rows that parsed street+house_number+postcode (interp's precondition)
	let interpFullParseMiss = 0 // precond met + exact missed + interp null = genuine find() miss
	const diagMisses: string[] = []

	// #478 inc 3 leg 2 — the ASSEMBLED arms. Route each row through `createRuntimePipeline` using the
	// SAME neural classifier (postcodeRepair on, for comparability with the neural arm) and the SAME
	// resolver — without (`assembled`) and with (`assembled+arb`) per-component arbitration. The
	// street+house_number precondition (the thing #566 broke) is counted per arm so a regression is
	// visible directly.
	//
	// placeCountry default is OFF here (`false`) so the assembled arm isolates arbitration from the
	// #244 coarse prior. But the SHIPPED `createRuntimePipeline`/`geocodeAddress` default IS the
	// bundled placer (on, open-set @ 0.9). `--place-country` flips this eval to the production-
	// representative config — load the same bundled placer and feed it to the pipeline — which is the
	// #743 EU country-constraint integrity fix: without it the assembled EU coords are not what a real
	// caller sees (ambiguous EU names without a country constraint land off-continent).
	const runAssembled = process.argv.includes("--assembled")
	// `--place-country-hard` (#194/#743) promotes a CONFIDENT placer guess to a HARD country filter
	// (empty→unresolved) — the lever for the low-pop EU tail the soft prior can't move. Production-
	// representative: gated by the built-in coverage safelist (only well-covered countries hard-filter).
	// `--place-country-hard-all` measures UNGATED (every confident country hard-filters, via a safelist
	// override of the full in-map set) — how per-country hard-resolve-rates are measured to GROW the
	// safelist. Both imply the placer is loaded.
	const useHardCountryAll = process.argv.includes("--place-country-hard-all")
	const useHardCountry = process.argv.includes("--place-country-hard") || useHardCountryAll
	const usePlaceCountry = process.argv.includes("--place-country") || useHardCountry
	const evalPlacer = runAssembled && usePlaceCountry ? await loadDefaultPlaceCountry() : null

	if (usePlaceCountry && !evalPlacer) {
		console.warn("--place-country requested but the bundled coarse-placer failed to load; running placeCountry OFF.")
	}
	const assembledAgg = { overall: newAgg(), byState: new Map<string, Agg>() }
	const assembledArbAgg = { overall: newAgg(), byState: new Map<string, Agg>() }
	let neuralPrecond = 0
	let asmPrecond = 0
	let arbPrecond = 0
	const hasStreetHN = (tree: AddressTree | null): boolean => {
		if (!tree) return false
		let street = false
		let hn = false
		const visit = (n: AddressNode): void => {
			if (n.tag === "street") street = true

			if (n.tag === "house_number") hn = true

			for (const c of n.children) visit(c)
		}

		for (const r of tree.roots) visit(r)

		return street && hn
	}
	const assembledPipeline = runAssembled
		? createRuntimePipeline({
				classifier: {
					parse: (text: string, o?: object) => neural.parse(text, { ...o, postcodeRepair: true }),
				} as never,
				resolver: resolver as never,
				placeCountry: evalPlacer ?? false,
				hardPlaceCountry: useHardCountry && !!evalPlacer,
				// `--place-country-hard-all` overrides the production coverage safelist with the full in-map
				// set, so EVERY confident country hard-filters (ungated measurement). Plain `--place-country-hard`
				// leaves it undefined → the built-in safelist (production-representative).
				...(useHardCountryAll
					? { hardCountrySafelist: new Set(COARSE_CLASSES.filter((c) => c !== "OTHER")) as ReadonlySet<string> }
					: {}),
			})
		: null

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

	// `--out-resolved <path>`: per-row dump for the PIP-containment metric (scripts/eval/pip-containment.py).
	// Carries the gold OA point + the neural-resolved locality's WOF id, so an offline pass can test
	// whether the gold point lies INSIDE the resolved locality's polygon — a name-surface-independent
	// truth check (the "Plauen" vs gold "Plauen Vogtl" name-match artifact, see the coordinate-first plan).
	const collectResolvedDump = !!arg("out-resolved")
	const resolvedRows: Record<string, unknown>[] = []

	// `--out-rows <path>`: per-row neural-vs-v0 outcome dump (EVERY row, not just misses), for the
	// per-address-type head-to-head (scripts/eval/per-type-report.ts buckets by input shape offline).
	// Reuses the same scoreTree the aggregates use — no extra inference, no scoring duplication.
	const collectRows = !!arg("out-rows")
	const outRows: Record<string, unknown>[] = []

	let i = 0

	for (const row of rows) {
		i++

		if (i % 500 === 0) console.error(`  ${i}/${rows.length}`)

		// onnxruntime-node accumulates native tensor memory across runs faster than JS GC reclaims it
		// (~380-parse SIGKILL on the lab box — it crashed the promotion-gate's de-order step tonight).
		// Periodic forced GC reclaims it; run with `node --expose-gc`. No-op without the flag. (#787 pattern.)
		if (i % 50 === 0) (globalThis as { gc?: () => void }).gc?.()

		// --cascade: per-row per-state shards (the production geocode cascade); falls back to the
		// single-state --address-points/--interpolation when --cascade is off (byte-stable default).
		const rowShards = cascadeProvider ? cascadeProvider.for((row.state || "").toLowerCase() || null) : null
		const rowAddrPoints = rowShards?.addressPoints ?? addressPoints ?? null
		const rowInterp = rowShards?.interpolation ?? interpolation ?? null
		// Shared resolve opts (hoisted so the assembled arms below resolve identically to neural).
		const nOpts = {
			...(anchorRerank ? { ...resolveOpts, anchorPosterior: anchorPosteriorFor(row.input) } : resolveOpts),
			...(rowAddrPoints ? { addressPoints: rowAddrPoints } : {}),
			...(rowInterp ? { interpolation: rowInterp } : {}),
		}

		// neural
		let nResolved: Resolved[] = []
		let nDecorated: AddressTree | null = null

		try {
			const nTree = await neural.parse(row.input, parseOpts)
			nDecorated = await resolver.resolveTree(nTree, nOpts)
			nResolved = collectResolved(nDecorated)
		} catch {
			/* unresolved */
		}
		const ns = scoreTree(row, nResolved)
		record("neural", row, ns)

		if (runAssembled && hasStreetHN(nDecorated)) neuralPrecond++

		if (collectResolvedDump) {
			resolvedRows.push({
				input: row.input,
				lat: row.lat,
				lon: row.lon,
				state: row.state,
				expectedLoc: row.expected.locality,
				neuralLocId: ns.resolvedLocId ?? null,
				neuralLoc: ns.resolvedLoc ?? null,
				nameMatch: ns.locMatch,
			})
		}

		// neural + address-points (#476): same admin flags; coordinate from the exact point on hit.
		if (runAddrPt) {
			const hit = nDecorated ? findAddressPointHit(nDecorated) : null
			const apErr = hit ? haversineKm(hit.lat, hit.lon, row.lat, row.lon) : ns.err

			if (hit) addressPointHits++
			const st = row.state || "??"

			if (!neuralAddrPtAgg.byState.has(st)) neuralAddrPtAgg.byState.set(st, newAgg())
			bump(neuralAddrPtAgg.byState.get(st)!, ns.locMatch, ns.regMatch, ns.resolved, apErr)
			bump(neuralAddrPtAgg.overall, ns.locMatch, ns.regMatch, ns.resolved, apErr)
		}

		// neural + interpolation (#483): the full street-level cascade — exact point if present, else the
		// interpolated estimate, else the admin centroid. Same admin flags; only the COORDINATE changes.
		if (runInterp) {
			const exact = nDecorated ? findAddressPointHit(nDecorated) : null
			const interp = nDecorated ? findInterpolatedHit(nDecorated) : null
			const coord = exact ?? interp
			const ipErr = coord ? haversineKm(coord.lat, coord.lon, row.lat, row.lon) : ns.err

			if (interp) interpHits++
			const st = row.state || "??"

			if (!neuralInterpAgg.byState.has(st)) neuralInterpAgg.byState.set(st, newAgg())
			bump(neuralInterpAgg.byState.get(st)!, ns.locMatch, ns.regMatch, ns.resolved, ipErr)
			bump(neuralInterpAgg.overall, ns.locMatch, ns.regMatch, ns.resolved, ipErr)

			// --- coverage diagnostic (MAILWOMAN_DIAG_INTERP=1): split the miss cause. ---
			// The interp tier only runs in resolveTree when the exact tier did NOT stamp. So:
			//   precond met (street+house_number+postcode parsed) + exact miss + interp null
			//   ⟹ a genuine StreetInterpolator.find() miss (shard/normalization gap, NOT parse, NOT gate).
			if (diagInterp && nDecorated) {
				let s: string | undefined
				let hn: string | undefined
				let pc: string | undefined
				const stk = [...nDecorated.roots]

				while (stk.length > 0) {
					const n = stk.pop()!

					if (n.tag === "street" && !s && n.value.trim()) s = n.value.trim()

					if (n.tag === "house_number" && !hn && n.value.trim()) hn = n.value.trim()

					if (n.tag === "postcode" && !pc && n.value.trim()) pc = n.value.trim()
					stk.push(...n.children)
				}
				const precond = !!(s && hn && pc)

				if (precond) interpPrecond++

				if (precond && !exact && !interp) {
					interpFullParseMiss++

					if (diagMisses.length < 5000) diagMisses.push(`${hn} | ${s} | ${pc}  ←  ${row.input}`)
				}
			}
		}

		// neural + postcode-anchor: same admin flags, coordinate from the anchor centroid when it has one.
		if (useAnchor) {
			const ac = anchorCoordFor(row.input)
			const fusedErr = ac ? haversineKm(ac.lat, ac.lon, row.lat, row.lon) : ns.err
			const st = row.state || "??"

			if (!neuralAnchorAgg.byState.has(st)) neuralAnchorAgg.byState.set(st, newAgg())
			bump(neuralAnchorAgg.byState.get(st)!, ns.locMatch, ns.regMatch, ns.resolved, fusedErr)
			bump(neuralAnchorAgg.overall, ns.locMatch, ns.regMatch, ns.resolved, fusedErr)
		}

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

		if (collectRows) {
			outRows.push({
				input: row.input,
				expected: row.expected,
				neural: { loc: ns.locMatch, reg: ns.regMatch, resolved: ns.resolved, err: ns.err },
				v0: { loc: vs.locMatch, reg: vs.regMatch, resolved: vs.resolved, err: vs.err },
			})
		}

		// #478 inc 3 leg 2: assembled (no-arb) + assembled+arb, through the same resolver + nOpts.
		if (assembledPipeline) {
			const st = row.state || "??"

			try {
				const { tree } = await assembledPipeline(row.input, { resolveOpts: nOpts })
				const s = scoreTree(row, collectResolved(tree))

				if (!assembledAgg.byState.has(st)) assembledAgg.byState.set(st, newAgg())
				bump(assembledAgg.byState.get(st)!, s.locMatch, s.regMatch, s.resolved, s.err)
				bump(assembledAgg.overall, s.locMatch, s.regMatch, s.resolved, s.err)

				if (hasStreetHN(tree)) asmPrecond++
			} catch {
				/* unresolved */
			}

			try {
				const { tree } = await assembledPipeline(row.input, { arbitrate: true, resolveOpts: nOpts })
				const s = scoreTree(row, collectResolved(tree))

				if (!assembledArbAgg.byState.has(st)) assembledArbAgg.byState.set(st, newAgg())
				bump(assembledArbAgg.byState.get(st)!, s.locMatch, s.regMatch, s.resolved, s.err)
				bump(assembledArbAgg.overall, s.locMatch, s.regMatch, s.resolved, s.err)

				if (hasStreetHN(tree)) arbPrecond++
			} catch {
				/* unresolved */
			}
		}

		if (collectErrors && (!ns.locMatch || !vs.locMatch)) {
			errorRows.push({
				input: row.input,
				state: row.state ?? "??",
				expected: row.expected,
				neural: {
					locMatch: ns.locMatch,
					resolved: ns.resolved,
					resolvedLoc: ns.resolvedLoc,
					resolvedReg: ns.resolvedReg,
					errKm: ns.err,
				},
				v0: {
					locMatch: vs.locMatch,
					resolved: vs.resolved,
					resolvedLoc: vs.resolvedLoc,
					resolvedReg: vs.resolvedReg,
					errKm: vs.err,
				},
			})
		}
	}

	if (collectErrors) {
		writeFileSync(arg("errors-json"), JSON.stringify(errorRows, null, 2))
		console.error(`wrote ${errorRows.length} failure rows → ${arg("errors-json")}`)
	}

	if (collectRows) {
		writeFileSync(arg("out-rows"), JSON.stringify(outRows))
		console.error(`wrote ${outRows.length} per-row outcomes → ${arg("out-rows")}`)
	}

	if (collectResolvedDump) {
		writeFileSync(arg("out-resolved"), JSON.stringify(resolvedRows))
		console.error(`wrote ${resolvedRows.length} resolved rows → ${arg("out-resolved")}`)
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

	if (runAssembled) {
		lines.push(overallRow("assembled (no arb)", assembledAgg.overall))
		lines.push(overallRow("**assembled + arb**", assembledArbAgg.overall))
	}

	if (useAnchor) lines.push(overallRow("**neural+anchor**", neuralAnchorAgg.overall))

	if (runAddrPt) {
		lines.push(overallRow("**neural+addrpt**", neuralAddrPtAgg.overall))
		lines.push("")
		lines.push(
			`address-point hit rate: ${addressPointHits}/${neuralAddrPtAgg.overall.n} (${((100 * addressPointHits) / Math.max(1, neuralAddrPtAgg.overall.n)).toFixed(1)}%)`
		)
	}

	if (runInterp) {
		lines.push(
			overallRow(cascadeOn ? "**neural+cascade (SHIPPED coord)**" : "**neural+interp**", neuralInterpAgg.overall)
		)
		lines.push("")
		lines.push(
			`interpolation hit rate (interp coord, no exact point): ${interpHits}/${neuralInterpAgg.overall.n} (${((100 * interpHits) / Math.max(1, neuralInterpAgg.overall.n)).toFixed(1)}%)`
		)

		if (cascadeOn) {
			const Nc = neuralInterpAgg.overall.n
			const adminTier = Math.max(0, Nc - addressPointHits - interpHits)
			const cerrs = neuralInterpAgg.overall.errs
			const within = (m: number): string =>
				`${((100 * cerrs.filter((e) => e <= m / 1000).length) / Math.max(1, cerrs.length)).toFixed(1)}%`
			lines.push("")
			lines.push(
				`**neural+cascade** is the PRODUCTION coordinate (mailwoman/geocode-core.ts: address_point > interpolated > admin, per-state shards) — what mailwoman actually ships, vs the admin-centroid **neural** row above. Tier share: address_point ${pct(addressPointHits, Nc)}, interpolated ${pct(interpHits, Nc)}, admin ${pct(adminTier, Nc)}. Within 100 m: ${within(100)} · within 1 km: ${within(1000)} (n=${cerrs.length}).`
			)
		}

		if (diagInterp) {
			const N = neuralInterpAgg.overall.n
			lines.push("")
			lines.push(`### interp coverage diagnostic`)
			lines.push(
				`- parsed street+house_number+postcode (precondition): ${interpPrecond}/${N} (${((100 * interpPrecond) / Math.max(1, N)).toFixed(1)}%)`
			)
			lines.push(
				`- precondition met + exact missed + interp MISS (genuine find() miss = shard/normalization gap): ${interpFullParseMiss}`
			)
			lines.push(
				`- interp HITS: ${interpHits} → of full-parse non-exact rows, hit rate ${((100 * interpHits) / Math.max(1, interpFullParseMiss + interpHits)).toFixed(1)}%`
			)
			// Error CDF over the neural+interp coordinate (DeepSeek: "where's the cliff?"). Cumulative % of
			// ALL rows within each radius — the within-100m DoD metric + the shape of the tail.
			const ierrs = neuralInterpAgg.overall.errs
			lines.push("")
			lines.push(`error CDF (neural+interp, n=${ierrs.length}) — cumulative % within radius:`)

			for (const m of [10, 25, 50, 100, 200, 500, 1000, 5000]) {
				const within = ierrs.filter((e) => e <= m / 1000).length
				lines.push(`  ≤ ${m} m: ${((100 * within) / Math.max(1, ierrs.length)).toFixed(1)}%`)
			}

			// Dump ALL full-parse misses for the standalone shard-membership categorization (segment-not-found
			// vs in-shard-range-miss vs normalization). Bump cap done at collection site.
			if (diagMisses.length > 0) {
				writeFileSync("/tmp/interp-misses.txt", diagMisses.join("\n"))
				lines.push("")
				lines.push(`full-parse interp misses dumped: ${diagMisses.length} → /tmp/interp-misses.txt`)
				lines.push("sample (house_number | street | postcode ← input):")

				for (const m of diagMisses.slice(0, 12)) lines.push(`  - ${m}`)
			}
		}
	}

	if (runAssembled) {
		const N = agg.neural.overall.n
		lines.push("")
		lines.push(`### Arbitration coordinate gate (#478 leg 2)`)
		lines.push("")
		lines.push(
			"`assembled (no arb)` is the pipeline through the same neural+resolver (comparability check vs `neural`); `assembled + arb` adds per-component arbitration. The street+house_number **precondition** (parsed both, the thing #566 broke) per arm:"
		)
		lines.push("")
		lines.push(
			`- neural: ${pct(neuralPrecond, N)} · assembled (no arb): ${pct(asmPrecond, N)} · **assembled + arb: ${pct(arbPrecond, N)}** (of ${N} rows)`
		)
		lines.push("")
		lines.push(
			"Gate: arbitration PASSES leg 2 iff the precondition does not regress and coord p50/p90 + locality/region Acc@1 hold vs `neural`."
		)
	}
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
		`Coord error for **neural**/**v0** is the ADMIN-CENTROID tier (locality/region centroid → OA's real` +
			` address point); a city centroid is legitimately tens of km from edge addresses, so the admin-MATCH` +
			` rate is the headline there, not the coord. **neural+anchor** swaps in the postcode anchor's own` +
			` centroid for the coordinate (admin match unchanged) — the finer postcode tier between admin-centroid` +
			` and street-level (TIGER), which will own the sub-km tier later.`
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

	postcodeLookup?.close()
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
