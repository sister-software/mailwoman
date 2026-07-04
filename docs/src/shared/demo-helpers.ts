/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared helpers for the Mailwoman demo — types, constants, and utility functions used by both the
 *   PipelineExplorer embeddable component and the full demo page.
 */

// STATIC on purpose: a dynamic-import destructure of this barrel gets tree-shaken by webpack's
// usedExports analysis (httpvfs-resolver statically imports only expandPlacetypeFilter from it),
// which shipped the demo's WOF cascade as `TypeError: i is not a function` — invisible for days
// behind the manifest wire-key bug. Static named imports are fully analyzable; do not re-dynamize.
import { createWOFResolver } from "@mailwoman/resolver/resolve"

import { CandidateResolverBackend } from "./candidate-resolver-backend.ts"
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
	hasFST: boolean
	hasWOFDb: boolean
	hasAnchor?: boolean
	hasPolygons?: boolean
}

export interface ReleasesManifest {
	locale: string
	defaultVersion: string
	releases: ReleaseInfo[]
}

/** The raw wire shape of one releases.json entry — either key generation may appear. */
interface WireReleaseEntry extends Omit<ReleaseInfo, "hasFST" | "hasWOFDb"> {
	hasFST?: boolean
	hasWOFDb?: boolean
	/** Pre-2026-07-04 manifests published lowercase-acronym keys. */
	hasFst?: boolean
	hasWofDb?: boolean
}

/**
 * Normalize a fetched releases.json into house-cased {@link ReleasesManifest} fields. ALL manifest consumption goes
 * through here — the wire tolerance lives in exactly one place, and everything past this boundary uses the acronym
 * convention (`hasFST` / `hasWOFDb`).
 *
 * Why the tolerance: the 2026-07-01 acronym sweep renamed the READS while the published R2 manifest kept the old keys —
 * every release read `undefined`, silently disabling the demo's WOF cascade AND the FST for three days (zero console
 * errors; "no WOF hits" was the only symptom). The fix is not to freeze the wire keys but to migrate them deliberately:
 * the publisher now writes house-cased keys, this normalizer accepts both generations (old HF mirrors still carry the
 * legacy keys), and the contract test pins all three parties.
 */
