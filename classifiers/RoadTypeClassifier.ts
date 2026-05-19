// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { prepareLocaleIndex, Span, WordClassifier } from "@mailwoman/core"

export class RoadTypeClassifier extends WordClassifier {
	public async ready(): Promise<this> {
		this.index = await prepareLocaleIndex(this.languages, "road_types.txt")

		return this
	}

	public explore(span: Span): void {
		if (span.flags.has("numeral")) return
		if (!this.index.has(span.normalized)) return

		span.classifications.add("road_type", span.normalized.length < 2 ? 0.2 : 1)
	}
}
