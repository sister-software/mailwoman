/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Alpha2LanguageCode, prepareLocaleIndex, Span, WordClassifier } from "@mailwoman/core"

export class LevelDesignatorClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		const languages = this.languages ?? [Alpha2LanguageCode.English]
		this.index = await prepareLocaleIndex(languages, "level_types_numbered.txt")

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return

		if (this.index.has(span.normalized)) {
			span.classifications.add("level_designator")
		}
	}
}
