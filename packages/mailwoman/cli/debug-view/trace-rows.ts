/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { bareBIOTag } from "@mailwoman/codex/component"
import { stringifyJSON } from "@mailwoman/core/json"
import { softmax } from "@mailwoman/neural/viterbi"

import type { GeocodeTrace } from "#geocode/session"

// #region Shared

/**
 * What a row shows where the datum does not exist, kept as a single constant
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
 * Per channel, the count of pieces that contributed a nonzero clue and which ones:
 * `not fed` is an unwired source while `0/12` is a wired channel that matched no entry.
 */
export function channelsRow(trace: GeocodeTrace | null): string {
	if (!trace) return ABSENT

	const { pieces, anchor, gazetteer, country, streetType, localitySurface, inputMode, channelPins } = trace.parse
	const pins = channelPins ?? {}

	const channels = (
		[
			["anchor", anchor],
			["gazetteer", gazetteer],
			["country", country],
			["street_type", streetType ?? null],
			["locality_surface", localitySurface ?? null],
		] as const
	).map(([name, channel]) => {
		if (!channel) return `${name} not fed`

		const fired = channel.confidence
			.map((confidence, index) => ({ confidence, piece: pieces[index]?.piece ?? `#${index}` }))
			.filter((entry) => entry.confidence > 0)

		const detail = fired.length ? ` [${fired.map((entry) => entry.piece.replace("▁", "")).join(" ")}]` : ""
		// A pinned channel reads 0/n by construction, and the suffix states the pin as the cause.
		const pin = pins[name] === "off" ? " (pinned off)" : ""

		return `${name} ${fired.length}/${pieces.length}${detail}${pin}`
	})

	return fields([...channels, `mode ${inputMode ?? "fragmented"}`])
}

/**
 * What the decode did: algorithm, mean per-token confidence, component sequence,
 * priors that contributed a nonzero bias and repair passes that changed a label.
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

function signed(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`
}

function changeList(changes: ReadonlyArray<{ text: string; from: string; to: string }>): string {
	return changes.map((change) => `${change.text.replace("▁", "")} ${change.from}→${change.to}`).join(" ")
}

/**
 * The nonzero objective terms of a margin, largest first.
 */
function termBreakdown(values: Readonly<Record<string, number>>): string {
	const terms = Object.entries(values)
		.filter(([, value]) => value !== 0)
		.toSorted((a, b) => Math.abs(b[1]) - Math.abs(a[1]))

	return terms.length ? terms.map(([term, value]) => `${term} ${signed(value)}`).join(", ") : "no term differs"
}

/**
 * One row per decoded span: the runner-up reading that labels the span differently
 * and the margin to it split by objective term, followed by one row per applied prior
 * with what it added to the decoded reading and the labels that change without it.
 */
export function explanationRows(trace: GeocodeTrace | null): string[] {
	if (!trace?.parse.explanation) return [`runner-up: ${ABSENT} no decode explanation in this trace`]

	const { explanation, pieces } = trace.parse

	const spanRows = explanation.spans.map((span) => {
		// A lone word-start piece covers no characters, so the row prints the pieces instead of an empty string.
		const surface = span.text.trim()
			? stringifyJSON(span.text)
			: `pieces ${stringifyJSON(
					pieces
						.slice(span.pieceStart, span.pieceEnd)
						.map((piece) => piece.piece)
						.join("")
				)}`

		const decoded = `${span.tag} ${surface}`

		if (!span.runnerUp || span.margin == null || !span.termMargins) return `runner-up ${decoded}: no alternative label`

		return `runner-up ${decoded}: [${changeList(span.runnerUp.changes)}] margin ${span.margin.toFixed(2)} = ${termBreakdown(span.termMargins)}`
	})

	const ledgerRows = explanation.ledger.map((entry) => {
		const changed = entry.changes.length ? `without it: ${changeList(entry.changes)}` : "without it: no label changes"

		return `ledger ${entry.prior}: ${signed(entry.decodedPathContribution)} on the decoded reading, ${entry.cells.length} cells; ${changed}`
	})

	return [...spanRows, ...ledgerRows]
}

// #endregion
