/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Detects the address system from the model's `locale_logits` output. Detection returns null below the confidence
 *   threshold, so a low-confidence parse applies no conventions.
 */

import type { SystemCode } from "@mailwoman/codex"

import { LOCALE_COUNTRIES } from "#labels"
import { softmax } from "#viterbi"

/**
 * The locale head's country order, re-exported from `#labels`.
 */
export { LOCALE_COUNTRIES } from "#labels"

/**
 * Returns the locale head's argmax country, or null when its probability is below the threshold.
 */
function localeVerdict(
	localeLogits: readonly number[] | undefined,
	threshold: number
): { country: (typeof LOCALE_COUNTRIES)[number]; confidence: number } | null {
	if (!localeLogits || localeLogits.length !== LOCALE_COUNTRIES.length) return null
	const probs = softmax(localeLogits)
	let best = 0

	for (let i = 1; i < probs.length; i++)
		if (probs[i]! > probs[best]!) {
			best = i
		}

	const confidence = probs[best]!

	if (confidence < threshold) return null

	return { country: LOCALE_COUNTRIES[best]!, confidence }
}

/**
 * Maps an ISO 3166-1 alpha-2 country to its codex address system.
 *
 * Locales without an entry have no conventions.
 */
const COUNTRY_TO_SYSTEM: Partial<Record<(typeof LOCALE_COUNTRIES)[number], SystemCode>> = {
	US: "us",
	FR: "fr",
	DE: "de",
	CA: "ca",
	GB: "gb",
	JP: "jp",
}

/**
 * An address system detected from the locale head, with its country and probability.
 */
export interface DetectedSystem {
	system: SystemCode
	country: (typeof LOCALE_COUNTRIES)[number]
	confidence: number
}

/**
 * Returns the address system for the locale head's confident country, or null.
 *
 * @param localeLogits The raw `locale_logits` output, in {@link LOCALE_COUNTRIES} order.
 * @param threshold The minimum softmax probability to act on.
 */
export function detectAddressSystem(
	localeLogits: readonly number[] | undefined,
	threshold = 0.8
): DetectedSystem | null {
	const verdict = localeVerdict(localeLogits, threshold)

	if (!verdict) return null
	const system = COUNTRY_TO_SYSTEM[verdict.country]

	if (!system) return null

	return { system, country: verdict.country, confidence: verdict.confidence }
}

/**
 * Returns the locale head's confident country, or null below the threshold.
 *
 * Unlike {@link detectAddressSystem}, it also returns countries without a `SystemCode`.
 * The country says that the text resembles that country's address format.
 * It does not resolve the address's actual country.
 */
export function confidentLocaleCountry(
	localeLogits: readonly number[] | undefined,
	threshold = 0.8
): { country: (typeof LOCALE_COUNTRIES)[number]; confidence: number } | null {
	return localeVerdict(localeLogits, threshold)
}

/**
 * Resolves which address system's conventions apply to one parse.
 *
 * A pinned `SystemCode` is used as given.
 * The value `"auto"` uses {@link detectAddressSystem}.
 *
 * An `undefined` value turns conventions off and yields a null system.
 */
export function resolveSystemVerdict(
	conventionsOpt: SystemCode | "auto" | undefined,
	localeLogits: readonly number[] | undefined
): { detectedSystem: SystemCode | null; systemSource: "off" | "auto" | "pinned" } {
	const detectedSystem =
		conventionsOpt === undefined
			? null
			: conventionsOpt === "auto"
				? (detectAddressSystem(localeLogits)?.system ?? null)
				: conventionsOpt

	return {
		detectedSystem,
		systemSource: conventionsOpt === undefined ? "off" : conventionsOpt === "auto" ? "auto" : "pinned",
	}
}
