// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { PhraseClassifier, Span } from "@mailwoman/core"

export class IntersectionClassifier extends PhraseClassifier {
	public intersectionSymbols = new Set<string>([
		// ---
		"&",
		"and",
		"und",
		"@",
		"at",
		"con",
		"an der ecke von",
	])

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const firstChild = span.children.first || span
		const { previousSibling, nextSibling } = firstChild

		if (!previousSibling || !nextSibling) return

		if (this.intersectionSymbols.has(span.normalized)) {
			span.classifications.add("intersection")

			for (const child of span.children) {
				child.classifications.add("intersection")
			}
		}
	}
}
