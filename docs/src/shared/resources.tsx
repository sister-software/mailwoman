/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

export interface FstProvenanceLike {
	builtAt: string
	stateCount: number
	placeCount: number
	importanceMatches: number
}

export interface FstMatcherLike {
	walk(tokens: string[]): { stateId: number; accepted: boolean; depth: number } | null
	walkFrom(
		prev: { stateId: number; accepted: boolean; depth: number },
		token: string
	): { stateId: number; accepted: boolean; depth: number } | null
	accepting(stateId: number): Array<{ wofID: number; placetype: string; importance: number }>
	readonly stateCount: number
	readonly placeCount: number
}

export interface MailwomanClassifierLike {
	parse: (text: string, opts?: { queryShape?: unknown; fst?: FstMatcherLike }) => Promise<unknown>
}

export interface MailwomanLookupLike {
	findPlace: (q: {
		text: string
		placetype?: "locality" | "postalcode" | "region" | undefined
		country?: string
		/** Point-in-bbox filter — constrains candidates to a parsed region/state's bounds. */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		limit?: number
	}) => Promise<
		Array<{
			id: number
			name: string
			placetype: string
			lat: number
			lon: number
			score: number
			bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
		}>
	>
	/**
	 * Dual-role partner roles for a resolved place id (#402). Optional — absent on lookups built from
	 * a slim DB that predates the `coincident_roles` relation.
	 */
	coincidentRolesFor?: (placeId: number) => Promise<DualRole[]>
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
	fstProvenance?: FstProvenanceLike | null
	/**
	 * Dual-role (#402): the additional admin tier(s) the resolved place also fulfils (city-state
	 * etc.).
	 */
	dualRoles?: DualRole[]
}

/**
 * One additional admin role a resolved place ALSO fulfils — the dual-role / city-state relation
 * (#402). Berlin resolves as a locality but `role: "region"` here surfaces that it is also a
 * federal state. `relationshipType` is the gazetteer-derived class (`city-state`, `capital-seat`,
 * …).
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
}

// All demo assets are served from our Cloudflare R2 bucket (nexus-public) on a custom domain.
// R2 + Cloudflare gives a stable clean URL, raw byte ranges (no gzip mangling), configurable CORS,
// low RTT, and free egress — the combination GitHub Pages (force-gzips ranges) and HF (per-request
// presigned redirect) couldn't. The DBs are range-loaded via sql.js-httpvfs from here; the rest is
// one-shot full-fetch. Mirrors the old HF key layout, so this was a base-URL swap.
const ASSET_BASE_URL = "https://public.sister.software/mailwoman/"

export function assetUrl(locale: string, version: string, filename: string): string {
	return `${ASSET_BASE_URL}${locale}/${version}/${filename}`
}

export async function loadFstGazetteer(
	locale: string,
	version: string
): Promise<{ matcher: FstMatcherLike; provenance?: FstProvenanceLike }> {
	const [fstModule, fstBinary] = await Promise.all([
		import("@mailwoman/resolver-wof-sqlite/fst-deserialize-web"),
		fetch(assetUrl(locale, version, "fst-en-US.bin")).then((r) => {
			if (!r.ok) throw new Error(`FST fetch failed (${r.status})`)
			return r.arrayBuffer()
		}),
	])
	const matcher = fstModule.deserializeFstWeb(fstBinary) as FstMatcherLike
	let provenance: FstProvenanceLike | undefined
	try {
		provenance = fstModule.readFstProvenanceWeb(fstBinary) as FstProvenanceLike | undefined
	} catch {
		/* V2 binary — no provenance */
	}

	return { matcher, provenance }
}
