/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canonical address component schema for the neural classifier pipeline.
 *
 *   Any change here requires:
 *
 *   1. A written rationale in the commit message.
 *   2. A migration plan for corpus rows tagged with the prior schema.
 *   3. A same-commit check that alignment, training and inference code matches the new schema.
 */

/**
 * The canonical address component tag union, ordered by phase and locale.
 */
export const COMPONENT_TAGS = [
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",

	"house_number",
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"intersection_a",
	"intersection_b",
	"unit",

	"venue",
	"attention",
	"po_box",

	"cedex",

	"prefecture",
	"municipality",
	"district",
	"block",
	"sub_block",
	"building_number",
	"building_name",
	// CN-specific: the organizational ladder used below the head in China's rural addresses
	// unit settlement, with one contiguous span holding the whole ordinal chain.
	"locality_unit",
] as const

/**
 * Union of every recognized address component tag.
 */
export type ComponentTag = (typeof COMPONENT_TAGS)[number]

/**
 * BIO-encoded label set with one `O` plus a `B-` and `I-` pair per tag.
 */
export const BIO_LABELS = ["O", ...COMPONENT_TAGS.flatMap((tag) => [`B-${tag}`, `I-${tag}`] as const)] as const

/**
 * Union of every BIO label.
 */
export type BIOLabel = (typeof BIO_LABELS)[number]

/**
 * The tag in a BIO label after removing its `B-` or `I-` prefix.
 * The function returns `O` unchanged.
 */
export function bareBIOTag(label: string): string {
	return label.replace(/^[BI]-/u, "")
}

/**
 * The street-name family in assembly order.
 * That order is part of the interface.
 */
export const STREET_FAMILY_TAGS = [
	"street_prefix",
	"street_prefix_particle",
	"street",
	"street_suffix",
] as const satisfies readonly ComponentTag[]
