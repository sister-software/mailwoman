// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `structure` family against the frozen output of the legacy classifier: the golden inputs,
 *   the quirks, the generated inputs and the gauntlet inputs of the fixture, then invariants
 *   on fresh generated inputs, and the promise that every promised input script has ranges.
 *
 *   The fixture is `data/fixtures/query-shape-frozen.json`.
 *   The class and script of every Unicode codepoint are in `differential.integration.test.ts`.
 *
 *   The real-row comparison ran once against the legacy package before it was deleted,
 *   and its summary is `data/reports/structure-differential.json`.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"
import { unicodeScriptsOf } from "@mailwoman/registry"
import type { BCP47 } from "@mailwoman/registry/types"
import { describe, expect, it } from "vitest"

import { createRecognizer } from "#index"
import { structure } from "#structure"
import { generatedInputs } from "#tools/differential"
import { plainFields, readFrozenFixture } from "#tools/frozen"

const recognizer = createRecognizer([structure])

describe("the structure family equals the frozen legacy output", () => {
	it("on every case of the fixture, in the six structural fields", async () => {
		const fixture = await readFrozenFixture()

		expect(fixture.cases.length).toBeGreaterThan(1500)

		const differences = fixture.cases
			.map(({ category, input, fields: frozen }) => {
				const { knownFormats: _ignored, ...recognized } = plainFields(recognizer.recognize(input).fields)
				const { knownFormats: _frozenFormats, ...expected } = frozen

				// oxlint-disable-next-line no-restricted-properties -- the comparison needs a canonical text of plain data
				return JSON.stringify(recognized) === JSON.stringify(expected)
					? null
					: { category, input, recognized, expected }
			})
			.filter((difference) => difference !== null)

		expect(differences.slice(0, 5)).toEqual([])
	})

	it("on every category the generators and the sources drew", async () => {
		const fixture = await readFrozenFixture()
		const categories = new Set(fixture.cases.map(({ category }) => category.split(":")[0]))

		expect([...categories].toSorted()).toEqual([
			"gauntlet",
			"generated-known-formats",
			"generated-structure",
			"golden",
			"quirk",
		])
	})
})

describe("the structure family's invariants on fresh generated inputs", () => {
	it("returns spans that index the text, tokens in order and segments that do not overlap", () => {
		for (const text of generatedInputs(2000, 424_242)) {
			const { tokenClasses, segments, totalLength } = recognizer.recognize(text).fields

			expect(totalLength).toBe(text.length)

			let end = 0

			for (const { span } of tokenClasses) {
				expect(span.start).toBeGreaterThanOrEqual(end)
				expect(text.slice(span.start, span.end)).toBe(span.body)

				end = span.end
			}

			end = 0

			for (const { span, body } of segments) {
				expect(span.start).toBeGreaterThanOrEqual(end)
				expect(text.slice(span.start, span.end)).toBe(body)

				end = span.end
			}
		}
	})
})

describe("the support promises", () => {
	it("promise no input script that the structure family classifies as Zzzz", async () => {
		const promises = await readLocalJSONFile<{
			promises: Array<{ input: string; embeddedNameScripts: string[] }>
		}>(workspacePath("codex", "lib", "support", "promises.json").toString())

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
