/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The constraint account: per row, whether the decoded parse violates C4 or C6 of `decoder-grammar.mdx` §5,
 * and for each violation the decoder's own explanation of why the violating reading won.
 *
 * The parse is the one the held-out battery grades, `NeuralAddressClassifier.parse` with `postcodeRepair`
 * and the row's country as the locale hint, on the locale package `HELDOUT_INFERENCE_RULE` names. The geocode
 * pipeline corrects or drops some model errors after the parse, so the mechanism account cannot see them.
 *
 * The registry the predicates read is the gazetteer FST and street-morphology FST the row's locale package
 * ships. The parse itself runs without them, as the battery's does, so the explanation's `fst` term is zero.
 */

import { buildAddressTree, groupTuplesByTag } from "@mailwoman/core/decoder"
import { stringifyJSON } from "@mailwoman/core/json"
import { NeuralAddressClassifier, type NeuralParseTrace } from "@mailwoman/neural"
import type { DecodeSpanExplanation, DecodeTerm, DecodeTermValues } from "@mailwoman/neural/decode-explanation"
import type { FSTMatcherLike } from "@mailwoman/neural/fst-prior"
import { loadStreetMorphologyFST } from "@mailwoman/resolver-wof-sqlite/street"
import { loadParsePriors } from "mailwoman/geocode/parse-priors"
import { spansFromBIO, type CensusSpan } from "mailwoman/tools/eval-harness/grammar/census"
import {
	findConstraintRegistryMatches,
	readConstraints,
	type ConstraintRegistryMatches,
} from "mailwoman/tools/eval-harness/grammar/census/constraints"
import {
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	HELDOUT_INFERENCE_RULE,
} from "mailwoman/tools/eval-harness/heldout/per/country"

import type { EngineConfig } from "#dev-mcp/engine/registry"
import { resolveInputSet, type InputSetRef } from "#dev-mcp/input-sets"

/**
 * One row the account parses.
 */
export interface ConstraintAccountInput {
	id: string
	input: string
	country: string | null
	/**
	 * The expected reading, echoed beside the observed one for a reader to compare.
	 * The account does not grade it.
	 */
	expected: string | null
}

export type ConstraintID = "C4" | "C4_segment" | "C6"

/**
 * One side of a violating boundary, read from the decoder's explanation of the span holding that side.
 */
interface ConstraintSpanReading {
	tag: string
	text: string
	margin: number | null
	/**
	 * The pieces the runner-up relabels, as `piece:from→to`.
	 */
	runner_up_changes: string | null
	/**
	 * The terms whose margin is nonzero, rounded to three places.
	 */
	term_margins: Partial<DecodeTermValues>
	/**
	 * The term that contributed most to the decoded reading's margin over the runner-up.
	 */
	dominant_term: DecodeTerm | null
}

/**
 * One violating boundary, with both sides read from the decoder's explanation.
 */
interface ConstraintViolationAccount {
	constraint: ConstraintID
	boundary_character: number
	left: { tag: string; text: string }
	right: { tag: string; text: string }
	inside_word: boolean
	/**
	 * For C6, the covering registry surface and the nested hit aligned with one side.
	 */
	registry: { covering: string; nested: string; nested_side: "left" | "right" } | null
	sides: { left: ConstraintSpanReading | null; right: ConstraintSpanReading | null }
	/**
	 * The side whose runner-up is closest.
	 * It decides {@link dominant_term} and {@link runner_up}.
	 */
	closest_side: "left" | "right" | null
	dominant_term: DecodeTerm | null
	/**
	 * The full reading of the closest side's runner-up.
	 */
	runner_up: string | null
	/**
	 * A repair changed the labels the explanation decoded for either side,
	 * so the explanation reads the pre-repair path.
	 */
	repaired: boolean
}

export interface ConstraintRowAccount {
	id: string
	input: string
	country: string | null
	locale: string
	expected: string | null
	/**
	 * The tree `parse` returns, as tuples.
	 * The battery grades this tree.
	 */
	observed: string
	/**
	 * The final labels as spans, before tree assembly, where the predicates read the boundaries.
	 */
	decoded: string
	violated: Record<ConstraintID, boolean | null>
	n_boundaries: number
	n_locality_spans: number
	violations: ConstraintViolationAccount[]
	rendered: string
}

