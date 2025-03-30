// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import test from "tape"
import { CompoundUnitDesignatorClassifier } from "./CompoundUnitDesignatorClassifier.js"

const classifier = await new CompoundUnitDesignatorClassifier().ready()

const valid: Array<[input: string, [unitType: string, unit: string]]> = [
	["unit16", ["unit", "16"]],
	["apt23", ["apt", "23"]],
	["lot75", ["lot", "75"]],
]

const invalid: string[] = ["unit", "23", "Main"]

test("English unit types", (t) => {
	for (const [input, expected] of valid) {
		const result = classifier.classify(input)

		t.deepEquals(Array.from(result.children.pluck("body")), expected, `Valid input: ${input}`)
	}

	for (const input of invalid) {
		const result = classifier.classify(input)

		t.equals(result.children.size, 0, `Invalid input: ${input}`)
	}

	t.end()
})
