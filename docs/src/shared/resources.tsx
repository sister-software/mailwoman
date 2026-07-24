/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export interface FSTProvenanceLike {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

export interface FSTMatcherLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateID: number; accepted: boolean; depth: number },
		token: string
	): { stateID: number; accepted: boolean; depth: number } | null
	accepting(stateID: number): Array<{ wofID: number; placetype: string; importance: number }>
	readonly stateCount: number
	readonly placeCount: number
}

export interface MailwomanClassifierLike {
	parse: (text: string, opts?: { queryShape?: unknown; fst?: FSTMatcherLike }) => Promise<unknown>
	/**
	 * Decode-path introspection (spec 2026-07-03). Optional: deployed bundles built before the trace seam lack it —
	 * feature-detect before calling.
	 */
	traceParse?: (text: string, opts?: { addressSystemConventions?: "auto" }) => Promise<ParseTraceLike>
}

export interface TraceChannelLike {
	features: number[][]
	confidence: number[]
}

export interface TracePieceLike {
	piece: string
	id: number
	start: number
	end: number
}

export interface TraceTokenLike {
	piece: string
	start: number
	end: number
	label: string
	confidence: number
}

export interface TraceRepairLike {
	pass: string
	before: string[]
	after: string[]
}

/** Structural mirror of `@mailwoman/neural`'s `NeuralParseTrace` (spec 2026-07-03). */
export interface ParseTraceLike {
	text: string
	caseNormalized: boolean
	pieces: TracePieceLike[]
	anchor?: TraceChannelLike
	gazetteer?: TraceChannelLike
	logits: number[][]
	localeLogits?: number[]
	/** The locale-head axis (country code per `localeLogits` index) — self-describing, never hardcode the order. */
	localeCountries?: string[]
	detectedSystem: string | null
	systemSource: "off" | "auto" | "pinned"
	priors: Array<{ kind: string; applied: boolean }>
	emissions: number[][]
	labels: string[]
	path: number[]
	decode: "viterbi" | "argmax"
	repairs: TraceRepairLike[]
	tokens: TraceTokenLike[]
}

export interface MailwomanLookupLike {
	findPlace: (q: {
		text: string
		/**
		 * Requested placetype(s). Widened from the demo's original locality/postalcode/region union for the #861
		 * shared-resolver convergence: `resolveTree` + its coherence passes also query `country`, `county`, and pass arrays
		 * (the placetype-equivalence groups).
		 */
		placetype?: string | string[] | undefined
		country?: string
		/** Point-in-bbox filter — constrains candidates to a parsed region/state's bounds. */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		limit?: number
		postcode?: string
		/**
		 * Soft proximity hints (#938 — the demo's map viewport / user location). With bias present, exact-tier candidates
		 * near a hint sort ahead of distant ones; never a hard filter. Absent → population-first order.
		 */
		bias?: Array<{ lat: number; lon: number; weight?: number }>
	}) => Promise<
		Array<{
			id: number
			name: string
			placetype: string
			/**
			 * ISO country code of the resolved place — lets the cascade country-gate an ambiguous postcode.
			 */
			country?: string
			lat: number
			lon: number
			score: number
			/**
			 * True when the candidate's name, abbreviation, or an alias EXACTLY matched the query (vs a partial token match).
			 * The cascade accepts alias-exact hits ("New York City" → New York) the same way it accepts canonical-name
			 * matches.
			 */
			exactMatch?: boolean
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}>
	>
	/**
	 * Dual-role partner roles for a resolved place id (#402). Optional — absent on lookups built from a slim DB that
	 * predates the `coincident_roles` relation.
	 */
	coincidentRolesFor?: (placeID: number) => Promise<DualRole[]>
}

export interface KindResult {
	kind: string
	confidence: number
	alternatives: ReadonlyArray<{ kind: string; confidence: number }>
}

export interface ResultNode {
	tag: string
	value?: unknown
	confidence?: number
	/** Inclusive start char offset into `DemoResult.input`, when the decoder emits one. */
	start?: number
	/** Exclusive end char offset into the raw input. */
	end?: number
}

/** Per-stage wall-clock for one parse (ms). `resolve` is absent when the lookup is skipped. */
export interface StageTiming {
	/** QueryShape + kind classification (pure, ~µs). */
	shape: number
	/** Neural BIO classify + tree decode — the model inference. */
	classify: number
	/** WOF cascade lookup. Excludes the one-time DB load. */
	resolve?: number
}

