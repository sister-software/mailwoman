/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Span, WordClassifier } from "@mailwoman/core"

const combinedFloorRegexp = /^\d{1,2}$/

export class LevelClassifier extends WordClassifier {
	public explore(span: Span): void {
		const { previousSibling } = span
		const hasPrevLevelToken = previousSibling?.is("level_designator")

		// If the previous token in a level word, like floor, fl, or floor.
		if (hasPrevLevelToken && combinedFloorRegexp.test(span.body)) {
			span.classifications.add("level")
		}
	}

	public override classify(input: Span | string, prev?: Span | string): Span {
		const span = Span.from(input)

		if (prev) {
			const previousSpan = Span.from(prev)

			previousSpan.classifications.add("level_designator")
			span.previousSiblings.add(previousSpan)
		}

		this.explore(span)

		return span
	}
}
