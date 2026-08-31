/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Address-system detection from the model's locale head (#511 Tier A — the consumer the head never
 *   had). The PR3 self-conditioning head predicts which country an address belongs to from the
 *   pooled sequence; v1.1.0+ exports surface it as the `locale_logits` ONNX output. This module
 *   turns that posterior into a `SystemCode` the conventions layer can act on.
 *
 *   Conservative by contract: below the confidence threshold, or for locales without a codex system
 *   slice, detection returns null and the parse proceeds exactly as before. The mask must never
 *   fire on a guess.
 */

import type { SystemCode } from "@mailwoman/codex"

import { softmax } from "#viterbi"

/**
 * Locale-head class order — MUST mirror `corpus-python/src/mailwoman_train/labels.py` `LOCALE_COUNTRIES` exactly (same
 * never-reorder/append-only discipline; a drift here silently mislabels every detection).
 */
export const LOCALE_COUNTRIES = ["US", "FR", "DE", "CA", "GB", "JP", "ES", "IT", "NL"] as const

/**
 * ISO-2 country → codex address-system slice. Unmapped locales have no conventions yet.
 */
const COUNTRY_TO_SYSTEM: Partial<Record<(typeof LOCALE_COUNTRIES)[number], SystemCode>> = {
	US: "us",
	FR: "fr",
	DE: "de",
	CA: "ca",
	GB: "gb",
	JP: "jp",
}

export interface DetectedSystem {
	system: SystemCode
	country: (typeof LOCALE_COUNTRIES)[number]
	confidence: number
}

/**
 * Read the locale head's posterior into a confident `SystemCode`, or null.
 *
 * @param localeLogits The raw `locale_logits` output (LOCALE_COUNTRIES order).
 * @param threshold Minimum softmax probability to act on (default 0.8 — the head's held-out accuracy is ~0.98, so 0.8
 *   trades a little recall for never masking on a coin flip).
 */
export function detectAddressSystem(
	localeLogits: readonly number[] | undefined,
	threshold = 0.8
): DetectedSystem | null {
	if (!localeLogits || localeLogits.length !== LOCALE_COUNTRIES.length) return null
	const probs = softmax(localeLogits as number[])
	let best = 0

	for (let i = 1; i < probs.length; i++)
		if (probs[i]! > probs[best]!) {
			best = i
		}

	const confidence = probs[best]!

	if (confidence < threshold) return null
	const country = LOCALE_COUNTRIES[best]!
	const system = COUNTRY_TO_SYSTEM[country]

	if (!system) return null

	return { system, country, confidence }
}

/**
 * The locale head's confident COUNTRY verdict, or null — {@link detectAddressSystem} minus the system mapping, so the
 * three head countries without a `SystemCode` (ES/IT/NL) still yield a verdict. Same threshold posture: below it the
 * head abstains rather than acting on a coin flip. The head is a 9-way classifier — its verdict is evidence that the
 * text is shaped like THAT country's addressing, never a resolved country (a Chinese address may read GB: right about
 * "not the locale's country", wrong about which).
 */
export function confidentLocaleCountry(
	localeLogits: readonly number[] | undefined,
	threshold = 0.8
): { country: (typeof LOCALE_COUNTRIES)[number]; confidence: number } | null {
	if (!localeLogits || localeLogits.length !== LOCALE_COUNTRIES.length) return null
	const probs = softmax(localeLogits as number[])
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
 * Resolve which addressing system's conventions apply for one parse (#511 Tier A): a caller-pinned `SystemCode` wins;
 * `"auto"` reads the locale head under {@link detectAddressSystem}'s confidence bar; `undefined` = conventions off —
 * null system, no constraints, and the parse stays byte-identical to the pre-conventions path.
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
