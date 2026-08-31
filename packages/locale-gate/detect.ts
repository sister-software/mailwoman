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

import { scoreByPostcode, scoreByScript, scoreFallback, type LocaleCandidate } from "#rules"
import type { DetectLocaleOpts, LocaleHint, NormalizedInputLite, QueryShapeLike } from "#types"

/**
 * Synchronous, pure rule-based implementation. The async wrapper matches the pipeline contract.
 */
export function detectLocaleSync(
	_input: NormalizedInputLite,
	shape: QueryShapeLike,
	opts: DetectLocaleOpts = {}
): LocaleHint {
	const scored: LocaleCandidate[] = []
	const script = scoreByScript(shape)

	if (script) {
		scored.push(script)
	}

	const postcode = scoreByPostcode(shape)

	if (postcode) {
		scored.push(postcode)
	}

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
			confidence: 1,
			alternatives: deduped.map((c) => ({ locale: c.locale, confidence: c.confidence })),
			source: "caller",
		}
	}

	if (opts.environmentLocale) {
		return {
			locale: opts.environmentLocale,
			confidence: 0.95,
			alternatives: deduped.map((c) => ({ locale: c.locale, confidence: c.confidence })),
			source: "environment",
			evidence: { environmentLocale: opts.environmentLocale },
		}
	}

	const top = deduped[0]!
	const machineLocale = opts.machinePreferences?.locale

	// The 0.3 candidate is the explicit no-input-evidence fallback. Machine locale may replace only that candidate;
	// scripts and postal formats continue to win. Timezone is reported independently and never converted to language.
	if (top.reason === "fallback" && machineLocale) {
		return {
			locale: machineLocale,
			confidence: 0.55,
			alternatives: deduped.map((c) => ({ locale: c.locale, confidence: c.confidence })),
			source: "machine",
			evidence: {
				intlLocale: machineLocale,
				...(opts.machinePreferences?.timeZone ? { timeZone: opts.machinePreferences.timeZone } : {}),
			},
		}
	}

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
