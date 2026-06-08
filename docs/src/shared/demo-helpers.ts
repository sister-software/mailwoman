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
	{ label: "Empire State", address: "350 5th Ave, New York, NY 10118" },
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
// WOF cascade lookup
// ---------------------------------------------------------------------------

/**
 * Cascade: postcode first (most precise), fall back to locality, then raw text.
 * Drop (lat=0, lon=0) hits — WOF ships placeholder zeros on ~22% of US postcodes.
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
		// Prefer an exact-name match inside the region bbox; if none, retry the same nodes WITHOUT the
		// bbox before settling for a fuzzy hit. The unconstrained retry is the safety net for a
		// mis-resolved region (e.g. "IL" → a French département): a bad bbox can't cause a total miss.
		let fuzzy: Hits = []
		for (const bbox of regionBbox ? [regionBbox, undefined] : [undefined]) {
			for (const node of localityNodes) {
				const text = String(node.value ?? "").trim()
				if (!text) continue
				const cs = usable(await lookup.findPlace({ text, placetype: "locality", bbox, limit: 5 }))
				if (cs.length === 0) continue
				if (cs.some((c) => normName(c.name) === normName(text))) return cs
				if (fuzzy.length === 0) fuzzy = cs
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
	let regionBbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined
	if (stateNode?.value) {
		const regions = await lookup.findPlace({
			text: expandUsRegion(String(stateNode.value)),
			placetype: "region",
			limit: 1,
		})
		regionBbox = regions[0]?.bbox
	}

	if (postcodeNode?.value) {
		const cs = usable(
			await lookup.findPlace({ text: String(postcodeNode.value), placetype: "postalcode", bbox: regionBbox, limit: 5 })
		)
		if (cs.length > 0) return cs
	}

	const localityHits = await resolveLocality(regionBbox)
	if (localityHits.length > 0) return localityHits

	return usable(await lookup.findPlace({ text: rawText, bbox: regionBbox, limit: 5 }))
}
