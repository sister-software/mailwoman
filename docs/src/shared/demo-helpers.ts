/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared helpers for the Mailwoman demo — types, constants, and utility functions used by both the
 *   PipelineExplorer embeddable component and the full demo page.
 */

import type { MailwomanLookupLike } from "./resources.tsx"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseInfo {
	version: string
	label: string
	description: string
	modelSize: string
	tokenizerVocab: number
	steps: number
	hasFst: boolean
	hasWofDb: boolean
	hasAnchor?: boolean
	hasPolygons?: boolean
}

export interface ReleasesManifest {
	locale: string
	defaultVersion: string
	releases: ReleaseInfo[]
}

export type ParsedNode = { tag: string; value?: unknown; confidence?: number }

export type TreeNode = {
	tag?: string
	value?: unknown
	confidence?: number
	start?: number
	end?: number
	children?: unknown[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_LOCALE = "en-us"

export const DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"

export const EXAMPLE_ADDRESSES: Array<{ label: string; address: string }> = [
	{ label: "White House", address: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Apple Park", address: "1 Apple Park Way, Cupertino, CA 95014" },
	{ label: "30 Rockefeller Plaza", address: "30 Rockefeller Plaza, New York, NY 10112" },
	{ label: "Pier 39 SF", address: "Pier 39, San Francisco, CA 94133" },
	{ label: "Wrigley Field", address: "1060 W Addison St, Chicago, IL 60613" },
	{ label: "Space Needle", address: "400 Broad St, Seattle, WA 98109" },
	{ label: "ZIP only", address: "90210" },
	{ label: "Berlin (native order)", address: "Straußstraße 27, 12623 Berlin" },
	{ label: "Berlin city-state (int'l order)", address: "5 Hauptstraße, Berlin, Berlin 10115" },
	{ label: "Paris (street fall-through)", address: "181 Rue du Chevaleret, Paris" },
]

// ---------------------------------------------------------------------------
// US state abbreviation expansion
// ---------------------------------------------------------------------------

const US_STATE_ABBREV: Record<string, string> = {
	AL: "Alabama",
	AK: "Alaska",
	AZ: "Arizona",
	AR: "Arkansas",
	CA: "California",
	CO: "Colorado",
	CT: "Connecticut",
	DE: "Delaware",
	DC: "District of Columbia",
	FL: "Florida",
	GA: "Georgia",
	HI: "Hawaii",
	ID: "Idaho",
	IL: "Illinois",
	IN: "Indiana",
	IA: "Iowa",
	KS: "Kansas",
	KY: "Kentucky",
	LA: "Louisiana",
	ME: "Maine",
	MD: "Maryland",
	MA: "Massachusetts",
	MI: "Michigan",
	MN: "Minnesota",
	MS: "Mississippi",
	MO: "Missouri",
	MT: "Montana",
	NE: "Nebraska",
	NV: "Nevada",
	NH: "New Hampshire",
	NJ: "New Jersey",
	NM: "New Mexico",
	NY: "New York",
	NC: "North Carolina",
	ND: "North Dakota",
	OH: "Ohio",
	OK: "Oklahoma",
	OR: "Oregon",
	PA: "Pennsylvania",
	RI: "Rhode Island",
	SC: "South Carolina",
	SD: "South Dakota",
	TN: "Tennessee",
	TX: "Texas",
	UT: "Utah",
	VT: "Vermont",
	VA: "Virginia",
	WA: "Washington",
	WV: "West Virginia",
	WI: "Wisconsin",
	WY: "Wyoming",
	PR: "Puerto Rico",
}

export const normName = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, " ")

/**
 * USPS two-letter codes → full state name. A bare "IL" FTS-matches "Ille-et-Vilaine" (a French
 * département) before "Illinois", so its France bbox filters out the actual US city — expanding to
 * the full name resolves the right region. Full names pass through unchanged.
 */
export function expandUsRegion(text: string): string {
	return US_STATE_ABBREV[text.trim().toUpperCase()] ?? text
}

// ---------------------------------------------------------------------------
// Tree flattening
// ---------------------------------------------------------------------------

/**
 * Flatten a solver tree into source-order nodes. Depth-first appended in reverse; flip for source
 * order.
 */
export function flattenTree(
	tree: unknown
): Array<{ tag: string; value?: unknown; confidence?: number; start?: number; end?: number }> {
	const out: Array<{ tag: string; value?: unknown; confidence?: number; start?: number; end?: number }> = []
	const roots = (tree as { roots?: unknown[] } | null | undefined)?.roots ?? []
	const stack = [...(roots as TreeNode[])]
	while (stack.length) {
		const n = stack.pop()!
		if (typeof n.tag === "string") {
			out.push({ tag: n.tag, value: n.value, confidence: n.confidence, start: n.start, end: n.end })
		}
		if (Array.isArray(n.children)) {
			for (const c of n.children) {
				stack.push(c as TreeNode)
			}
		}
	}
	return out.reverse()
}

// ---------------------------------------------------------------------------
// Confidence calibration (browser-safe mirror)
// ---------------------------------------------------------------------------

/** Maps a raw span confidence in [0, 1] to its calibrated probability of correctness. */
export type Calibrator = (raw: number) => number

interface CalibrationBin {
	center: number
	calibrated: number
}

/**
 * Browser-safe twin of `@mailwoman/core/decoder/calibration`'s `createCalibrator`. The canonical
 * lives in core for the Node parse path; we can't import it into the docs webpack bundle (the
 * `core/decoder` barrel pulls in node-only siblings like `build-tree`, and the deep subpath isn't a
 * published export), so the ~15-line piecewise-linear interp is mirrored here verbatim. Keep the
 * two in sync — both are pure, monotone, and clamp to the table's range outside it.
 */
export function createCalibrator(table: { table: CalibrationBin[] } | CalibrationBin[]): Calibrator {
	const bins = Array.isArray(table) ? table : table.table
	if (!bins || bins.length === 0) throw new Error("createCalibrator: empty calibration table")
	const sorted = [...bins].sort((a, b) => a.center - b.center)
	const centers = sorted.map((b) => b.center)
	const cals = sorted.map((b) => clamp01(b.calibrated))
	const n = centers.length
	return (raw: number): number => {
		const x = clamp01(raw)
		if (x <= centers[0]!) return cals[0]!
		if (x >= centers[n - 1]!) return cals[n - 1]!
		let lo = 0
		let hi = n - 1
		while (hi - lo > 1) {
			const mid = (lo + hi) >> 1
			if (centers[mid]! <= x) lo = mid
			else hi = mid
		}
		const x0 = centers[lo]!
		const x1 = centers[hi]!
		const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0)
		return cals[lo]! + t * (cals[hi]! - cals[lo]!)
	}
}

function clamp01(v: number): number {
	if (Number.isNaN(v)) return 0
	if (v < 0) return 0
	if (v > 1) return 1
	return v
}

// ---------------------------------------------------------------------------
// WOF cascade lookup
// ---------------------------------------------------------------------------

type RegionBbox = { minLat: number; maxLat: number; minLon: number; maxLon: number }

/**
 * Per-lookup-instance cache of region → bbox resolutions ("NY" → New York's bounds). Users iterate
 * on addresses within one region, and the region query re-ran on every submit — a worker round trip
 * each time. Misses are cached too (entry present, `bbox` undefined) so a region the gazetteer
 * can't bound isn't re-queried; the stored `warning` is replayed so the unconstrained-lookup signal
 * stays loud on every submit. WeakMap-keyed so a version switch (new lookup instance) drops it.
 */
const regionBboxCache = new WeakMap<MailwomanLookupLike, Map<string, { bbox?: RegionBbox; warning?: string }>>()

/**
 * Cascade: postcode first (most precise), fall back to locality, then raw text. Drop (lat=0, lon=0)
 * hits — WOF ships placeholder zeros on ~22% of US postcodes.
 */
export async function runCascade(
	lookup: MailwomanLookupLike,
	postcodeNode: ParsedNode | undefined,
	localityNodes: ParsedNode[],
	stateNode: ParsedNode | undefined,
	rawText: string
): Promise<Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>> {
	type Hits = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>
	const usable = (cs: Hits): Hits => cs.filter((c) => !(c.lat === 0 && c.lon === 0))

	// Failure mode for a mis-tagged span. The model can label a street as a locality ("Rue du
	// Chevaleret") and emit several locality spans alongside the real city ("Paris"). Resolve them in
	// source order (specific → general) and prefer a hypothesis whose top hit is an EXACT name match
	// — a real place actually called this — over a fuzzy token match (a street name can token-collide
	// with an unrelated same-named town). So when the specific line isn't a real place, we fall
	// through to the one that is: the city. A fuzzy hit is kept only as a last-resort backstop.
	const resolveLocality = async (regionBbox: Hits[number]["bbox"]): Promise<Hits> => {
		// Prefer an exact match (canonical name, or the backend's alias/abbr `exactMatch` tier —
		// "New York City" is a WOF alias of the New York locality) inside the region bbox; if none,
		// retry the same nodes WITHOUT the bbox before settling for a fuzzy hit. The unconstrained
		// retry is the safety net for a mis-resolved region (e.g. "IL" → a French département): a bad
		// bbox can't cause a total miss.
		let fuzzy: Hits = []
		for (const bbox of regionBbox ? [regionBbox, undefined] : [undefined]) {
			for (const node of localityNodes) {
				const text = String(node.value ?? "").trim()
				if (!text) continue
				const cs = usable(await lookup.findPlace({ text, placetype: "locality", bbox, limit: 5 }))
				if (cs.length === 0) continue
				if (cs.some((c) => c.exactMatch || normName(c.name) === normName(text))) return cs
				if (fuzzy.length === 0) fuzzy = cs
			}
			// Fail loud when the region constraint produced nothing and we're about to widen — a silent
			// fallback here is how "brooklyn, new york" quietly resolved to Brooklyn Park, MN.
			if (bbox) {
				console.warn(
					"[mailwoman demo] no exact locality match inside the resolved region's bbox — retrying without the region constraint"
				)
			}
		}
		return fuzzy
	}

	// Use the geography the parser found. Country is NOT hardcoded to US — a global search plus the
	// resolver's population ranking surfaces the famous same-name place ("Berlin" → Berlin, DE 3.7M,
	// not Berlin, NH 9k). A parsed region/state is resolved to its bbox and used to constrain the
	// postcode + locality lookups, which disambiguates same-name US localities ("Roseville, Michigan"
	// → the Roseville inside Michigan's bounds, not the larger Roseville, CA the population boost
	// would otherwise pick).
	let regionBbox: RegionBbox | undefined
	if (stateNode?.value) {
		const regionText = expandUsRegion(String(stateNode.value))
		const cacheKey = regionText.toLowerCase().trim()
		let perLookup = regionBboxCache.get(lookup)
		if (!perLookup) {
			perLookup = new Map()
			regionBboxCache.set(lookup, perLookup)
		}
		let entry = perLookup.get(cacheKey)
		if (!entry) {
			const regions = await lookup.findPlace({
				text: regionText,
				placetype: "region",
				limit: 1,
			})
			entry = { bbox: regions[0]?.bbox }
			// Fail loud: a region the parser found but the gazetteer can't resolve (or one resolved
			// without a bbox) means the locality lookup runs UNCONSTRAINED — same-name places anywhere
			// in the world can win. Don't let that degrade silently.
			if (!entry.bbox) {
				entry.warning =
					`[mailwoman demo] parsed region ${JSON.stringify(regionText)} did not resolve to a bbox` +
					(regions.length > 0 ? ` (top hit ${JSON.stringify(regions[0]?.name)} carries no bbox)` : " (no candidates)") +
					" — locality lookup is unconstrained"
			}
			perLookup.set(cacheKey, entry)
		}
		regionBbox = entry.bbox
		if (entry.warning) console.warn(entry.warning)
	}

	// Resolve the locality FIRST: its population-ranked country (Berlin → Berlin DE 3.5M, not Berlin NH)
	// gates the postcode below, so an ambiguous INTERNATIONAL postcode — 10115 is both a Berlin DE postcode
	// and a New York US ZIP (the candidate gazetteer now carries US + DE/FR/EU postcodes) — can't out-
	// resolve the parsed city across countries. The postcode still WINS when it resolves within the
	// locality's country (the most precise tier — 10115 → the Berlin DE point); it just can't drag a German
	// address to New York. A bare postcode with no parsed locality stays country-ambiguous (a known edge —
	// see #153 follow-up); every demo example carries a gating locality.
	const localityHits = await resolveLocality(regionBbox)

	if (postcodeNode?.value) {
		const cs = usable(
			await lookup.findPlace({
				text: String(postcodeNode.value),
				placetype: "postalcode",
				bbox: regionBbox,
				country: localityHits[0]?.country,
				limit: 5,
			})
		)
		if (cs.length > 0) return cs
	}

	if (localityHits.length > 0) return localityHits

	return usable(await lookup.findPlace({ text: rawText, bbox: regionBbox, limit: 5 }))
}

// ---------------------------------------------------------------------------
// Street-level resolution (situs → interpolation), in front of the admin cascade
// ---------------------------------------------------------------------------

/** A street-level coordinate + which tier produced it + an honest radius. */
export interface StreetResolution {
	lat: number
	lon: number
	tier: "address_point" | "interpolated"
	/**
	 * Calibrated uncertainty radius in meters (10 m situs floor; interp = uncertaintyM × the region
	 * factor).
	 */
	uncertaintyM: number
}

/** Structural shapes so this is testable with stubs (and decoupled from the httpvfs-street classes). */
interface SitusLike {
	find(q: {
		street: string
		number: string
		postcode?: string
		locality?: string
	}): Promise<{ lat: number; lon: number } | null>
}
interface InterpLike {
	find(q: {
		street: string
		number: string
		postcode?: string
	}): Promise<{ lat: number; lon: number; uncertaintyM: number } | null>
}

/**
 * Street tier: exact situs point first (10 m floor), then TIGER interpolation (honest calibrated
 * radius), else null so the caller falls back to the admin cascade ({@link runCascade}). Mirrors the
 * node `geocode-core` tier order (address_point > interpolated > admin) — but async, on the main
 * thread, over the demo's httpvfs handles. `interpRadiusCalibration` is the per-region conformal
 * factor (#374 / data/calibration/interp-radius-conformal.json); default 1.95 (the conservative
 * national default — under-coverage is the harmful error).
 */
export async function resolveStreet(
	street: string | undefined,
	houseNumber: string | undefined,
	postcode: string | undefined,
	locality: string | undefined,
	situs: SitusLike | undefined,
	interp: InterpLike | undefined,
	interpRadiusCalibration = 1.95
): Promise<StreetResolution | null> {
	const st = (street ?? "").trim()
	const num = (houseNumber ?? "").trim()
	if (!st || !num) return null // not a street-level query — let the admin cascade handle it

	if (situs) {
		const hit = await situs.find({ street: st, number: num, postcode, locality })
		if (hit && !(hit.lat === 0 && hit.lon === 0)) {
			return { lat: hit.lat, lon: hit.lon, tier: "address_point", uncertaintyM: 10 }
		}
	}
	if (interp) {
		const hit = await interp.find({ street: st, number: num, postcode })
		if (hit && !(hit.lat === 0 && hit.lon === 0)) {
			return {
				lat: hit.lat,
				lon: hit.lon,
				tier: "interpolated",
				uncertaintyM: Math.round(hit.uncertaintyM * interpRadiusCalibration),
			}
		}
	}
	return null
}
