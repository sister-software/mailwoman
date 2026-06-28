/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `detectLocale` — Stage 2 entry point. Composes the per-rule scorers and emits a `LocaleHint`.
 *
 *   Caller-hint precedence: when `opts.hint` is provided, it wins at confidence 1.0 with
 *   `source="caller"`. The detector still runs the rules to populate `alternatives` so downstream
 *   consumers see what the input shape would have predicted (useful for diagnostics + future
 *   disagreement-detection metrics).
 */

import { scoreByPostcode, scoreByScript, scoreFallback, type LocaleCandidate } from "./rules.js"
import type { DetectLocaleOpts, LocaleHint, NormalizedInputLite, QueryShapeLike } from "./types.js"

/** Synchronous, pure rule-based implementation. The async wrapper matches the pipeline contract. */
export function detectLocaleSync(
	_input: NormalizedInputLite,
	shape: QueryShapeLike,
	opts: DetectLocaleOpts = {}
): LocaleHint {
	const scored: LocaleCandidate[] = []
	const script = scoreByScript(shape)

	if (script) scored.push(script)
	const postcode = scoreByPostcode(shape)

	if (postcode) scored.push(postcode)
	scored.push(scoreFallback(shape))

	// Sort descending by confidence; preserve scorer order on ties (stable sort).
	scored.sort((a, b) => b.confidence - a.confidence)

	// Deduplicate by locale — if two scorers picked en-US, the higher-confidence wins; the other
	// contributes nothing useful as an alternative.
	const seen = new Set<string>()
	const deduped = scored.filter((c) => {
		if (seen.has(c.locale)) return false
		seen.add(c.locale)

		return true
	})

	if (opts.hint) {
		// Caller's hint wins. Detector results surface as alternatives.
		return {
			locale: opts.hint,
			confidence: 1.0,
			alternatives: deduped.map((c) => ({ locale: c.locale, confidence: c.confidence })),
			source: "caller",
		}
	}

	const top = deduped[0]!

	return {
		locale: top.locale,
		confidence: top.confidence,
		alternatives: deduped.slice(1).map((c) => ({ locale: c.locale, confidence: c.confidence })),
		source: "detected",
	}
}

/**
 * Async variant matching `RuntimePipelineStages.detectLocale`. Wraps the sync impl so the pipeline coordinator can use
 * it as-is.
 */
export async function detectLocale(
	input: NormalizedInputLite,
	shape: QueryShapeLike,
	opts?: DetectLocaleOpts
): Promise<LocaleHint> {
	return detectLocaleSync(input, shape, opts)
}
