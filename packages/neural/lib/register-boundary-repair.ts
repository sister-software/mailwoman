/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Extends an administrative span on the character path to the end of a name listed in a register.
 *
 *   A character model can close a span early inside an unfamiliar name. For example, `富山県中新川郡上市町北島` decodes
 *   as municipality `中新川郡上市` plus district `町北島`. The pass extends the span only when the extended text is a
 *   register name, and it reopens the following span. The model sometimes emits a second `B-` inside a name, so each
 *   `B-` run is extended independently.
 */

import { jpMunicipalityCompletion } from "@mailwoman/codex/jp"
import { krSubregionCompletion } from "@mailwoman/codex/kr"
import type { DecoderToken } from "@mailwoman/core/decoder"

import { createLabelSetter, isTagLabel, type RepairResult, tagOf, tokenIndicesOverlapping } from "#span/repair"

/**
 * The result of a repair pass.
 */
export type { RepairResult } from "#span/repair"

/**
 * A tag and the register lookup that completes its spans.
 */
export interface RegisterBoundaryRepair {
	/**
	 * The tag whose spans the register completes, such as `municipality` or `subregion`.
	 */
	tag: string
	/**
	 * Returns the characters that `surface` must take from `following` to form a register name, or null.
	 */
	complete: (surface: string, following: string) => string | null
}

/**
 * Extends every run of `tag` that a register name completes and reopens the span that follows it.
 */
export function repairRegisterBoundaryLabels(
	text: string,
	input: readonly DecoderToken[],
	repair: RegisterBoundaryRepair
): RepairResult {
	const tokens = input.map((t) => ({ ...t }))
	const { setLabel, changeCount } = createLabelSetter(tokens)
	const begin = `B-${repair.tag}`
	const inside = `I-${repair.tag}` as DecoderToken["label"]

	let i = 0

	while (i < tokens.length) {
		if (tokens[i]!.label !== begin) {
			i++

			continue
		}

		let j = i

		while (j + 1 < tokens.length && tokens[j + 1]!.label === inside) {
			j++
		}

		const end = tokens[j]!.end
		const remainder = repair.complete(text.slice(tokens[i]!.start, end), text.slice(end))

		if (remainder) {
			const absorbed = tokenIndicesOverlapping(tokens, end, end + remainder.length)
			const last = absorbed.at(-1)

			// The absorbed tokens must end exactly at the remainder's end so no extra characters join the span.
			if (last !== undefined && tokens[last]!.end === end + remainder.length) {
				for (const k of absorbed) {
					setLabel(k, inside)
				}

				const next = tokens[last + 1]
				const tag = next ? tagOf(next.label) : null

				if (next && tag && !isTagLabel(next.label, repair.tag) && next.label.startsWith("I-")) {
					setLabel(last + 1, `B-${tag}` as DecoderToken["label"])
				}

				j = last
			}
		}

		i = j + 1
	}

	return { tokens, changed: changeCount() }
}

/**
 * Repairs municipality spans for the Japanese towns whose name contains 市 before 町 or 村.
 */
export function repairJPMunicipalityLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	return repairRegisterBoundaryLabels(text, input, { tag: "municipality", complete: jpMunicipalityCompletion })
}

/**
 * Repairs subregion spans against the register of Korean 시군구 names.
 */
export function repairKRSubregionLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	return repairRegisterBoundaryLabels(text, input, { tag: "subregion", complete: krSubregionCompletion })
}
