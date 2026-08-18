/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1731 — per-node lineage provenance for the result `hierarchy`.
 *
 *   The `hierarchy` array is assembled from INDEPENDENTLY resolved parse nodes: the parsed region resolves on its own
 *   and contributes its entry beside the locality winner, whether or not any place on earth has that containment chain.
 *   The recorded instance: `24 37 42nd St, Astoria, NY 11103` shipped a hierarchy of Astoria-the-OREGON-locality under
 *   New-York-the-region — two correct-looking fragments composing a chain that exists nowhere. Silently mixing the
 *   winner's lineage with independently resolved fragments is the defect; this module makes the mixing explicit.
 *
 *   Each entry gains a tri-state `in_winner_lineage`:
 *
 *   - `true` — the winner's own ancestors sidecar vouches for this entry (or the entry IS the winner).
 *   - `false` — the entry resolved independently to a place OUTSIDE the winner's containment chain: the chimera
 *     fragment, and the statement the #1722 account layer reads as "parsed region resolved independently to X; winner
 *     sits in Y".
 *   - ABSENT — no sidecar to ask (the backend/artifact carries no `ancestors()`), or the entry has no place identity.
 *     Absence is "unverifiable", never "false" (the meaning-of-zero rule).
 *
 *   The winner-chain-AS-hierarchy representation (the issue's other sanctioned close) belongs to the #1717 stage-2
 *   containment re-rank, where the winner's chain becomes the natural assembly; until then the shipped shape keeps its
 *   parse-anchored entries and states each one's standing.
 */

/**
 * One link of the winner's stamped lineage — the id-bearing slice of `@mailwoman/core`'s `Ancestor` (declared locally
 * so this module stays decoder/resolver-import-free, the `admin-coherence.ts` posture).
 */
interface LineageAncestor {
	id: number | string
}

/**
 * A resolved-tree node slice the assembly reads — structurally satisfied by the decorated `AddressNode`.
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

const HIERARCHY_TAGS = ["locality", "dependent_locality", "subregion", "region", "country"]

/**
 * Assemble the result `hierarchy` from the resolved tree's admin nodes and annotate each entry's lineage standing
 * against `anchor` (see {@link annotateHierarchyLineage}).
 *
 * `streetLocality` is the #1058 register commune: on a street-tier result with no locality entry it fills the locality
 * slot, because a street-tier `city` must come from the register, never from a token of the street name. It carries no
 * place identity, so it is never lineage-graded.
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
			// The resolver stamps the gazetteer's canonical name (proper casing) on `resolver_name`; fall back to the raw
			// parsed span when a node resolved without one. #1014: consumers should DISPLAY this, not `value`.
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
 * The winner node the entries are graded against — the admin-ladder pick, or the primary resolved node on street-backed
 * tiers (the same anchor `adminCoherenceField` uses).
 */
export interface LineageAnchor {
	placeID?: string | undefined
	metadata?: Record<string, unknown> | undefined
}

/**
 * Annotate `entries` in place with `in_winner_lineage` against `anchor`'s stamped ancestor chain.
 *
 * Grading is by place identity (`wof:<id>`), never by name — a name match across instances is exactly the confusion the
 * field exists to expose. Without a sidecar only the anchor's own entry can be vouched for; every other entry stays
 * ungraded rather than guessed.
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
			// Only a PRESENT sidecar can testify to absence — without one, "not in the set" is ignorance.
			entry.in_winner_lineage = false
		}
	}
}