export interface DemoResult {
	/** The raw text handed to the parser — the offsets in `nodes[].start/end` index into this string. */
	input: string
	tree: unknown
	nodes: ResultNode[]
	resolved: ResolvedHit | null
	candidates: ResolvedHit[]
	stateHint?: string
	kindResult?: KindResult
	/** Per-stage timing for the breakdown panel; absent on older render paths. */
	timing?: StageTiming
	fstActive: boolean
	fstProvenance?: FSTProvenanceLike | null
	/**
	 * Dual-role (#402): the additional admin tier(s) the resolved place also fulfils (city-state etc.).
	 */
	dualRoles?: DualRole[]
}

/**
 * One additional admin role a resolved place ALSO fulfils — the dual-role / city-state relation (#402). Berlin resolves
 * as a locality but `role: "region"` here surfaces that it is also a federal state. `relationshipType` is the
 * gazetteer-derived class (`city-state`, `capital-seat`, …).
 */
export interface DualRole {
	id: number
	name: string
	placetype: string
	relationshipType: string
	role: "region" | "locality"
}

export interface ResolvedHit {
	id: number
	name: string
	placetype: string
	lat: number
	lon: number
	score: number
	bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	/**
	 * Street-level resolution tier (#377), when this hit came from the situs/interp tier rather than the WOF admin
	 * cascade. `address_point` = exact building; `interpolated` = TIGER estimate. Drives the "exact / ±N m" caption + the
	 * uncertainty circle.
	 */
	tier?: "address_point" | "interpolated"
	/**
	 * Honest uncertainty radius in meters for a street-level tier (10 m situs floor; calibrated interp).
	 */
	uncertaintyM?: number
}

// All demo assets are served from our Cloudflare R2 bucket (nexus-public) on a custom domain.
// R2 + Cloudflare gives a stable clean URL, raw byte ranges (no gzip mangling), configurable CORS,
// low RTT, and free egress — the combination GitHub Pages (force-gzips ranges) and HF (per-request
// presigned redirect) couldn't. The DBs are range-loaded via sql.js-httpvfs from here; the rest is
// one-shot full-fetch. Mirrors the old HF key layout, so this was a base-URL swap.
const ASSET_BASE_URL = "https://public.sister.software/mailwoman/"

export function assetURL(locale: string, version: string, filename: string): string {
	return `${ASSET_BASE_URL}${locale}/${version}/${filename}`
}

/**
 * Per-state street shard URL (#377). The situs (exact address points) + interp (TIGER ranges) DBs are hosted byte-range
 * at `mailwoman/street/us/<slug>/<kind>.db` — a lookup touches ~KB of a multi-GB shard, so they're loaded lazily by
 * parsed region, not bundled. Independent of the locale/version WOF asset layout (street shards are per-state, not
 * per-model-version).
 */
export function streetShardURL(slug: string, kind: "situs" | "interp"): string {
	// National (non-US) shards live under their country at a DATED path (immutable Cache-Control means
	// a rebuilt shard needs a fresh URL — the admin-gazetteer discipline); US shards keep the
	// per-state layout. Bump the version when the BAN artifact is rebuilt + re-uploaded.
	if (NATIONAL_STREET_SLUGS.has(slug)) {
		return `${ASSET_BASE_URL}street/${slug}/${NATIONAL_STREET_SHARD_VERSION}/${kind}.db`
	}

	return `${ASSET_BASE_URL}street/us/${slug}/${kind}.db`
}

/**
 * Country-level national street shards (#1012 BAN-FR): one situs DB per country, no interpolation shard. The demo's
 * street tier tries these when the US per-state path doesn't claim the query — safe because the keyed (street, number,
 * postcode/locality) probes are self-validating against the register (a wrong-country probe is a cheap ~KB miss, never
 * a false hit).
 */
export const NATIONAL_STREET_SLUGS = new Set(["fr"])

/** Dated national-shard release (2026-07-10: the #1044 quote-fix + arrondissement-fold rebuild, md5 bc387335). */
export const NATIONAL_STREET_SHARD_VERSION = "2026-07-10"

/** The single national slug the demo's street tier falls back to when no hosted US state claims the query. */
export const NATIONAL_STREET_FALLBACK_SLUG = "fr" as const

/**
 * Gazetteer (date) version for the byte-ranged admin DB. The admin gazetteer is MODEL-INDEPENDENT — it changes when
 * WOF/Overture coverage is rebuilt, NOT on every model release — so it lives on its own dated path, not under
 * `<locale>/<model-version>/`. Bump this when `admin-global-priority.db` is rebuilt + re-uploaded (the immutable
 * Cache-Control means a fresh DB needs a fresh URL). See RELEASING.md "Rebuilding + swapping the canonical admin
 * gazetteer".
 */
