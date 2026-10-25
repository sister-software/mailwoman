/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Readers of a Who's On First record's `wof:hierarchy`.
 *
 *   A record lists one hierarchy per parent, as `{ <placetype>_id: <wof id> }` objects. A record with
 *   several parents has `wof:parent_id` -4 and several hierarchies: New York City lists five, one per
 *   county, that agree on everything else. Two consumers read them under different rules. The
 *   gazetteer's ancestry table takes every ancestor that any hierarchy lists. A rendered address takes only
 *   the ancestors every hierarchy shares, so it never writes a county the city does not have.
 */

/**
 * One `wof:hierarchy` entry: an ancestor id per `<placetype>_id` key.
 */
export type WOFHierarchyBranch = Readonly<Record<string, number>>

/**
 * WOF placetypes from nearest to farthest, the order {@linkcode agreedHierarchyAncestors} returns ancestors in.
 */
export const WOF_HIERARCHY_LEVELS = [
	"microhood",
	"neighbourhood",
	"macrohood",
	"borough",
	"locality",
	"localadmin",
	"county",
	"macrocounty",
	"region",
	"macroregion",
	"country",
	"continent",
] as const

/**
 * Returns the placetype a `wof:hierarchy` key names (`region_id` → `region`), or `null` for another key.
 */
export function placetypeFromHierarchyKey(key: string): string | null {
	return key.endsWith("_id") ? key.slice(0, -3) : null
}

/**
 * Returns the branches of a `wof:hierarchy` value, or an empty list when the value is absent or malformed.
 */
function hierarchyBranches(hierarchy: unknown): WOFHierarchyBranch[] {
	if (!Array.isArray(hierarchy)) return []

	const branches = hierarchy.filter(
		(branch): branch is WOFHierarchyBranch => !!branch && typeof branch === "object" && !Array.isArray(branch)
	)

	return branches.length === hierarchy.length ? branches : []
}

function isAncestorID(value: unknown, id: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value !== id
}

/**
 * Returns every ancestor any of a record's hierarchies names, each with its placetype, in first-seen order.
 */
export function hierarchyAncestorsInAnyBranch(id: number, hierarchy: unknown): Map<number, string> {
	const seen = new Map<number, string>()

	for (const branch of hierarchyBranches(hierarchy)) {
		for (const [key, value] of Object.entries(branch)) {
			const placetype = placetypeFromHierarchyKey(key)

			if (placetype && isAncestorID(value, id) && !seen.has(value)) {
				seen.set(value, placetype)
			}
		}
	}

	return seen
}

/**
 * Returns the ancestor ids every one of a record's hierarchies agrees on, nearest level first.
 *
 * A level the hierarchies disagree on, such as New York City's county, is left out.
 * The levels they share are the record's ancestors whichever parent applies.
 */
export function agreedHierarchyAncestors(id: number, hierarchy: unknown): number[] {
	const branches = hierarchyBranches(hierarchy)

	if (!branches.length) return []

	const out: number[] = []

	for (const level of WOF_HIERARCHY_LEVELS) {
		const values = new Set(branches.map((branch) => branch[`${level}_id`]))

		if (values.size !== 1) continue

		const [value] = values

		if (isAncestorID(value, id)) {
			out.push(value)
		}
	}

	return out
}