export interface ConstraintTally {
	n_rows_violating: number
	/**
	 * Rows on which the constraint could be read.
	 *
	 * A row whose verdict depends on an unread gazetteer FST is left out.
	 */
	n_rows_read: number
	share: number | null
	by_dominant_term: Partial<Record<DecodeTerm | "none", number>>
}

export interface ConstraintAccountResult {
	account: "constraints"
	inference_rule: string
	weights_root: string | null
	predicates: Record<ConstraintID, string>
	n_rows: number
	n_errored: number
	errors: Array<{ id: string; input: string; message: string }>
	tallies: Record<ConstraintID, ConstraintTally>
	summary: string
	rows: ConstraintRowAccount[]
	rows_omitted: number
}

/**
 * Each predicate as the account applies it, echoed in every result
 * so a count can be checked against its rule.
 *
 * The wording restates `readConstraints` and `decoder-grammar.mdx` §5.
 */
const CONSTRAINT_PREDICATES: Record<ConstraintID, string> = {
	C4:
		"A boundary between adjacent decoded spans that lies strictly inside a phrase-grouper proposal and holds none of " +
		"§5's licenses: a query-shape delimiter, a street-affix match edge, a token character-class change, or a " +
		"gazetteer FST match edge.",
	C4_segment:
		"C4 with the comma-free query-shape segment as the phrase, so a boundary the grouper proposes no phrase across " +
		"is read too.",
	C6:
		"A decoded boundary strictly inside a gazetteer FST match, where a shorter FST match aligns exactly with one " +
		"adjacent span under that span's tag.",
}

const round = (value: number) => Math.round(value * 1000) / 1000

/**
 * A term margin below this magnitude is floating-point residue from summing
 * the term matrices, and is omitted.
 */
const TERM_MARGIN_EPSILON = 1e-9

function spanText(text: string, pieces: NeuralParseTrace["pieces"], span: CensusSpan): string {
	return text.slice(pieces[span.start]!.start, pieces[span.end - 1]!.end)
}

/**
 * A reading as `tag=value` tuples in input order, with tuples of one tag joined by ` ¦ `.
 */
export function renderReading(text: string, pieces: NeuralParseTrace["pieces"], labels: readonly string[]): string {
	const byTag = new Map<string, string[]>()

	for (const span of spansFromBIO(labels.map((label) => ({ label })))) {
		byTag.set(span.tag, [...(byTag.get(span.tag) ?? []), spanText(text, pieces, span)])
	}

	return [...byTag].map(([tag, values]) => `${tag}=${values.join(" ¦ ")}`).join(" | ")
}

function dominantTerm(terms: DecodeTermValues | null): DecodeTerm | null {
	if (!terms) return null

	let best: DecodeTerm | null = null

	for (const [term, value] of Object.entries(terms) as Array<[DecodeTerm, number]>) {
		if (value > 0 && (best === null || value > terms[best])) {
			best = term
		}
	}

	return best
}

function sideReading(span: DecodeSpanExplanation | undefined): ConstraintSpanReading | null {
	if (!span) return null

	return {
		tag: span.tag,
		text: span.text,
		margin: span.margin === null ? null : round(span.margin),
		runner_up_changes: span.runnerUp
			? span.runnerUp.changes.map((change) => `${change.text}:${change.from}→${change.to}`).join(", ")
			: null,
		term_margins: span.termMargins
			? Object.fromEntries(
					Object.entries(span.termMargins)
						.filter(([, value]) => Math.abs(value) > TERM_MARGIN_EPSILON)
						.map(([term, value]) => [term, round(value)])
				)
			: {},
		dominant_term: dominantTerm(span.termMargins),
	}
}

/**
 * Account for one traced decode against the registry matches over its pieces.
 */
