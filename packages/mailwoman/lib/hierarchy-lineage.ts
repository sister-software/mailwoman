/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-node lineage provenance for the result `hierarchy`.
 *
 *   The `hierarchy` array is assembled from independently resolved parse nodes: the parsed region
 *   resolves on its own and contributes its entry beside the locality winner, whether or not any
 *   place on earth has that containment chain. Silently mixing the winner's lineage with
 *   independently resolved fragments is the defect, and this module makes the mixing explicit.
 *
 *   Each entry gains a tri-state `in_winner_lineage`:
 *
 *   - `true`: the winner's own ancestors sidecar vouches for this entry, or the entry is the winner.
 *   - `false`: the entry resolved independently to a place outside the winner's containment chain.
 *   - absent: no sidecar to ask (the backend or artifact carries no `ancestors()`), or the entry has
 *     no place identity. Absence reads as "unverifiable" rather than "false", per the meaning-of-zero
 *     rule.
 *
 *   The winner-chain-as-hierarchy representation belongs to the stage-2 containment re-rank, where
 *   the winner's chain becomes the natural assembly. Until then the shipped shape keeps its
 *   parse-anchored entries and states each one's standing.
 */

/**
 * One link of the winner's stamped lineage.
 *
 * The id-containing subset of `@mailwoman/core`'s `Ancestor` (declared locally
 * so this module stays decoder/resolver-import-free, the `admin-coherence.ts` posture).
 */
interface LineageAncestor {
	id: number | string
}

/**
 * The subset of a resolved-tree node the assembly reads, structurally satisfied
 * by the decorated `AddressNode`.
 */
export interface HierarchySourceNode {
	tag: string
	value: string
	lat?: number | undefined
	lon?: number | undefined
	placeID?: string | undefined
	metadata?: Record<string, unknown> | undefined
}

/**
 * One `GeocodeResult.hierarchy` entry, locality → country (most specific first).
 */
export interface HierarchyEntry extends HierarchyLineageEntry {
	tag: string
	value: string
	name: string
	lat?: number
	lon?: number
}

/**
 * The admin tags the hierarchy admits, most specific first.
 *
 * The JP tiers (`municipality`, `district`, `prefecture`) sit beside their Latin
 * counterparts in the order the admin ladder uses.
 * `municipality` above `district`, because the anchor below is graded on lineage
 * and an unscoped district can resolve a namesake.
 */
const HIERARCHY_TAGS = [
	"locality",
	"municipality",
	"dependent_locality",
	"district",
	"subregion",
	"region",
	"prefecture",
	"country",
]

/**
 * The most-specific resolved admin node, the lineage anchor for tiers without an admin-ladder pick.
 *
 * Anchoring at the deepest resolved entry grades ancestors, which its chain does contain,
 * and can never falsely flag a descendant.
 */
export function lineageAnchorNode(nodes: readonly HierarchySourceNode[]): HierarchySourceNode | undefined {
	for (const tag of HIERARCHY_TAGS) {
		const node = nodes.find((n) => n.tag === tag && n.placeID)

		if (node) return node
	}

	return undefined
}

/**
 * Assemble the result `hierarchy` from the resolved tree's admin nodes and annotate each
 * entry's lineage standing against `anchor` (see {@link annotateHierarchyLineage}).
 *
 * `streetLocality` is the register commune: on a street-tier result with no locality
 * entry it fills the locality slot, because a street-tier `city` must come from
 * the register rather than a token of the street name.
 * It carries no place identity, so it is never lineage-graded.
 */
export function assembleHierarchy(
	nodes: readonly HierarchySourceNode[],
	streetLocality: string | null,
	anchor: LineageAnchor | undefined
): HierarchyEntry[] {
	const hierarchy: HierarchyEntry[] = nodes
		.filter((n) => HIERARCHY_TAGS.includes(n.tag) && (n.lat != null || n.placeID))
		.toSorted((a, b) => HIERARCHY_TAGS.indexOf(a.tag) - HIERARCHY_TAGS.indexOf(b.tag))
		.map((n) => ({
			tag: n.tag,
			value: n.value.trim(),
			// The resolver stamps the gazetteer's canonical name (proper casing) on `resolver_name`,
			// and this falls back to the raw parsed span when a node resolved without one.
			// Consumers should display this rather than `value`.
			name: (n.metadata?.["resolver_name"] as string | undefined)?.trim() || n.value.trim(),
			...(n.lat != null ? { lat: n.lat, lon: n.lon! } : {}),
			...(n.placeID ? { placeID: n.placeID } : {}),
		}))

	if (streetLocality && !hierarchy.some((h) => h.tag === "locality" || h.tag === "dependent_locality")) {
		hierarchy.unshift({ tag: "locality", value: streetLocality, name: streetLocality })
	}

	annotateHierarchyLineage(hierarchy, anchor)

	return hierarchy
}

/**
 * A hierarchy entry as `extractGeocodeResult` builds it, reduced to what the annotation reads and writes.
 */
export interface HierarchyLineageEntry {
	placeID?: string | undefined
	in_winner_lineage?: boolean
}

/**
 * The winner node the entries are graded against.
 *
 * The admin-ladder pick, or the primary resolved node on street-backed tiers
 * (the same anchor `adminCoherenceField` uses).
 */
export interface LineageAnchor {
	placeID?: string | undefined
	metadata?: Record<string, unknown> | undefined
}

/**
 * Annotate `entries` in place with `in_winner_lineage` against `anchor`'s stamped ancestor chain.
 *
 * Grading is by place identity (`wof:<id>`) rather than name.
 * A name match across instances is exactly the confusion the field exists to expose.
 *
 * Without a sidecar only the anchor's own entry can be vouched for.
 * Every other entry stays ungraded rather than guessed.
 */
export function annotateHierarchyLineage(
	entries: readonly HierarchyLineageEntry[],
	anchor: LineageAnchor | undefined
): void {
	if (!anchor?.placeID) return

	const ancestors = anchor.metadata?.["ancestors"] as readonly LineageAncestor[] | undefined

	const lineage = new Set<string>([anchor.placeID])

	for (const a of ancestors ?? []) {
		lineage.add(`wof:${a.id}`)
	}

	for (const entry of entries) {
		if (!entry.placeID) continue

		if (lineage.has(entry.placeID)) {
			entry.in_winner_lineage = true
		} else if (ancestors !== undefined) {
			// Only a present sidecar can testify to absence.
			// Without one, "not in the set" is ignorance.
			entry.in_winner_lineage = false
		}
	}
}