export const ADMIN_GAZETTEER_VERSION = "2026-07-07a"

/**
 * Byte-ranged global "candidate" gazetteer (`candidate-global.db`, ~1.39 GB; US + intl postcodes + the GeoNames fold
 * grown to 244 countries by the #266 village-level + #267 admin-hierarchy coverage expansion as of 2026-06-30a) — the
 * single-B-tree-probe lookup that replaces the slim per-model-version `wof-hot.db` AND the full-DB FTS. A resolve
 * touches a handful of contiguous pages (~12 range fetches/session vs 243 on the full DB), with GLOBAL coverage and no
 * `SLIM_COUNTRIES` upkeep. It now also carries a co-located FTS5-trigram fuzzy index, consulted ONLY on an exact-name
 * miss (typo tolerance, e.g. Manchestr→Manchester) so the contiguous fast path is untouched. Resolved by
 * {@link WOFCandidateTableLookup} (build-candidate.ts). Hosted at `mailwoman/gazetteer/<date>/candidate.db`,
 * version-independent like the street shards.
 */
export function adminGazetteerURL(): string {
	return `${ASSET_BASE_URL}gazetteer/${ADMIN_GAZETTEER_VERSION}/candidate.db`
}

/**
 * Byte-ranged POI layer (`poi.db`, ~3.7 GB — 13.68M Overture-places rows across US/CA/MX/FR, spec §3.4) — the clustered
 * `(h3_cell, category_id, neg_rank, rowid_key)` `WITHOUT ROWID` B-tree the docs POI tester (`POIExplorer` /
 * `try-it.mdx`) range-loads for LIVE category search. Model-independent (like the admin gazetteer), so it lives on its
 * own dated path rather than under `<locale>/<model-version>/`. Bump this when the layer is rebuilt + re-uploaded (the
 * immutable Cache-Control means a fresh DB needs a fresh URL).
 */
export const POI_LAYER_VERSION = "2026-07-20a"

export function poiLayerURL(): string {
	return `${ASSET_BASE_URL}poi/${POI_LAYER_VERSION}/poi.db`
}

/**
 * Slugs we host street shards for (byte-range on R2). A state not in this set falls through to the WOF admin centroid.
 * National rollout (#735, 2026-06-21): the 50-state situs (#476/#567, 124.9M US address points) + TIGER interp shards
 * are hosted, so any US address resolves to its building (`address_point`, ≤10 m) or a calibrated interp estimate — not
 * a city centroid. `vi` = US Virgin Islands. (`il` is the whole state incl. Cook; the separate `il-cook` build shard is
 * not hosted.)
 */
export const HOSTED_STREET_SLUGS = new Set([
	"ak",
	"al",
	"ar",
	"az",
	"ca",
	"co",
	"ct",
	"dc",
	"de",
	"fl",
	"ga",
	"hi",
	"ia",
	"id",
	"il",
	"in",
	"ks",
	"ky",
	"la",
	"ma",
	"md",
	"me",
	"mi",
	"mn",
	"mo",
	"ms",
	"mt",
	"nc",
	"nd",
	"ne",
	"nh",
	"nj",
	"nm",
	"nv",
	"ny",
	"oh",
	"ok",
	"or",
	"pa",
	"ri",
	"sc",
	"sd",
	"tn",
	"tx",
	"ut",
	"va",
	"vi",
	"vt",
	"wa",
	"wi",
	"wv",
	"wy",
])

const US_STATE_NAME_TO_SLUG: Record<string, string> = {
	alabama: "al",
	alaska: "ak",
	arizona: "az",
	arkansas: "ar",
	california: "ca",
	colorado: "co",
	connecticut: "ct",
	delaware: "de",
	"district of columbia": "dc",
	florida: "fl",
	georgia: "ga",
	hawaii: "hi",
	idaho: "id",
	illinois: "il",
	indiana: "in",
	iowa: "ia",
	kansas: "ks",
	kentucky: "ky",
	louisiana: "la",
	maine: "me",
	maryland: "md",
	massachusetts: "ma",
	michigan: "mi",
	minnesota: "mn",
	mississippi: "ms",
	missouri: "mo",
	montana: "mt",
	nebraska: "ne",
	nevada: "nv",
	"new hampshire": "nh",
	"new jersey": "nj",
	"new mexico": "nm",
	"new york": "ny",
	"north carolina": "nc",
	"north dakota": "nd",
	ohio: "oh",
	oklahoma: "ok",
	oregon: "or",
	pennsylvania: "pa",
	"rhode island": "ri",
	"south carolina": "sc",
	"south dakota": "sd",
	tennessee: "tn",
	texas: "tx",
	utah: "ut",
	vermont: "vt",
	virginia: "va",
	washington: "wa",
	"west virginia": "wv",
	wisconsin: "wi",
	wyoming: "wy",
}