export function normalizeReleasesManifest(raw: {
	locale: string
	defaultVersion: string
	releases: WireReleaseEntry[]
}): ReleasesManifest {
	return {
		locale: raw.locale,
		defaultVersion: raw.defaultVersion,
		releases: raw.releases.map((r) => ({
			...r,
			hasFST: r.hasFST ?? r.hasFst ?? false,
			hasWOFDb: r.hasWOFDb ?? r.hasWofDb ?? false,
		})),
	}
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
 * USPS two-letter codes → full state name. A bare "IL" FTS-matches "Ille-et-Vilaine" (a French département) before
 * "Illinois", so its France bbox filters out the actual US city — expanding to the full name resolves the right region.
 * Full names pass through unchanged.
 */
export function expandUsRegion(text: string): string {
	return US_STATE_ABBREV[text.trim().toUpperCase()] ?? text
}

// ---------------------------------------------------------------------------
// Tree flattening
// ---------------------------------------------------------------------------

/**
 * Flatten a solver tree into source-order nodes. Depth-first appended in reverse; flip for source order.
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
 * Browser-safe twin of `@mailwoman/core/decoder/calibration`'s `createCalibrator`. The canonical lives in core for the
 * Node parse path; we can't import it into the docs webpack bundle (the `core/decoder` barrel pulls in node-only
 * siblings like `build-tree`, and the deep subpath isn't a published export), so the ~15-line piecewise-linear interp
 * is mirrored here verbatim. Keep the two in sync — both are pure, monotone, and clamp to the table's range outside
 * it.
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
// WOF resolution — the shared resolver over the demo's candidate lookup (#861)
// ---------------------------------------------------------------------------

/**
 * How the demo picks THE pin from a resolved tree: prefer the most address-precise resolved node. Same ordering the
 * eval harnesses use; `postalcode` outranks `locality` (the old cascade's "postcode first, most precise" tier), peers
 * of locality sit just below it.
 */
const PIN_RANK: Record<string, number> = {
	postalcode: 6,
	locality: 5,
	borough: 4,
	localadmin: 4,
	neighbourhood: 4,
	county: 3,
	macrocounty: 3,
	region: 2,
	macroregion: 2,
	country: 1,
}

type CascadeHits = Awaited<ReturnType<MailwomanLookupLike["findPlace"]>>

/** Minimal structural view of a decorated `AddressTree` node (decoupled from core's types). */
interface ResolvedTreeNode {
	source?: string
	sourceID?: string
	value?: unknown
	lat?: number
	lon?: number
	placeID?: string
	metadata?: Record<string, unknown>
	alternatives?: unknown[]
	children?: ResolvedTreeNode[]
}

/**
 * Admin resolution for the demo (#861): run the SHARED `@mailwoman/resolver` `resolveTree` — the greedy walk + admin
 * descendant-coherence (#263/#267) + explicit-country coherence (#822) + the span-rescore recovery (#370) — over the
 * byte-range candidate lookup, via {@link CandidateResolverBackend}. This replaced the bespoke postcode→locality→raw
 * cascade that re-implemented the resolver's tier order beside it and silently trailed its joint-consistency passes
 * (the server↔demo parity gap #861 measured).
 *
 * Returns hits in the shape the map UI consumes: the pin first (most address-precise resolved node), then its runner-up
 * candidates, then the other resolved admin nodes for hierarchy context. Falls back to a raw-text lookup when nothing
 * in the tree resolves — same last-resort the old cascade had. Drops (lat=0, lon=0) placeholder hits throughout.
 */
/** Soft proximity hints (#938 `bias[]`): ordered, weighted, never a hard filter. */
export type ResolveBias = Array<{ lat: number; lon: number; weight?: number }>

export async function runCascade(
	lookup: MailwomanLookupLike,
	tree: { roots: unknown[] },
	rawText: string,
	bias?: ResolveBias
): Promise<CascadeHits> {
	const usable = (cs: CascadeHits): CascadeHits => cs.filter((c) => !(c.lat === 0 && c.lon === 0))

	const backend = new CandidateResolverBackend(lookup)
	const resolver = createWOFResolver(backend as never)

	// adminCoherence is the point of the convergence (the passes the old cascade approximated);
	// spanRescore + hierarchyCompletion ride their shared defaults. No defaultCountry — the demo is
	// global by design (the placer/population ranking routes, never a hardcoded country).
	// bias (#938): the map viewport (and optional geolocation) as SOFT proximity hints — an in-view
	// namesake sorts ahead of a distant one at equal exact-tier, and no-bias stays byte-identical
	// (48026 → Fraser MI vs Russi IT, the rule the library gate pins). Omitted when empty.
	const resolved = (await resolver.resolveTree(tree as never, {
		adminCoherence: true,
		...(bias && bias.length > 0 ? { bias } : {}),
	})) as unknown as {
		roots: ResolvedTreeNode[]
	}

	// Collect every resolver-decorated node, best-pin first.
	const collected: Array<{ hit: CascadeHits[number]; rank: number }> = []
	const alternativesOf = new Map<number, CascadeHits>()

	const visit = (node: ResolvedTreeNode): void => {
		if (node.source === "resolver" && node.sourceID && typeof node.lat === "number" && typeof node.lon === "number") {
			const sep = node.sourceID.indexOf(":")
			const placetype = sep === -1 ? node.sourceID : node.sourceID.slice(0, sep)
			const id = Number(node.placeID?.replace(/^wof:/, "") ?? node.sourceID.slice(sep + 1))
			const meta = backend.metaFor(id)
			const hit: CascadeHits[number] = {
				id,
				name: String(node.metadata?.["resolver_name"] ?? node.value ?? ""),
				placetype,
				country: meta?.country,
				lat: node.lat,
				lon: node.lon,
				score: typeof node.metadata?.["resolver_score"] === "number" ? (node.metadata["resolver_score"] as number) : 0,
				exactMatch: true,
				bbox: meta?.bbox,
			}

			if (!(hit.lat === 0 && hit.lon === 0)) {
				collected.push({ hit, rank: PIN_RANK[placetype] ?? 0 })

				const alts = (node.alternatives as Array<Record<string, unknown>> | undefined) ?? []

				alternativesOf.set(
					id,
					usable(
						alts.map((a) => ({
							id: Number(a.id),
							name: String(a.name ?? ""),
							placetype: String(a.placetype ?? placetype),
							country: typeof a.country === "string" && a.country ? a.country : undefined,
							lat: Number(a.lat),
							lon: Number(a.lon),
							score: typeof a.score === "number" ? a.score : 0,
							exactMatch: a.exactMatch === true,
							bbox: backend.metaFor(Number(a.id))?.bbox,
						}))
					)
				)
			}
		}

		for (const child of node.children ?? []) visit(child)
	}

	for (const root of resolved.roots) visit(root)

	if (collected.length === 0) {
		// Nothing in the tree resolved (span-rescore included) — the old cascade's last resort.
		return usable(await lookup.findPlace({ text: rawText, limit: 5 }))
	}

	collected.sort((a, b) => b.rank - a.rank || b.hit.score - a.hit.score)

	// Cross-country postcode gate, carried over from the old cascade: an ambiguous INTERNATIONAL
	// postcode (10115 = Berlin DE and a New York US ZIP shape) must not out-pin the parsed city
	// across countries. When the top pin is a postcode whose country differs from the resolved
	// locality's, the locality wins the pin; the postcode stays in the list.
	const top = collected[0]!
	const localityEntry = collected.find((c) => c.rank === 5 || c.rank === 4)

	let pinOrder = collected

	if (
		top.hit.placetype === "postalcode" &&
		localityEntry &&
		top.hit.country &&
		localityEntry.hit.country &&
		top.hit.country !== localityEntry.hit.country
	) {
		pinOrder = [localityEntry, ...collected.filter((c) => c !== localityEntry)]
	}

	const seen = new Set<number>()
	const hits: CascadeHits = []

	for (const { hit } of pinOrder) {
		if (!seen.has(hit.id)) {
			seen.add(hit.id)
			hits.push(hit)
		}

		for (const alt of alternativesOf.get(hit.id) ?? []) {
			if (!seen.has(alt.id)) {
				seen.add(alt.id)
				hits.push(alt)
			}
		}
	}

	return hits
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
	 * Calibrated uncertainty radius in meters (10 m situs floor; interp = uncertaintyM × the region factor).
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
 * Street tier: exact situs point first (10 m floor), then TIGER interpolation (honest calibrated radius), else null so
 * the caller falls back to the admin cascade ({@link runCascade}). Mirrors the node `geocode-core` tier order
 * (address_point > interpolated > admin) — but async, on the main thread, over the demo's httpvfs handles.
 * `interpRadiusCalibration` is the per-region conformal factor (#374 / data/calibration/interp-radius-conformal.json);
 * default 1.95 (the conservative national default — under-coverage is the harmful error).
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

	if (!st || !num) return null

	// not a street-level query — let the admin cascade handle it

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
