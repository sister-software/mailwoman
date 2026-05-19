/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type LibPostalLanguageCode, LocaleIndex, Span, WordClassifier } from "@mailwoman/core"

/**
 * Special handling of streets with no suffix
 *
 * @see {@link https://github.com/pelias/parser/issues/140 | Issue #140}
 */
export class StreetProperNameClassifier extends WordClassifier {
	public override index = new LocaleIndex<LibPostalLanguageCode>(
		[
			["broadway", ["en"]],
			["esplanade", ["en"]],
		],
		{
			displayName: "libpostal",
		}
	)

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		const languages = this.index.get(span.normalized)

		if (!languages) return

		span.classifications.add({
			classification: "street_proper_name",
			confidence: 0.7,
			languages,
		})
	}
}