export function accountConstraints(
	row: ConstraintAccountInput,
	locale: string,
	trace: Pick<NeuralParseTrace, "text" | "pieces" | "tokens" | "explanation">,
	matches: ConstraintRegistryMatches
): ConstraintRowAccount {
	const reading = readConstraints(trace, matches)
	const labels = trace.tokens.map((token) => token.label as string)
	const explained = trace.explanation?.spans ?? []
	const explanationAt = (piece: number) => explained.find((s) => s.pieceStart <= piece && piece < s.pieceEnd)
	// The explanation's spans tile the pre-repair path, and a runner-up lists every piece it relabels.
	const decodedPath = explained.flatMap((span) => span.labels)

	const runnerUpReading = (span: DecodeSpanExplanation | undefined): string | null => {
		if (!span?.runnerUp || decodedPath.length !== labels.length) return null

		const path = [...decodedPath]

		for (const change of span.runnerUp.changes) {
			path[change.piece] = change.to
		}

		return renderReading(trace.text, trace.pieces, path)
	}

	const violation = (
		constraint: ConstraintID,
		left: CensusSpan,
		right: CensusSpan,
		boundaryCharacter: number,
		insideWord: boolean,
		registry: ConstraintViolationAccount["registry"]
	): ConstraintViolationAccount => {
		const leftSpan = explanationAt(left.start)
		const rightSpan = explanationAt(right.start)
		const sides = { left: sideReading(leftSpan), right: sideReading(rightSpan) }
		const leftMargin = sides.left?.margin ?? Infinity
		const rightMargin = sides.right?.margin ?? Infinity

		const closest =
			leftMargin === Infinity && rightMargin === Infinity ? null : leftMargin <= rightMargin ? "left" : "right"

		const closestSpan = closest === "left" ? leftSpan : closest === "right" ? rightSpan : undefined

		const repaired = [leftSpan, rightSpan].some(
			(span, index) =>
				!span ||
				span.tag !== (index === 0 ? left : right).tag ||
				span.labels.some((label, offset) => label !== labels[span.pieceStart + offset])
		)

		return {
			constraint,
			boundary_character: boundaryCharacter,
			left: { tag: left.tag, text: spanText(trace.text, trace.pieces, left) },
			right: { tag: right.tag, text: spanText(trace.text, trace.pieces, right) },
			inside_word: insideWord,
			registry,
			sides,
			closest_side: closest,
			dominant_term: closest ? sides[closest]!.dominant_term : null,
			runner_up: runnerUpReading(closestSpan),
			repaired,
		}
	}

	const violations: ConstraintViolationAccount[] = []

	for (const boundary of reading.c4SegmentViolations) {
		const ids: ConstraintID[] = boundary.classification.verdict === "violation" ? ["C4", "C4_segment"] : ["C4_segment"]

		for (const id of ids) {
			violations.push(
				violation(id, boundary.left, boundary.right, boundary.boundaryCharacter, boundary.insideWord, null)
			)
		}
	}

	for (const found of reading.c6Violations ?? []) {
		const surface = (match: { startPiece: number; endPiece: number }) =>
			spanText(trace.text, trace.pieces, { tag: "", start: match.startPiece, end: match.endPiece })

		violations.push(
			violation("C6", found.left, found.right, trace.pieces[found.boundary]!.start, false, {
				covering: surface(found.covering),
				nested: surface(found.nested),
				nested_side: found.nestedSide,
			})
		)
	}

	// A row is unread when it has no violation and an unlicensed boundary whose affix or registry source went unread.
	const verdictFor = (id: "C4" | "C4_segment", unmeasured: boolean): boolean | null =>
		violations.some((v) => v.constraint === id) ? true : unmeasured ? null : false

	const violated: Record<ConstraintID, boolean | null> = {
		C4: verdictFor(
			"C4",
			reading.boundaries.some((b) => b.classification.verdict === "unmeasured")
		),
		C4_segment: verdictFor(
			"C4_segment",
			reading.boundaries.some((b) => b.classification.segmentVerdict === "unmeasured")
		),
		C6: reading.c6Violations ? reading.c6Violations.length > 0 : null,
	}

	// The battery grades the tree `parse` returns.
	const observed = [...groupTuplesByTag(buildAddressTree(trace.text, [...trace.tokens]))]
		.map(([tag, values]) => `${tag}=${values.join(" ¦ ")}`)
		.join(" | ")

	const account: Omit<ConstraintRowAccount, "rendered"> = {
		id: row.id,
		input: row.input,
		country: row.country,
		locale,
		expected: row.expected,
		observed,
		decoded: renderReading(trace.text, trace.pieces, labels),
		violated,
		n_boundaries: reading.boundaries.length,
		n_locality_spans: reading.spans.filter((span) => span.tag === "locality").length,
		violations,
	}

	return { ...account, rendered: renderConstraintAccount(account) }
}

