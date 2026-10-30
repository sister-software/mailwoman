/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The label sets the trainer reads through `data/label-schema.v1.json`.
 *
 *   Index ↔ label parity is essential. The model emits logits in one canonical order on both sides.
 *   Any drift silently corrupts BIO decoding. STAGE2 strictly extends STAGE1. The first
 *   15 indices are identical, so reading a v0.2.0 (Stage 1) model with the Stage 2 label vocabulary
 *   stays correct. the extra entries are unused.
 *
 *   Runtime loading: as of v0.4.0 the trained label vocabulary is stored in `model-card.json`'s
 *   `labels` field and read by `loadFromWeights` (see `weights.readLabelsFromModelCard`). These
 *   constants remain the compile-time fallback for legacy bundles whose cards predate the field —
 *   safe because such bundles are by construction Stage 1 or Stage 2. Stage 2 prefix-extends
 *   Stage 1. A future Stage 3 ship will not be safe under the fallback. The loader treats a missing
 *   `labels` field as "you are loading a pre-v0.4.0 bundle" rather than "unknown stage".
 */

import type { BIOLabel } from "@mailwoman/codex/component"

/**
 * Coarse component tags trained in Phase 2 Stage 1 (v0.1.0 / v0.2.0).
 */
export const STAGE1_COARSE_TAGS = [
	"country",
	"region",
	"locality",
	"dependent_locality",
	"postcode",
	"subregion",
	"cedex",
] as const

/**
 * BIO label vocabulary for Stage 1 — O + (B-/I- per coarse tag). 1 + 14 = 15 labels.
 */
export const STAGE1_BIO_LABELS: readonly BIOLabel[] = Object.freeze([
	"O" as BIOLabel,
	...STAGE1_COARSE_TAGS.flatMap((tag) => [`B-${tag}` as BIOLabel, `I-${tag}` as BIOLabel]),
])

/**
 * Fine-grained tags added in Phase 2 Stage 2 (v0.3.0).
 *
 * Venue covers organization/POI/landmark names.
 * Street + house_number break out the street-address components that Stage 1 collapsed to `O`.
 */
export const STAGE2_FINE_TAGS = ["venue", "street", "house_number"] as const

/**
 * Stage 2 ships the full coarse + fine set in the order STAGE2_BIO_LABELS is interleaved.
 */
export const STAGE2_TAGS = [...STAGE1_COARSE_TAGS, ...STAGE2_FINE_TAGS] as const

/**
 * BIO label vocabulary for Stage 2 (v0.3.0) — O + (B-/I- per Stage 2 tag). 1 + 20 = 21 labels.
 *
 * Index parity vs Stage 1: STAGE2_BIO_LABELS[i] === STAGE1_BIO_LABELS[i] for i ∈ [0, 15). Anyone loading a Stage 1 model with this vocabulary still decodes correctly. The tail (15..20) just never gets argmax'd because Stage 1 only emits 15 logits.
 */
export const STAGE2_BIO_LABELS: readonly BIOLabel[] = Object.freeze([
	"O" as BIOLabel,
	...STAGE2_TAGS.flatMap((tag) => [`B-${tag}` as BIOLabel, `I-${tag}` as BIOLabel]),
])

/**
 * Tags stage 3 adds on top of stage 2 — the fine-grained subdivisions the later curriculum introduces.
 */
export const STAGE3_FINE_TAGS = [
	"street_prefix",
	"street_suffix",
	"unit",
	"po_box",
	"intersection_a",
	"intersection_b",
] as const

/**
 * The full stage-3 tag set: everything stage 2 emitted, plus the fine tags.
 */
export const STAGE3_TAGS = [...STAGE2_TAGS, ...STAGE3_FINE_TAGS] as const

/**
 * Stage-3 tags expanded into BIO labels.
 * The decoder scores against this form.
 */
export const STAGE3_BIO_LABELS: readonly BIOLabel[] = Object.freeze([
	"O" as BIOLabel,
	...STAGE3_TAGS.flatMap((tag) => [`B-${tag}` as BIOLabel, `I-${tag}` as BIOLabel]),
])

