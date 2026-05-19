/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mirror of `packages/corpus-python/src/mailwoman_train/labels.py::STAGE1_BIO_LABELS`.
 *
 *   The v0.1.0 / v0.2.0 weight packages were trained with this exact label order. Any drift here
 *   silently corrupts downstream BIO decoding — index 5 must mean `B-locality` on both sides.
 *
 *   Stage 2+ models will support more labels (street, house_number, venue, …). The plan is to plumb
 *   the label set through `model-card.json` at load time rather than hard-coding it here. Until
 *   then this file is the source of truth on the TS side.
 */

import type { BioLabel } from "@mailwoman/core/decoder"

/** Coarse component tags trained in Phase 2 Stage 1 (v0.1.0 / v0.2.0). */
export const STAGE1_COARSE_TAGS = [
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",
	"cedex",
] as const

/** BIO label vocabulary for Stage 1 — O + (B-/I- per coarse tag). 1 + 14 = 15 labels. */
export const STAGE1_BIO_LABELS: readonly BioLabel[] = Object.freeze([
	"O" as BioLabel,
	...STAGE1_COARSE_TAGS.flatMap((tag) => [`B-${tag}` as BioLabel, `I-${tag}` as BioLabel]),
])
