/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Counts the gold span edges a vocabulary cannot reach.
 *
 *   The model labels whole pieces, so a span edge that falls strictly inside one piece is outside every
 *   output the model can produce, whatever its weights.
 *
 *   An edge where the character class changes, such as `HR-` before `23211` or `S.A.` before a comma, is
 *   reachable by construction when the vocabulary keeps digits and punctuation in pieces of their own. A
 *   vocabulary change is admitted only when no such edge falls inside a piece. An edge between two letters
 *   with no space between them, as in the run-together rendering `CHINAGANSU` + `DUJIACHUAN`, is reachable
 *   only if piece frequencies happen to split there, so it is counted and reported without deciding admission.
 *
 *   Rows the script router sends to a character-path family are left out and counted separately, because
 *   that path labels each character.
 */

import { scriptFamilyForText } from "@mailwoman/neural/classifier/script-router"
import type { MailwomanTokenizer } from "@mailwoman/neural/tokenizer"
import { classifyCodepoint } from "@mailwoman/query-shape/character-class"

import { type HeldoutRow, heldoutRowID } from "#tools/eval-harness/heldout/per/country"

/**
 * The part of a tokenizer the census reads.
 */
export type CensusTokenizer = Pick<MailwomanTokenizer, "encode">

/**
 * One gold edge that falls inside a piece.
 */
export interface UnreachableEdge {
	rowID: string
	raw: string
	/**
	 * The UTF-16 offset of the edge in `raw`.
	 */
	offset: number
	/**
	 * The tag of the span the edge opens or closes.
	 */
	tag: string
	side: "start" | "end"
	/**
	 * The character classes on either side of the edge, as `left|right`.
	 */
	edgeClass: string
	/**
	 * The piece the edge falls inside.
	 */
	piece: string
}

/**
 * The census of one vocabulary over a set of rows.
 */
export interface ReachabilityCensus {
	rows: number
	/**
	 * Rows routed to a character-path family and so not tokenized by this vocabulary.
	 */
	characterPathRows: number
	edges: number
	unreachable: number
	/**
	 * Unreachable edges where the character class changes.
	 * Admission requires zero.
	 */
	unreachableAtClassChange: number
	byTag: Record<string, number>
	byEdgeClass: Record<string, number>
	/**
	 * Unreachable edges by piece text, most frequent first in the written report.
	 */
	byPiece: Record<string, number>
	examples: UnreachableEdge[]
}

function codepointClassAt(text: string, offset: number, before: boolean): string {
	const cp = before
		? text.codePointAt(offset - 1 - (isLowSurrogate(text, offset - 1) ? 1 : 0))
		: text.codePointAt(offset)

	return cp == null ? "none" : classifyCodepoint(cp)
}

function isLowSurrogate(text: string, index: number): boolean {
	const unit = text.charCodeAt(index)

	return unit >= 0xdc_00 && unit <= 0xdf_ff
}

const WHITESPACE = /\s/u

/**
 * Returns each piece's character range with its leading whitespace removed.
 *
 * A piece that opens a word starts at the space before it, and an edge at the
 * first letter of that word is reachable.
 */
function pieceRanges(tokenizer: CensusTokenizer, text: string): { start: number; end: number; piece: string }[] {
	return tokenizer.encode(text).pieces.map(({ piece, start, end }) => {
		let s = start

		while (s < end && WHITESPACE.test(text[s]!)) {
			s++
		}

		return { start: s, end, piece }
	})
}

/**
 * Counts the gold edges of `rows` that fall strictly inside a piece of `tokenizer`.
 *
 * @param maxExamples The count of unreachable edges kept with their row for the report.
 */
export function censusReachability(
	rows: readonly HeldoutRow[],
	tokenizer: CensusTokenizer,
	maxExamples = 200
): ReachabilityCensus {
	const census: ReachabilityCensus = {
		rows: 0,
		characterPathRows: 0,
		edges: 0,
		unreachable: 0,
		unreachableAtClassChange: 0,
		byTag: {},
		byEdgeClass: {},
		byPiece: {},
		examples: [],
	}

	for (const row of rows) {
		census.rows++

		if (scriptFamilyForText(row.raw)) {
			census.characterPathRows++

			continue
		}

		const pieces = pieceRanges(tokenizer, row.raw)

		for (const [i, tag] of row.span_tags.entries()) {
			for (const [side, offset] of [
				["start", row.span_starts[i]!],
				["end", row.span_ends[i]!],
			] as const) {
				if (offset <= 0 || offset >= row.raw.length) continue

				census.edges++
				const inside = pieces.find((p) => p.start < offset && offset < p.end)

				if (!inside) continue

				const left = codepointClassAt(row.raw, offset, true)
				const right = codepointClassAt(row.raw, offset, false)
				const edgeClass = `${left}|${right}`

				census.unreachable++

				// Two punctuation marks are separate pieces in a vocabulary that isolates punctuation.
				if (left !== right || left === "punct" || left === "connector") {
					census.unreachableAtClassChange++
				}

				census.byTag[tag] = (census.byTag[tag] ?? 0) + 1
				census.byEdgeClass[edgeClass] = (census.byEdgeClass[edgeClass] ?? 0) + 1
				census.byPiece[inside.piece] = (census.byPiece[inside.piece] ?? 0) + 1

				if (census.examples.length < maxExamples) {
					census.examples.push({
						rowID: heldoutRowID(row),
						raw: row.raw,
						offset,
						tag,
						side,
						edgeClass,
						piece: inside.piece,
					})
				}
			}
		}
	}

	return census
}
