/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `--debug` input area's evidence rows, as plain strings: what the model was told the input WAS (system,
 *   register, locale), what it was fed (tokens, retrieval channels), and what it decided (decode, locale head).
 *   Content parity with the docs demo's dev-mode drawer (`docs/src/components/ModelVisualizer`) minus its emissions
 *   heatmap — a terminal row is not a matrix, and the priors that moved those emissions are named on the decode row
 *   instead.
 *
 *   Every function here takes the {@link GeocodeTrace} the session recorded and returns ONE line. A stage that
 *   produced nothing renders {@link ABSENT} and says why — "not fed" is the #566/#685 diagnostic fact the demo's
 *   channel band already reports, and an absent locale head is a property of the loaded bundle, not a zero. Nothing in
 *   this module derives, infers, or fills in a value the trace did not carry.
 *
 *   Pure and Ink-free so the formatting is unit-testable without a render, and so a caller can truncate the result
 *   against a pane width without owning any of the vocabulary.
 */

import type { GeocodeTrace } from "../geocode-session.ts"

//#region Shared

/**
 * What a row shows where the datum genuinely does not exist. One constant, because "the model has no locale head" and
 * "no channel was fed" must not read as two different kinds of nothing.
 */
export const ABSENT = "—"

/**
 * Field separator inside one row. Two spaces rather than a glyph: the rows are already dense, and a punctuation mark
 * between every field costs columns the token stream wants.
 */
const FIELD_GAP = "  "

function fields(parts: Array<string | null>): string {
	return parts.filter((part) => part != null && part.length > 0).join(FIELD_GAP)
}

/**
 * Numerically-stable softmax over one logit row.
 *
 * A local copy of `@mailwoman/neural`'s `softmax` ON PURPOSE, and the same trade `nuts-lookup`/`timezone-lookup` made
 * against `@mailwoman/spatial`: the shared one is reachable only through the `@mailwoman/neural` barrel (there is no
 * `./viterbi` subpath), which drags onnxruntime-node into a pure string-formatting module and into every test that
 * renders a frame. Six lines against a native-binding load in the component tests.
 */
function softmax(row: readonly number[]): number[] {
	const max = Math.max(...row)
	const exps = row.map((value) => Math.exp(value - max))
	const sum = exps.reduce((a, b) => a + b, 0)

	return exps.map((value) => value / sum)
}

//#endregion

//#region Rows

/**
 * How many locale-head classes the row names. The head's axis is nine countries wide; the tail is uniformly flat on a
 * confident parse, and three entries is what fits beside the rest of the row on a narrow pane.
 */
const LOCALE_HEAD_ENTRIES = 3

/**
 * The addressing system whose conventions applied, the register the parse ran in, the operator's locale, and the
 * known-format spans Stage 2 detected.
 *
 * `systemSource` is load-bearing and rides in parentheses: `auto` means the locale head chose the system, `pinned`
 * means the bundle or the caller did, and `off` means conventions never ran — three different reasons for the same
 * `us`, and the trace is the only place that distinction survives.
 */
export function systemRow(trace: GeocodeTrace | undefined): string {
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
 * The locale head's top classes as probabilities, on the head's OWN axis (`localeCountries` rides with the logits, so
 * nothing here hardcodes an order — the PLACETYPE_ORDER dual-maintenance class).
 */
export function localeHeadRow(trace: GeocodeTrace | undefined): string {
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
 * The SentencePiece stream exactly as fed, pieces space-separated with the `▁` word-start sentinel intact (it is the
 * tokenizer's own mark for "a word starts here", and dropping it hides the fertility question every digit-ownership bug
 * is asked in). The COUNT leads so it survives the caller's truncation, which eats the tail.
 */
export function tokensRow(trace: GeocodeTrace | undefined): string {
	if (!trace) return ABSENT

	const { pieces } = trace.parse

	if (!pieces.length) return ABSENT

	return `${pieces.length}${FIELD_GAP}${pieces.map((piece) => piece.piece).join(" ")}`
}

/**
 * The retrieval channels as fed to the encoder: per channel, how many pieces carried a nonzero clue and which ones.
 *
 * "not fed" and `0/12` are DIFFERENT claims — the first is a channel with no source wired (the demo's band says so
 * too), the second is a wired channel that matched nothing on this input. Collapsing them is how "why didn't my
 * gazetteer prior fire" becomes unanswerable.
 */
export function channelsRow(trace: GeocodeTrace | undefined): string {
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
 * What the decode did: the algorithm, the mean per-token confidence, the component sequence it produced, which priors
 * actually moved the emissions, and which repair passes changed a label.
 *
 * `priors` reports EFFECT, not configuration — `TracePrior.applied` is true only where a composed prior carried a
 * nonzero bias — which is why this row is a usable substitute for the emissions matrix the terminal has no room for.
 */
export function decodeRow(trace: GeocodeTrace | undefined): string {
	if (!trace) return ABSENT

	const { tokens, decode, priors, repairs } = trace.parse
	const applied = priors.filter((prior) => prior.applied).map((prior) => prior.kind)

	const meanConfidence = tokens.length ? tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length : null

	// B-/I- stripped and runs collapsed: the ribbon above already carries per-character ownership, so what
	// this row adds is the ORDER the decode produced, not a second copy of the spans.
	const sequence: string[] = []

	for (const token of tokens) {
		const label = token.label.replace(/^[BI]-/u, "")

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

//#endregion
