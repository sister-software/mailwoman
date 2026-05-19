/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"
import { CompoundUnitDesignatorClassifier } from "./CompoundUnitDesignatorClassifier.js"

const classifier = await new CompoundUnitDesignatorClassifier().ready()

type Foo = [unitType: string, unit: string]

const valid: Array<[input: string, [unitType: string, unit: string]]> = [
	["unit16", ["unit", "16"]],
	["apt23", ["apt", "23"]],
	["lot75", ["lot", "75"]],
]

const invalid: string[] = ["unit", "23", "Main"]

test("English unit types", () => {
	for (const [input, expected] of valid) {
		const result = classifier.classify(input)

		expect(result.children.pluck("body").toArray(), `Valid input: ${input}`).toStrictEqual(expected)
	}

	for (const input of invalid) {
		const result = classifier.classify(input)

		expect(result.children.size, `Invalid input: ${input}`).toEqual(0)
	}
})