function renderConstraintAccount(account: Omit<ConstraintRowAccount, "rendered">): string {
	const flags = (Object.entries(account.violated) as Array<[ConstraintID, boolean | null]>)
		.map(([id, value]) => `${id}=${value === null ? "unread" : value ? "violated" : "clear"}`)
		.join(" ")

	const lines = [
		`${account.id} [${account.country ?? "--"} ${account.locale}] ${account.input}`,
		`  ${flags}`,
		...(account.expected ? [`  expected: ${account.expected}`] : []),
		`  observed: ${account.observed}`,
		`  decoded:  ${account.decoded}`,
	]

	for (const v of account.violations) {
		const side = v.closest_side ? v.sides[v.closest_side] : null

		lines.push(
			`  ${v.constraint} @${v.boundary_character} ${v.left.tag}="${v.left.text}" | ${v.right.tag}="${v.right.text}"` +
				(v.inside_word ? " (inside a word)" : "") +
				(v.registry ? ` covering="${v.registry.covering}" nested="${v.registry.nested}"` : "") +
				(side ? ` margin ${side.margin} via ${v.dominant_term ?? "none"} ${stringifyJSON(side.term_margins)}` : "") +
				(v.repaired ? " (repaired after decode)" : ""),
			...(v.runner_up ? [`    runner-up: ${v.runner_up}`] : [])
		)
	}

	return lines.join("\n")
}

/**
 * The per-constraint tally over a set of row accounts.
 */
export function tallyConstraints(rows: readonly ConstraintRowAccount[]): Record<ConstraintID, ConstraintTally> {
	const tally = (id: ConstraintID): ConstraintTally => {
		const read = rows.filter((row) => row.violated[id] !== null)
		const violating = read.filter((row) => row.violated[id])
		const byTerm: Partial<Record<DecodeTerm | "none", number>> = {}

		for (const row of violating) {
			for (const v of row.violations.filter((candidate) => candidate.constraint === id)) {
				const key = v.dominant_term ?? "none"

				byTerm[key] = (byTerm[key] ?? 0) + 1
			}
		}

		return {
			n_rows_violating: violating.length,
			n_rows_read: read.length,
			share: read.length ? violating.length / read.length : null,
			by_dominant_term: byTerm,
		}
	}

	return { C4: tally("C4"), C4_segment: tally("C4_segment"), C6: tally("C6") }
}

interface LoadedLocale {
	classifier: NeuralAddressClassifier
	matchers: { fst: FSTMatcherLike | null; streetMorphology: FSTMatcherLike | null }
}

/**
 * Parse each row as the battery does, trace it, and account for C4 and C6.
 *
 * A locale package whose loader reports an unfed required channel is refused,
 * as the held-out scorer refuses it.
 */
