/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Confidence banding shared by the demo components.
 *
 *   The same three-way split was written out in seven components. It is a presentation choice, not a
 *   model one — the parser emits a continuous confidence and these bounds only decide which colour a
 *   span is drawn in — so it lives here rather than anywhere the pipeline can see it.
 */

/**
 * At or above this the span is drawn as high-confidence.
 */
export const HIGH_CONFIDENCE_MIN = 0.8

/**
 * At or above this the span is drawn as medium-confidence; below it, low.
 */
export const MID_CONFIDENCE_MIN = 0.5

/**
 * The banding a component applies to a span's confidence.
 */
export type ConfidenceTier = "high" | "mid" | "low"

/**
 * Bands a continuous confidence into the three tiers the demo styles against.
 *
 * @param confidence A parser confidence in `[0, 1]`.
 *
 * @returns The tier to style with.
 */
export function confidenceTier(confidence: number): ConfidenceTier {
	if (confidence >= HIGH_CONFIDENCE_MIN) return "high"

	if (confidence >= MID_CONFIDENCE_MIN) return "mid"

	return "low"
}
