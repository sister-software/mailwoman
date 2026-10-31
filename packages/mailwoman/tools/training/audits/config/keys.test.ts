/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { parsePythonYAML } from "@mailwoman/corpus/training/config/python-yaml"
import { CONFIG_SECTION } from "@mailwoman/corpus/training/config/schema"
import { describe, expect, it } from "vitest"

import { unknownConfigKeys } from "./keys.ts"

describe("unknownConfigKeys", () => {
	it("reports every unknown key with its dotted path, where the strict loader stops at the first", () => {
		const yaml = [
			"data:",
			"  max_length: 128",
			"  max_length_v2: 64",
			"train:",
			"  seed: 42",
			"  learning_rate_typo: 0.001",
			"stray_section:",
			"  anything: 1",
		].join("\n")

		expect(unknownConfigKeys(parsePythonYAML(yaml, "fixture.yaml"), CONFIG_SECTION)).toEqual([
			"data.max_length_v2",
			"train.learning_rate_typo",
			"stray_section",
		])
	})

	it("reports nothing for a config whose keys the schema declares", () => {
		const yaml = ["data:", "  max_length: 128", "train:", "  seed: 42", "  max_steps: 200"].join("\n")

		expect(unknownConfigKeys(parsePythonYAML(yaml, "fixture.yaml"), CONFIG_SECTION)).toEqual([])
	})
})