/**
 * US state/territory name OR abbreviation → 2-letter shard slug, or null if not a US region we recognize.
 */
export function regionToStateSlug(region: string | undefined): string | null {
	if (!region) return null
	const r = region.trim().toLowerCase()

	if (/^[a-z]{2}$/.test(r)) return r

	// already a 2-letter abbreviation (how US addresses usually write it)
	return US_STATE_NAME_TO_SLUG[r] ?? null
}

/**
 * Build the URL bag handed to `loadNeuralClassifierFromURLs` for a release. Shared by the demo's primary and compare
 * classifier loaders so the per-file asset layout (model / tokenizer / card / gazetteer lexicon, plus the optional
 * US/DE/FR postcode-anchor binaries) is defined exactly once.
 */
export function neuralClassifierLoadURLs(
	locale: string,
	version: string,
	opts: { hasAnchor?: boolean; forceWASM: boolean }
) {
	return {
		modelURL: assetURL(locale, version, "model.onnx"),
		tokenizerURL: assetURL(locale, version, "tokenizer.model"),
		modelCardURL: assetURL(locale, version, "model-card.json"),
		// Gazetteer-anchor lexicon (#464): REQUIRED by gazetteer-trained bundles (v4.2.0+). The loader
		// tolerates a 404 for older bundles (logging loudly when the model needed it).
		gazetteerLexiconURL: assetURL(locale, version, "anchor-lexicon-v1.json"),
		runner: { useWebGPU: !opts.forceWASM },
		// Anchor-trained bundles (v4.0.0+) ship postcode binaries so the demo feeds the postcode anchor
		// — US + DE + FR cover the demo's example set (native-order Berlin, French ZIPs).
		...(opts.hasAnchor
			? {
					postcodeBinaryURLs: [
						assetURL(locale, version, "postcode-us.bin"),
						assetURL(locale, version, "postcode-de.bin"),
						assetURL(locale, version, "postcode-fr.bin"),
					],
				}
			: {}),
	}
}

/**
 * Placetype-pair indexes staged SAME-ORIGIN by the demo-assets plugin (placetype-pair-prior arc, #1278). Unlike every
 * other classifier asset (model / tokenizer / postcode binaries), these are NOT on the R2 bucket yet — that repoint is
 * the release-train's job. For dev/staged verification the plugin copies
 * `neural-weights-en-{gb,nz}/pair-index-{gb,nz}.bin` into `static/mailwoman/pair-index/`, served under the site base
 * alongside the sql.js worker assets. The loader fetches these TOLERANTLY (a 404 when a binary wasn't staged — e.g. a
 * CI build with no dev weights — is skipped, never fatal), so wiring them here is byte-stable when they're absent.
 */
export const STAGED_PAIR_INDEX_COUNTRIES = ["gb", "nz"] as const

/**
 * Build the same-origin URLs for the staged placetype-pair indexes (see {@link STAGED_PAIR_INDEX_COUNTRIES}).
 *
 * @param pairIndexBaseURL Same-origin base for the staged binaries (e.g. `/mailwoman/pair-index`).
 */
export function pairIndexStagedURLs(pairIndexBaseURL: string): string[] {
	const base = pairIndexBaseURL.replace(/\/$/, "")

	return STAGED_PAIR_INDEX_COUNTRIES.map((cc) => `${base}/pair-index-${cc}.bin`)
}

export async function loadFSTGazetteer(
	locale: string,
	version: string
): Promise<{ matcher: FSTMatcherLike; provenance?: FSTProvenanceLike }> {
	const [fstModule, fstBinary] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/fst-deserialize-web"),
		fetch(assetURL(locale, version, "fst-en-US.bin")).then((r) => {
			if (!r.ok) throw new Error(`FST fetch failed (${r.status})`)

			return r.arrayBuffer()
		}),
	])
	const matcher = fstModule.deserializeFSTWeb(fstBinary) as FSTMatcherLike
	let provenance: FSTProvenanceLike | undefined

	try {
		provenance = fstModule.readFSTProvenanceWeb(fstBinary) as FSTProvenanceLike | undefined
	} catch {
		/* V2 binary — no provenance */
	}

	return { matcher, provenance }
}