/**
 * The secondary-address tags stage 4 adds: designator and id pairs for units, levels
 * and buildings, and the EU entrance and staircase forms.
 *
 * The set is defined but inactive.
 * No checkpoint has a stage-4 head, and these tags are absent from the codex `ComponentTag` union.
 *
 * A corpus row carrying one collapses to `O` when the model trains on stage 3.
 */
export const STAGE4_FINE_TAGS = [
	"unit_designator",
	"level_designator",
	"level_id",
	"building_designator",
	"building_id",
	"entrance",
	"staircase",
] as const

/**
 * The full stage-4 tag set: stage 3 followed by the secondary-address tags.
 */
export const STAGE4_TAGS = [...STAGE3_TAGS, ...STAGE4_FINE_TAGS] as const

/**
 * The seven JP tags: the admin ladder (prefecture, municipality, district) and the parts
 * of the long kanji-designator number form, with the romaji building name.
 * The JP character model trains on `stage3-jp`.
 */
export const JP_FINE_TAGS = [
	"prefecture",
	"municipality",
	"district",
	"block",
	"sub_block",
	"building_number",
	"building_name",
] as const

/**
 * Stage 3 followed by the JP tags.
 */
export const STAGE3_JP_TAGS = [...STAGE3_TAGS, ...JP_FINE_TAGS] as const

/**
 * The CN organizational-ladder tag.
 *
 * One tag covers the whole ordinal chain below the settlement, and the CN unit reader
 * in `@mailwoman/core` reads each rung from its suffix after decoding.
 */
export const CN_FINE_TAGS = ["locality_unit"] as const

/**
 * Stage 3 followed by the CN tag.
 */
export const STAGE3_CN_TAGS = [...STAGE3_TAGS, ...CN_FINE_TAGS] as const

/**
 * The JP tags followed by the CN tag, behind one classifier for the joint character model.
 */
export const CJK_FINE_TAGS = [...JP_FINE_TAGS, ...CN_FINE_TAGS] as const

/**
 * Stage 3 followed by the CJK tags.
 * Every JP label keeps the id it has in `stage3-jp`.
 */
export const STAGE3_CJK_TAGS = [...STAGE3_TAGS, ...CJK_FINE_TAGS] as const

/**
 * Expand a tag list into its BIO labels: `O`, then `B-` and `I-` for each tag in order.
 */
export function bioLabelsOf(tags: readonly string[]): readonly string[] {
	return Object.freeze(["O", ...tags.flatMap((tag) => [`B-${tag}`, `I-${tag}`])])
}

/**
 * Every label set a model may train on, by the name a training config's `data.label_set` uses.
 *
 * A label's index in its set's BIO expansion is the model's output index for it.
 * Each set extends `stage3` by appending, so a stage-3 label keeps its index in every set.
 *
 * Never reorder an entry.
 * Add a new set instead.
 */
export const LABEL_SETS = {
	stage3: STAGE3_TAGS,
	"stage3-jp": STAGE3_JP_TAGS,
	"stage3-cn": STAGE3_CN_TAGS,
	"stage3-cjk": STAGE3_CJK_TAGS,
	stage4: STAGE4_TAGS,
} as const satisfies Record<string, readonly string[]>

/**
 * The name of a label set in {@linkcode LABEL_SETS}.
 */
export type LabelSetName = keyof typeof LABEL_SETS

/**
 * The label set a training config uses when it names none.
 */
export const DEFAULT_LABEL_SET: LabelSetName = "stage3"

/**
 * The label id cross-entropy ignores.
 *
 * A token without supervision, and a row whose country has no locale-head class, carry it.
 */
export const IGNORE_INDEX = -100

/**
 * Locale-head class order.
 *
 * The trainer reads it from `data/label-schema.v1.json`, so it is append-only:
 * a reorder mislabels every detection of a trained model.
 *
 * The postcode-anchor feature layout indexes the same array
 * (`anchor-inference.ts` re-exports it as `LOCALE_ORDER`): the posterior occupies indices
 * `[0, LOCALE_COUNTRIES.length)`; the normalized centroid the last two.
 * (Pinned by `anchor-inference.test.ts`; do not reorder.)
 */
export const LOCALE_COUNTRIES = ["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"] as const
