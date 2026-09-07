/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Register boundary repair — the char-path pass that closes an administrative span where a name register says it
 *   closes.
 *
 *   A character model learns where a span ends from the names it saw, and a name it never saw closes early:
 *   `富山県中新川郡上市町北島` decodes as municipality `中新川郡上市` + district `町北島` (the six JP towns whose name carries
 *   市, `@mailwoman/codex`'s `JP_INNER_SHI_TOWNS`), and `부산광역시 해운대구 반송로 910-1` as subregion `해` + street
 *   `대구` (the Korean 시군구 the model never saw, `KR_SIGUNGU`). The register names the boundary outright, so this pass
 *   extends a run by exactly the characters a register name needs and re-opens the span that followed. It fires only
 *   when the extended surface IS a register name, so a real city followed by a look-alike district is untouched.
 *
 *   A decode-time consumer of a positive attestation, not a prior: it changes labels only where the register states
 *   the boundary. The character model emits a second `B-` for a continuation it is unsure of (`해:B 운:B`); the pass
 *   reads each `B-` run on its own and absorbs across the seam, so both halves join the name.
 */

import { jpMunicipalityCompletion } from "@mailwoman/codex/jp"
import { krSubregionCompletion } from "@mailwoman/codex/kr"
import type { DecoderToken } from "@mailwoman/core/decoder"

import { createLabelSetter, isTagLabel, type RepairResult, tagOf, tokenIndicesOverlapping } from "#span/repair"

export type { RepairResult } from "#span/repair"

export interface RegisterBoundaryRepair {
	/**
	 * The tag whose runs the register closes (`municipality`, `subregion`).
	 */
	tag: string
	/**
	 * The register's read: the characters `surface` must absorb from `following` to become a name, or null.
	 */
	complete: (surface: string, following: string) => string | null
}

/**
 * Extend every run of `tag` whose surface a register name completes, and re-open the span that follows it.
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

			// Every absorbed token must sit inside the remainder: a token straddling its end would carry characters the
			// register did not name into the span.
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
 * The six JP towns whose name carries 市 before its 町 / 村 (#2178).
 */
export function repairJPMunicipalityLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	return repairRegisterBoundaryLabels(text, input, { tag: "municipality", complete: jpMunicipalityCompletion })
}

/**
 * The Korean 시군구, every one of them: a `subregion` the model closed inside a name it never saw (#2184).
 */
export function repairKRSubregionLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	return repairRegisterBoundaryLabels(text, input, { tag: "subregion", complete: krSubregionCompletion })
}
