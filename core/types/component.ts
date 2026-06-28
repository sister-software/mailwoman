/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Canonical address component schema for the neural classifier pipeline.
 *
 *   This file is the single source of truth for `ComponentTag`. Any change here requires (per #5 of
 *   the Mailwoman Neural plan):
 *
 *   1. A written rationale in the commit message.
 *   2. A migration plan for corpus rows tagged with the prior schema.
 *   3. A same-commit check that alignment, training, and inference code is updated to match.
 *
 *   The legacy `Classifications` set in `../classification/scheme.ts` is kept independent on purpose:
 *   rule classifiers continue to emit those, the neural classifier emits these. The bridge between
 *   the two lives in the adapter layer (see #6).
 */

/**
 * The canonical address component tag union, ordered by phase and locale.
 *
 * - Universal (Phase 1): country, region, locality, dependent_locality, postcode, subregion
 * - Street-level (Phase 2): house_number, street, street_prefix*, street_suffix, intersection_a/b, unit
 * - Venue-level (Phase 3): venue, attention, po_box
 * - FR-specific: cedex
 * - JP-specific (Phase 6, declared but unused before then): prefecture, municipality, district, block, sub_block,
 *   building_number, building_name
 */
export const COMPONENT_TAGS = [
	// Universal
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",
	// Street-level
	"house_number",
	"street",
	"street_prefix",
	"street_prefix_particle",
	"street_suffix",
	"intersection_a",
	"intersection_b",
	"unit",
	// Venue-level
	"venue",
	"attention",
	"po_box",
	// FR-specific
	"cedex",
	// JP-specific (Phase 6 — declared but unused until then)
	"prefecture",
	"municipality",
	"district",
	"block",
	"sub_block",
	"building_number",
	"building_name",
] as const

/** Union of every recognized address component tag. */
export type ComponentTag = (typeof COMPONENT_TAGS)[number]

/**
 * BIO-encoded label set: one `O` plus a `B-` / `I-` pair per tag.
 *
 * Used as the per-token output alphabet for the sequence-labeling neural model. Inference decodes a stream of these
 * back into character-aligned `ClassificationProposal`s.
 */
export const BIO_LABELS = ["O", ...COMPONENT_TAGS.flatMap((tag) => [`B-${tag}`, `I-${tag}`] as const)] as const

/** Union of every BIO label. */
export type BioLabel = (typeof BIO_LABELS)[number]
