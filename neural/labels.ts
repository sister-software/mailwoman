/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mirror of `packages/corpus-python/src/mailwoman_train/labels.py`.
 *
 *   Index ↔ label parity is load-bearing: the model emits logits in one canonical order on both sides
 *   and any drift here silently corrupts BIO decoding. STAGE2 strictly extends STAGE1 — the first
 *   15 indices are identical, so reading a v0.2.0 (Stage 1) model with the Stage 2 label vocabulary
 *   stays correct; the extra entries are unused.
 *
 *   Runtime loading: as of v0.4.0 the trained label vocabulary is carried in `model-card.json`'s
 *   `labels` field and read by `loadFromWeights` (see `weights.readLabelsFromModelCard`). These
 *   constants remain the compile-time fallback for legacy bundles whose cards predate the field —
 *   safe because such bundles are by construction Stage 1 or Stage 2, and Stage 2 prefix-extends
 *   Stage 1. A future Stage 3 ship will not be safe under the fallback; the loader treats a missing
 *   `labels` field as "you are loading a pre-v0.4.0 bundle" rather than "unknown stage".
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

/**
 * Fine-grained tags added in Phase 2 Stage 2 (v0.3.0). venue covers organization/POI/landmark
 * names; street + house_number break out the street-address components that Stage 1 collapsed to
 * `O`.
 */
export const STAGE2_FINE_TAGS = ["venue", "street", "house_number"] as const

/** Stage 2 ships the full coarse + fine set in the order STAGE2_BIO_LABELS is interleaved. */
export const STAGE2_TAGS = [...STAGE1_COARSE_TAGS, ...STAGE2_FINE_TAGS] as const

/**
 * BIO label vocabulary for Stage 2 (v0.3.0) — O + (B-/I- per Stage 2 tag). 1 + 20 = 21 labels.
 *
 * Index parity vs Stage 1: STAGE2_BIO_LABELS[i] === STAGE1_BIO_LABELS[i] for i ∈ [0, 15). Anyone
 * loading a Stage 1 model with this vocabulary still decodes correctly; the tail (15..20) just
 * never gets argmax'd because Stage 1 only emits 15 logits.
 */
export const STAGE2_BIO_LABELS: readonly BioLabel[] = Object.freeze([
	"O" as BioLabel,
	...STAGE2_TAGS.flatMap((tag) => [`B-${tag}` as BioLabel, `I-${tag}` as BioLabel]),
])

export const STAGE3_FINE_TAGS = [
	"street_prefix",
	"street_suffix",
	"unit",
	"po_box",
	"intersection_a",
	"intersection_b",
] as const

export const STAGE3_TAGS = [...STAGE2_TAGS, ...STAGE3_FINE_TAGS] as const

export const STAGE3_BIO_LABELS: readonly BioLabel[] = Object.freeze([
	"O" as BioLabel,
	...STAGE3_TAGS.flatMap((tag) => [`B-${tag}` as BioLabel, `I-${tag}` as BioLabel]),
])
