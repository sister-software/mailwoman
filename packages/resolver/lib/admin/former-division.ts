// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A `subregion` or `region` value that's the name of a former division, such as the county of Avon
 *   (1974 to 1996) in `34 Coldharbour Rd, Redland, Avon, Bristol BS6 7NA`.
 *
 *   No current division answers the value, so the walk keeps no place for it and scopes no lookup by it.
 *   After the walk, the value is accepted when a former division of that name is linked, by the
 *   containment evidence the former-divisions table records, to a place in the resolved locality's
 *   lineage. An accepted node is stamped {@link FORMER_DIVISION} and keeps no place, so it moves no result.
 *   A value that no linked former division explains keeps the walk's result unchanged.
 */

import { type AddressNode, collectNodes } from "@mailwoman/core/decoder"
import { type Ancestor, type FormerDivisionMatch, wofIDFromPlaceID } from "@mailwoman/core/resolver"

/**
 * The metadata key an accepted node's stamp is stored under.
 */
export const FORMER_DIVISION = "former_division"

/**
 * The tags a former division can stand in.
 */
export const FORMER_DIVISION_TAGS: ReadonlySet<string> = new Set(["subregion", "region"])

/**
 * The resolved tags whose lineage a former division is checked against.
 */
const SETTLEMENT_TAGS: ReadonlySet<string> = new Set(["locality", "dependent_locality", "municipality", "district"])

/**
 * What an accepted node's stamp records: the division and the resolved place it's linked through.
 */
export interface FormerDivisionStamp {
	name: string
	country: string
	kind: string
	geonames_id: number | null
	wof_id: number | null
	evidence: readonly string[]
	/**
	 * The resolved place whose lineage holds a place the division covered.
	 */
	linked_place: string
	/**
	 * The WOF id in that lineage the division is linked to.
	 */
	linked_id: number
}

/**
 * The first match linked to a resolved settlement's lineage, with that settlement and the linked id.
 */
function linkedMatch(
	matches: readonly FormerDivisionMatch[],
	settlements: readonly AddressNode[],
	ancestors: (id: number) => readonly Ancestor[]
): { match: FormerDivisionMatch; place: string; id: number } | null {
	for (const settlement of settlements) {
		const id = wofIDFromPlaceID(settlement.placeID ?? null)

		if (id == null) continue

		const lineage = [id, ...ancestors(id).map((a) => Number(a.id))]

		for (const match of matches) {
			const linked = lineage.find((candidate) => match.linkedIDs.has(candidate))

			if (linked != null) return { match, place: settlement.placeID!, id: linked }
		}
	}

	return null
}

/**
 * Stamps each pending node whose former division is linked to the tree's resolved settlement.
 *
 * `pending` maps a walked node that no current division answered to the former divisions its value names.
 * It returns the number of nodes stamped.
 */
export function acceptFormerDivisions(
	roots: readonly AddressNode[],
	pending: ReadonlyMap<AddressNode, readonly FormerDivisionMatch[]>,
	ancestors: (id: number) => readonly Ancestor[]
): number {
	if (!pending.size) return 0

	const settlements = collectNodes(roots, (n) => SETTLEMENT_TAGS.has(n.tag) && n.placeID != null)
	let accepted = 0

	for (const node of collectNodes(roots, (n) => pending.has(n))) {
		const found = linkedMatch(pending.get(node)!, settlements, ancestors)

		if (!found) continue

		const stamp: FormerDivisionStamp = {
			name: found.match.name,
			country: found.match.country,
			kind: found.match.kind,
			geonames_id: found.match.geonamesID,
			wof_id: found.match.wofID,
			evidence: found.match.evidence,
			linked_place: found.place,
			linked_id: found.id,
		}

		node.metadata = { ...node.metadata, [FORMER_DIVISION]: stamp }

		accepted++
	}

	return accepted
}
