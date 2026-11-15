// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family against `computeQueryShape`: the golden fixture's 78 inputs, generated
 *   inputs, the whole of Unicode, and the promise that every promised input script has ranges.
 *
 *   The real-row comparison is `tools/differential.run.ts`, and its summary is committed.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { isPresent } from "@mailwoman/core/objects"
import { workspacePath } from "@mailwoman/core/paths"
import { unicodeScriptsOf } from "@mailwoman/registry"
import type { BCP47 } from "@mailwoman/registry/types"
import { describe, expect, it } from "vitest"

import { createRecognizer } from "#index"
import { structure } from "#structure"
import { compareOne, generatedInputs } from "#tools/differential"

interface GoldenFixture {
	cases: Array<{ category: string; input: string }>
}

describe("the structure family equals computeQueryShape", () => {
	it("on the golden fixture's inputs", async () => {
		const fixture = await readLocalJSONFile<GoldenFixture>(
			workspacePath("query-shape", "test", "fixtures", "compute-query-shape.golden.json").toString()
		)

		expect(fixture.cases).toHaveLength(78)

		const differences = fixture.cases.map(({ input }) => compareOne(input)).filter(isPresent)

		expect(differences).toEqual([])
	})

	it("on generated inputs over every class the legacy code lists", () => {
		const differences = generatedInputs(4000, 20_261_115).map(compareOne).filter(isPresent)

		expect(differences.slice(0, 5)).toEqual([])
	})

	it("on the quirks the Phase 0 record lists", () => {
		const quirks = [
			"Αθήνα",
			"ＡＢＣ １２３",
			"​12345",
			"北a",
			"a北",
			"Main St, NW, Washington",
			"Box 1012, LG",
			"ニューヨーク-NY",
			"a , NY, b",
			"×",
		]

		expect(quirks.map(compareOne).filter(isPresent)).toEqual([])
	})

	it("on a 300-digit run and a 300-character run of one CJK character", () => {
		expect(["1".repeat(300), "漢".repeat(300), "a-".repeat(300)].map(compareOne).filter(isPresent)).toEqual([])
	})
})

describe("the support promises", () => {
	it("promise no input script that the structure family classifies as Zzzz", async () => {
		const promises = await readLocalJSONFile<{
			promises: Array<{ input: string; embeddedNameScripts: string[] }>
		}>(workspacePath("codex", "lib", "support", "promises.json").toString())

		const recognizer = createRecognizer([structure])
		const unclassified: string[] = []

		for (const { input, embeddedNameScripts } of promises.promises) {
			const subtags = input.split("-")
			const codes = [subtags.find((subtag) => /^[A-Z][a-z]{3}$/u.test(subtag)), ...embeddedNameScripts]

			for (const code of codes) {
				if (!code) continue

				for (const script of unicodeScriptsOf(code as BCP47.ScriptCode)) {
					// A script has ranges when some letter of it comes back as that script and not as `Zzzz`.
					const letter = new RegExp(`^(?=\\p{L})\\p{Script=${script}}$`, "u")
					let classified = false

					for (let codepoint = 0, seen = 0; codepoint < 0x3_00_00 && seen < 200 && !classified; codepoint++) {
						const character = String.fromCodePoint(codepoint)

						if (!letter.test(character)) continue

						seen++
						classified = recognizer.recognize(character).fields.scripts[0]?.script === script
					}

					if (!classified) {
						unclassified.push(`${input}: ${script}`)
					}
				}
			}
		}

		expect(unclassified).toEqual([])
	})
})
