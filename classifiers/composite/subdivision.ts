// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { type ClassifierSchemeConfig, CompositeClassifier } from "@mailwoman/core"

const configs: ClassifierSchemeConfig[] = [
	{
		// 10 bis / 10 ter
		confidence: 0.99,
		scheme: [
			{
				is: ["house_number"],
				not: ["intersection"],
			},
			{
				is: ["stop_word"],
				// not: ["intersection", "punctuation", "directional"],
				not: ["intersection", "punctuation"],
			},
		],
	},
]

export class SubdivisionClassifier extends CompositeClassifier {
	constructor() {
		super("house_number", configs)
	}
}
