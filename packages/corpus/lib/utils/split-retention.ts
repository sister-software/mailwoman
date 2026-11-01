/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The retention vocabulary of the country–shape split policy (HOLDOUT_AND_EVALUATION
 * section 5.1). The ordered-shape key identifies a combination. The independent-group
 * identity counts it once per address record. The split consults the table first.
 * A row covered below the floor stays in training.
 *
 * This module is a leaf: `split.ts` reads it. The supply pass in `#utils/shape-supply`
 * reads both. The graph stays acyclic.
 */

import { recordIDOf } from "#adapters/record-id"

/**
 * The separator between a shape's tags in a retention key, matching the country–shape
 * census representation (#2893, HOLDOUT_AND_EVALUATION section 5.1).
 */
export const SHAPE_SEPARATOR = " -> "

/**
 * The key a retention table is indexed by: the row's country and its ordered shape.
 */
export function shapeKeyOf(country: string, spanTags: readonly string[]): string {
	return `${country}|${spanTags.join(SHAPE_SEPARATOR)}`
}

/**
 * The independent group a row belongs to for retention counting (section 5.1's grouping rule):
 * its augmentation base when one is recorded, else its record id, so every
 * rendered variant of one record counts once.
 */
// repo-health-ignore export-name-affix -- This reads a corpus row's record group.
// license-worker's idOf reads a Stripe-shaped object id.
export function groupIDOf(row: {
	source_id: string
	base_source_id?: string | null
	augmentation?: { base_source_id?: string | null } | null
}): string {
	const base = row.base_source_id || row.augmentation?.base_source_id

	// An augmentation's base holds the row's `#` discriminator, so the record read
	// applies to the coalesced id either way.
	return recordIDOf(base ?? row.source_id)
}

/**
 * One country–shape combination's group supply per split.
 */
export interface ShapeSupplyEntry {
	country: string
	shape: string
	groups: number
	trainGroups: number
	valGroups: number
	testGroups: number
}

/**
 * The retention decision a supply pass registers (section 5.1): a country–shape
 * below the floor keeps every one of its rows in training.
 */
export interface SplitRetention {
	/**
	 * The minimum independent training groups a combination keeps after the holdout.
	 */
	floor: number
	/**
	 * Keys of {@linkcode shapeKeyOf} whose post-holdout training remainder falls
	 * below {@linkcode SplitRetention.floor}.
	 */
	protectedShapes: ReadonlySet<string>
}

/**
 * The rows a supply pass reads: a labeled row's identity, components and ordered spans.
 */
export interface ShapeSupplyRow {
	source_id: string
	country: string
	components: Partial<Record<"venue" | "region" | "postcode" | "locality", string>>
	span_tags: readonly string[]
	base_source_id?: string | null
	augmentation?: { base_source_id?: string | null } | null
}
