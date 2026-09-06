/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   JP municipality boundary repair — the char-path pass over the six towns whose name carries 市.
 *
 *   The character model closes a `municipality` span at 市 and opens the next span on 町: `富山県中新川郡上市町北島` decodes
 *   as prefecture `富山県`, municipality `中新川郡上市`, district `町北島`. The register in `@mailwoman/codex`
 *   (`JP_INNER_SHI_TOWNS`) names the six towns for which that boundary is wrong, so this pass extends the municipality by
 *   exactly the characters a register name needs and re-opens the following span after them. It fires only when the
 *   extended surface IS a register name, so a real city followed by a 町-initial district (`富山市町村`) is untouched.
 *
 *   The pass is a decode-time consumer of a positive attestation, not a prior: it changes labels only where the
 *   register states the boundary outright.
 */

import { jpMunicipalityCompletion } from "@mailwoman/codex/jp"
import type { DecoderToken } from "@mailwoman/core/decoder"

import { createLabelSetter, isTagLabel, type RepairResult, tagOf, tokenIndicesOverlapping } from "#span/repair"

export type { RepairResult } from "#span/repair"

/**
 * Extend every `municipality` run whose surface a register name completes, and re-open the span that follows it.
 */
export function repairJPMunicipalityLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	const tokens = input.map((t) => ({ ...t }))
	const { setLabel, changeCount } = createLabelSetter(tokens)

	let i = 0

	while (i < tokens.length) {
		if (tokens[i]!.label !== "B-municipality") {
			i++

			continue
		}

		let j = i

		while (j + 1 < tokens.length && tokens[j + 1]!.label === "I-municipality") {
			j++
		}

		const end = tokens[j]!.end
		const remainder = jpMunicipalityCompletion(text.slice(tokens[i]!.start, end), text.slice(end))

		if (remainder) {
			const absorbed = tokenIndicesOverlapping(tokens, end, end + remainder.length)
			const last = absorbed.at(-1)

			// Every absorbed token must sit inside the remainder: a token straddling its end would carry characters the
			// register did not name into the municipality.
			if (last !== undefined && tokens[last]!.end === end + remainder.length) {
				for (const k of absorbed) {
					setLabel(k, "I-municipality")
				}

				const next = tokens[last + 1]
				const tag = next ? tagOf(next.label) : null

				if (next && tag && !isTagLabel(next.label, "municipality") && next.label.startsWith("I-")) {
					setLabel(last + 1, `B-${tag}` as DecoderToken["label"])
				}

				j = last
			}
		}

		i = j + 1
	}

	return { tokens, changed: changeCount() }
}
