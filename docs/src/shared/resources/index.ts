/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// Moved to @mailwoman/resolver-wof-wasm so the packages that resolve through a browser lookup can
// reach them without importing from the docs site. Re-exported here so demo code is unchanged.
// Imported rather than re-exported straight through: `DualRole` is used locally below, and a bare
// re-export does not bind the name in this module.
// oxlint-disable-next-line unicorn/prefer-export-from -- see above
import type { DualRole, MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"

export type { DualRole, MailwomanLookupLike }

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
	accepting(stateID: number): Array<{
		wofID: number
		placetype: string
		/**
		 * The REFERENTIAL likelihood (population-anchored) the decoder bias reads — see ROAD_TO_V9 §2. Was `importance`
		 * through FST format v4, where the same float could be either score with nothing to say which.
		 */
		referential: number
		/**
		 * Encyclopedic (Wikipedia) importance, when the artifact is v5+ and this place has an article. Displayed, never
		 * ranked on; `undefined` is absence, not 0.
		 */
		encyclopedic?: number
	}>
	readonly stateCount: number
	readonly placeCount: number
}

export interface MailwomanClassifierLike {
	parse: (text: string, opts?: { queryShape?: unknown; fst?: FSTMatcherLike }) => Promise<unknown>
	/**
	 * Decode-path introspection (spec 2026-07-03). Optional: deployed bundles built before the `traceParse` hook lack it
	 * — feature-detect before calling.
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

/**
 * Structural mirror of `@mailwoman/neural`'s `NeuralParseTrace` (spec 2026-07-03).
 */
export interface ParseTraceLike {
	text: string
	caseNormalized: boolean
	pieces: TracePieceLike[]
	anchor?: TraceChannelLike
	gazetteer?: TraceChannelLike
	logits: number[][]
	localeLogits?: number[]
	/**
	 * The locale-head axis (country code per `localeLogits` index) — self-describing, never hardcode the order.
	 */
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

export interface KindResult {
	kind: string
	confidence: number
	alternatives: ReadonlyArray<{ kind: string; confidence: number }>
}

export interface ResultNode {
	tag: string
	value?: unknown
	confidence?: number
	/**
	 * Inclusive start char offset into `DemoResult.input`, when the decoder emits one.
	 */
	start?: number
	/**
	 * Exclusive end char offset into the raw input.
	 */
	end?: number
}

/**
 * Per-stage wall-clock for one parse (ms). `resolve` is absent when the lookup is skipped.
 */
export interface StageTiming {
	/**
	 * QueryShape + kind classification (pure, ~µs).
	 */
	shape: number
	/**
	 * Neural BIO classify + tree decode — the model inference.
	 */
	classify: number
	/**
	 * WOF cascade lookup. Excludes the one-time DB load.
	 */
	resolve?: number
}

export interface DemoResult {
	/**
	 * The raw text handed to the parser — the offsets in `nodes[].start/end` index into this string.
	 */
	input: string
	tree: unknown
	nodes: ResultNode[]
	resolved: ResolvedHit | null
	candidates: ResolvedHit[]
	stateHint?: string
	kindResult?: KindResult
	/**
	 * Per-stage timing for the breakdown panel; absent on older render paths.
	 */
	timing?: StageTiming
	fstActive: boolean
	fstProvenance?: FSTProvenanceLike | null
	/**
	 * Dual-role (#402): the additional admin tier(s) the resolved place also fulfils (city-state etc.).
	 */
	dualRoles?: DualRole[]
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

/**
 * All demo assets are served from our Cloudflare R2 bucket (nexus-public) on a custom domain. R2 + Cloudflare gives a
 * stable clean URL, raw byte ranges (no gzip mangling), configurable CORS, low RTT, and free egress — the combination
 * GitHub Pages (force-gzips ranges) and HF (per-request presigned redirect) couldn't. The DBs are range-loaded via
 * sql.js-httpvfs from here; the rest is one-shot full-fetch. Mirrors the old HF key layout, so this was a base-URL
 * swap.
 */
const ASSET_BASE_URL = "https://public.mailwoman.ai/mailwoman/"

export function assetURL(locale: string, version: string, filename: string): string {
	return `${ASSET_BASE_URL}${locale}/${version}/${filename}`
}

/**
 * The per-locale releases manifest (`releases.json`) — the version pointer beside the versioned asset directories.
 */
export function releasesManifestURL(locale: string): string {
	return `${ASSET_BASE_URL}${locale}/releases.json`
}

/**
 * Same-origin base for the staged sql.js-httpvfs runtime assets (UMD + worker + wasm), under the site's base URL.
 */
export function sqljsBaseURL(siteBaseURL: string): string {
	return `${siteBaseURL}mailwoman/sqljs`
}

/**
 * Per-state street extract URL (#377). The situs (exact address points) + interp (TIGER ranges) DBs are hosted
 * byte-range at `mailwoman/street/us/<slug>/<kind>.db` — a lookup touches ~KB of a multi-GB extract, so they're loaded
 * lazily by parsed region, not bundled. Independent of the locale/version WOF asset layout (street extracts are
 * per-state, not per-model-version).
 */
export function streetExtractURL(slug: string, kind: "situs" | "interp"): string {
	// National (non-US) extracts live under their country at a DATED path (immutable Cache-Control means
	// a rebuilt extract needs a fresh URL — the admin-gazetteer discipline); US extracts keep the
	// per-state layout. Bump the version when the BAN artifact is rebuilt + re-uploaded.
	if (NATIONAL_STREET_SLUGS.has(slug)) {
		return `${ASSET_BASE_URL}street/${slug}/${NATIONAL_STREET_EXTRACT_VERSION}/${kind}.db`
	}

	return `${ASSET_BASE_URL}street/us/${slug}/${kind}.db`
}

/**
 * Country-level national street extracts (#1012 BAN-FR): one situs DB per country, no interpolation extract. The demo's
 * street tier tries these when the US per-state path doesn't claim the query — safe because the keyed (street, number,
 * postcode/locality) probes are self-validating against the register (a wrong-country probe is a cheap ~KB miss, never
 * a false hit).
 */
export const NATIONAL_STREET_SLUGS = new Set(["fr"])

/**
 * Dated national-extract release (2026-07-10: the #1044 quote-fix + arrondissement-fold rebuild, md5 bc387335).
 */
export const NATIONAL_STREET_EXTRACT_VERSION = "2026-07-10"

/**
 * The single national slug the demo's street tier falls back to when no hosted US state claims the query.
 */
export const NATIONAL_STREET_FALLBACK_SLUG = "fr" as const

/**
 * Gazetteer (date) version for the byte-ranged admin DB. The admin gazetteer is MODEL-INDEPENDENT — it changes when
 * WOF/Overture coverage is rebuilt, NOT on every model release — so it lives on its own dated path, not under
 * `<locale>/<model-version>/`. Bump this when `admin-global-priority.db` is rebuilt + re-uploaded (the immutable
 * Cache-Control means a fresh DB needs a fresh URL). See RELEASING.md "Rebuilding + swapping the canonical admin
 * gazetteer".
 */
export const ADMIN_GAZETTEER_VERSION = "2026-08-25b"

/**
 * Byte-ranged global "candidate" gazetteer (`candidate-global.db`, ~2.88 GB; US + intl postcodes + the GeoNames fold
 * across 244 countries) — the single-B-tree-probe lookup that replaces the slim per-model-version `wof-hot.db` AND the
 * full-DB FTS. A resolve touches a handful of contiguous pages (~12 range fetches/session vs 243 on the full DB), with
 * GLOBAL coverage and no `SLIM_COUNTRIES` upkeep. It now also carries a co-located FTS5-trigram fuzzy index, consulted
 * ONLY on an exact-name miss (typo tolerance, e.g. Manchestr→Manchester) so the contiguous fast path is untouched.
 * Resolved by {@link WOFCandidateTableLookup} (build-candidate.ts). Hosted at
 * `mailwoman/gazetteer/<date>/candidate.db`, version-independent like the street extracts.
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
 * Slugs we host street extracts for (byte-range on R2). A state not in this set falls through to the WOF admin
 * centroid. National rollout (#735, 2026-06-21): the 50-state situs (#476/#567, 124.9M US address points) + TIGER
 * interp extracts are hosted, so any US address resolves to its building (`address_point`, ≤10 m) or a calibrated
 * interp estimate — not a city centroid. `vi` = US Virgin Islands. (`il` is the whole state incl. Cook; the separate
 * `il-cook` build extract is not hosted.)
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
 * US state/territory name OR abbreviation → 2-letter extract slug, or null if not a US region we recognize.
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
 * Countries whose placetype-pair index the demo loads (placetype-pair-prior arc, #1278). The loader fetches each
 * TOLERANTLY (a 404 is skipped, never fatal), so this list is byte-stable for a country whose binary isn't published.
 */
export const PAIR_INDEX_COUNTRIES = ["gb", "nz"] as const

/**
 * Generation stamp for the published pair-index binaries — the `<version>` segment in
 * `mailwoman/pair-index/<version>/pair-index-<cc>.bin`.
 *
 * The binaries carry the same `public, max-age=604800, immutable` Cache-Control as every other bucket object, so a
 * rebuilt index needs a FRESH URL — the discipline {@link ADMIN_GAZETTEER_VERSION}, {@link POI_LAYER_VERSION} and
 * {@link NATIONAL_STREET_EXTRACT_VERSION} already follow. Bump this the same commit the binaries are rebuild and
 * re-uploaded; the mutable pointer is this constant inside the (revalidated) Pages bundle, never the binaries.
 *
 * Why a site-side constant rather than a `releases.json` field: the PIX reader that consumes these binaries
 * (`@mailwoman/neural`'s `pair-index-resolver`) is bundled into the SITE, not fetched per model release, and it THROWS
 * on a `schemaVersion` older than its own (`KNOWN_SCHEMA_VERSION`). So the generation a page may safely request is a
 * property of the deployed site, not of the release the visitor selected — pinning it per release entry would let a
 * schema-3 reader ask for a schema-1 generation.
 *
 * 2026-08-05: the PIX schema-3 (typed parent record) rebuild. It was overwritten IN PLACE at the un-versioned path, and
 * the CDN kept serving the schema-1 bytes under the immutable header until a manual purge — the wound this scheme
 * closes.
 */
export const PAIR_INDEX_VERSION = "2026-08-05"

/**
 * Base URL for one published generation of the pair-index binaries.
 */
export function pairIndexBaseURL(version: string): string {
	return `${ASSET_BASE_URL}pair-index/${version}`
}

/**
 * Build the per-country binary URLs under a pair-index base (see {@link PAIR_INDEX_COUNTRIES}).
 *
 * @param baseURL Base for the binaries — a trailing slash is tolerated.
 */
export function pairIndexURLs(baseURL: string): string[] {
	const base = baseURL.replace(/\/$/, "")

	return PAIR_INDEX_COUNTRIES.map((cc) => `${base}/pair-index-${cc}.bin`)
}

export async function loadFSTGazetteer(
	locale: string,
	version: string
): Promise<{ matcher: FSTMatcherLike; provenance?: FSTProvenanceLike }> {
	const [fstModule, fstBinary] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/fst/deserialize-web"),
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

/**
 * Load the locale-general street-morphology FST (`fst-street-morphology.bin`) for a release — the #1315 street-context
 * check's signal source, shipped as a weights-package sibling (so it rides the same per-version R2 asset layout as the
 * model). Node runtimes rebuild this matcher from the bundled libpostal dictionaries when the artifact is absent; the
 * browser cannot, which is exactly the node/browser behavior fork the sealed artifact closes. Returns `null` when the
 * release predates the artifact (HTTP 404) — the demo then parses without the check, exactly as before. A
 * present-but-corrupt binary throws; the caller's tolerant catch treats that as absent too.
 */
export async function loadStreetMorphologyFST(locale: string, version: string): Promise<FSTMatcherLike | null> {
	const res = await fetch(assetURL(locale, version, "fst-street-morphology.bin"))

	if (!res.ok) return null
	const fstModule = await import("@mailwoman/resolver-wof-sqlite/fst/deserialize-web")

	return fstModule.deserializeFSTWeb(await res.arrayBuffer()) as FSTMatcherLike
}
