/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { bareBIOTag } from "@mailwoman/codex/component"
import { softmax } from "@mailwoman/neural/viterbi"

import type { GeocodeTrace } from "#geocode/session"

// #region Shared

/**
 * What a row shows where the datum genuinely does not exist, kept as a single constant
 * so every kind of absence reads the same.
 */
export const ABSENT = "—"

const FIELD_GAP = "  "

function fields(parts: Array<string | null>): string {
	return parts.filter((part) => part != null && part.length).join(FIELD_GAP)
}

// #endregion

// #region Rows

/**
 * Three entries fit beside each other because the head's axis is nine countries wide.
 * The head's axis has the rest of the row on a narrow pane.
 */
const LOCALE_HEAD_ENTRIES = 3

/**
 * `systemSource` appears in parentheses to separate three reasons for the same
 * system code: `auto` means the locale head chose it.
 *
 * `pinned` means the bundle or caller supplied it.
 * `off` means conventions never ran.
 */
export function systemRow(trace: GeocodeTrace | null): string {
	if (!trace) return ABSENT

	const system = trace.parse.detectedSystem ?? "none"
	const formats = trace.queryShape.knownFormats.map((known) => known.format)

	return fields([
		`${system} (${trace.parse.systemSource})`,
		`mode ${trace.inputMode}`,
		`locale ${trace.locale}`,
		`format ${formats.length ? formats.join(",") : ABSENT}`,
	])
}

/**
 * The locale head's top classes as probabilities, ordered by the `localeCountries`
 * axis that accompanies the logits rather than by a hardcoded order.
 */
export function localeHeadRow(trace: GeocodeTrace | null): string {
	if (!trace) return ABSENT

	const { localeLogits, localeCountries } = trace.parse

	if (!localeLogits?.length || !localeCountries?.length) return `${ABSENT} no locale head in this bundle`

	const probabilities = softmax(localeLogits)

	return localeCountries
		.map((country, index) => ({ country, probability: probabilities[index] ?? 0 }))
		.toSorted((a, b) => b.probability - a.probability)
		.slice(0, LOCALE_HEAD_ENTRIES)
		.map((entry) => `${entry.country} ${entry.probability.toFixed(2)}`)
		.join(FIELD_GAP)
}

/**
 * The SentencePiece stream as fed, keeping the `▁` word-start sentinel and leading
 * with the piece count so it survives the caller's truncation.
 */
export function tokensRow(trace: GeocodeTrace | null): string {
	if (!trace) return ABSENT

	const { pieces } = trace.parse

	if (!pieces.length) return ABSENT

	return `${pieces.length}${FIELD_GAP}${pieces.map((piece) => piece.piece).join(" ")}`
}

/**
 * Per channel, how many pieces contributed a nonzero clue and which ones: `not fed` is
 * an unwired source while `0/12` is a wired channel that matched no entry.
 */
export function channelsRow(trace: GeocodeTrace | null): string {
	if (!trace) return ABSENT

	const { pieces, anchor, gazetteer, country } = trace.parse

	return fields(
		(
			[
				["anchor", anchor],
				["gazetteer", gazetteer],
				["country", country],
			] as const
		).map(([name, channel]) => {
			if (!channel) return `${name} not fed`

			const fired = channel.confidence
				.map((confidence, index) => ({ confidence, piece: pieces[index]?.piece ?? `#${index}` }))
				.filter((entry) => entry.confidence > 0)

			const detail = fired.length ? ` [${fired.map((entry) => entry.piece.replace("▁", "")).join(" ")}]` : ""

			return `${name} ${fired.length}/${pieces.length}${detail}`
		})
	)
}

/**
 * What the decode did: algorithm, mean per-token confidence, component sequence,
 * priors that actually contributed a nonzero bias and repair passes that changed a label.
 */
export function decodeRow(trace: GeocodeTrace | null): string {
	if (!trace) return ABSENT

	const { tokens, decode, priors, repairs } = trace.parse
	const applied = priors.filter((prior) => prior.applied).map((prior) => prior.kind)

	const meanConfidence = tokens.length ? tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length : null

	const sequence: string[] = []

	for (const token of tokens) {
		const label = bareBIOTag(token.label)

		if (label !== "O" && sequence.at(-1) !== label) {
			sequence.push(label)
		}
	}

	return fields([
		decode,
		meanConfidence == null ? null : `conf ${meanConfidence.toFixed(2)}`,
		sequence.length ? sequence.join(" ") : null,
		`priors ${applied.length ? applied.join(",") : ABSENT}`,
		`repairs ${repairs.length ? repairs.map((repair) => repair.pass).join(",") : ABSENT}`,
	])
}

// #endregion