async function runConstraintAccount(args: {
	rows: readonly ConstraintAccountInput[]
	weightsRoot: string | null
	rowsCap?: number | undefined
}): Promise<ConstraintAccountResult> {
	const packages = await readHeldoutLocalePackages()
	const loaded = new Map<string, Promise<LoadedLocale>>()

	const load = async (locale: string): Promise<LoadedLocale> => {
		const classifier = await NeuralAddressClassifier.loadFromWeights({
			locale,
			...(args.weightsRoot ? { cacheRoot: args.weightsRoot } : {}),
		})

		const [unfed] = classifier.unfedChannels

		if (unfed) {
			throw new Error(
				`refusing ${locale} from ${args.weightsRoot ?? "the installed weights"}: the loader reports the required ` +
					`${unfed.channel} channel unfed for ${unfed.weightsPackage} (${unfed.detail})`
			)
		}

		// A package without a gazetteer FST leaves C6 unread for its rows.
		// The street-morphology matcher loads on its own, because the parse-prior
		// loader loads it only beside a gazetteer FST.
		const { fst } = classifier.fstPath
			? await loadParsePriors(
					{ fstPath: classifier.fstPath },
					{ venueHeadPrior: false, label: locale, onWarn: () => {} }
				)
			: { fst: null }

		const { matcher: streetMorphology } = await loadStreetMorphologyFST(
			classifier.streetMorphologyPath ? { artifactPath: classifier.streetMorphologyPath } : {}
		)

		return { classifier, matchers: { fst, streetMorphology } }
	}

	const rows: ConstraintRowAccount[] = []
	const errors: ConstraintAccountResult["errors"] = []

	for (const row of args.rows) {
		const locale = heldoutWeightsLocale(row.country, packages)

		try {
			let pending = loaded.get(locale)

			if (!pending) {
				pending = load(locale)
				loaded.set(locale, pending)
			}

			const { classifier, matchers } = await pending

			const trace = await classifier.traceParse(row.input, {
				postcodeRepair: true,
				...(row.country ? { localeHint: row.country } : {}),
			})

			rows.push(accountConstraints(row, locale, trace, findConstraintRegistryMatches(trace.pieces, matchers)))
		} catch (error) {
			errors.push({ id: row.id, input: row.input, message: (error as Error).message })
		}
	}

	const tallies = tallyConstraints(rows)
	const percent = (t: ConstraintTally) => (t.share === null ? "unread" : `${(t.share * 100).toFixed(1)}%`)
	const emitted = [...rows.filter((row) => row.violations.length), ...rows.filter((row) => !row.violations.length)]

	return {
		account: "constraints",
		inference_rule: HELDOUT_INFERENCE_RULE,
		weights_root: args.weightsRoot,
		predicates: CONSTRAINT_PREDICATES,
		n_rows: rows.length,
		n_errored: errors.length,
		errors,
		tallies,
		summary:
			(Object.entries(tallies) as Array<[ConstraintID, ConstraintTally]>)
				.map(([id, t]) => `${id}: ${t.n_rows_violating} of ${t.n_rows_read} rows (${percent(t)})`)
				.join("; ") +
			`. ${errors.length} row(s) errored. A violation is a predicate match over the decode, not a graded error; ` +
			"the account changes no decode.",
		rows: args.rowsCap ? emitted.slice(0, args.rowsCap) : emitted,
		rows_omitted: args.rowsCap ? Math.max(0, emitted.length - args.rowsCap) : 0,
	}
}

/**
 * The `mwdev_diagnose` entry for `account: "constraints"`: the tool's `rows` when given,
 * otherwise the `inputs` set, with `config.weights_cache` as the weights root.
 */
export async function runConstraintAccountForArgs(args: Record<string, unknown>): Promise<ConstraintAccountResult> {
	const given = args["rows"] as Array<{ id?: string; input: string; country?: string; expected?: string }> | null
	const limit = args["limit"] as number | undefined
	const config = (args["config"] as EngineConfig | null) ?? {}

	const rows: ConstraintAccountInput[] = given
		? given.map((row, index) => ({
				id: row.id ?? String(index),
				input: row.input,
				country: row.country?.toUpperCase() ?? null,
				expected: row.expected ?? null,
			}))
		: (await resolveInputSet((args["inputs"] as InputSetRef | null) ?? { kind: "board" })).inputs.map((item) => ({
				id: item.id,
				input: item.input,
				country: item.country,
				expected: item.expectComponents
					? Object.entries(item.expectComponents)
							.map(([tag, value]) => `${tag}=${value}`)
							.join(" | ")
					: null,
			}))

	return runConstraintAccount({
		rows: limit ? rows.slice(0, limit) : rows,
		weightsRoot: config.weights_cache ?? null,
		rowsCap: args["rows_cap"] as number | undefined,
	})
}
