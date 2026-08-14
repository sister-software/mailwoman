/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the "Copy JSON" payload for a parse result — the components + the selected resolved place,
 *   pretty-printed. Pure; shared by the explorer's copy button.
 */

import type { ParseResult, ResolvedPlaceView } from "./types.ts"

export function buildParsePayload(result: ParseResult, selected: ResolvedPlaceView | null): string {
	return JSON.stringify(
		{
			input: result.input,
			components: result.nodes.map((node) => ({
				tag: node.tag,
				value: node.value ?? null,
				confidence: node.confidence ?? null,
				start: node.start ?? null,
				end: node.end ?? null,
			})),
			resolved: selected
				? {
						name: selected.name,
						placetype: selected.placetype,
						id: selected.id,
						lat: selected.lat,
						lon: selected.lon,
						score: selected.score,
					}
				: null,
		},
		null,
		2
	)
}
