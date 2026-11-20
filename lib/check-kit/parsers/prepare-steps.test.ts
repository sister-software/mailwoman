// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The two prepare-step parsers over output in the form each command prints.
 */

import { describe, expect, it } from "vitest"

import { parseWeightsCopyOutput, parseYarnInstallOutput } from "#check-kit/parsers/prepare-steps"

/**
 * `yarn install --json` from this repository, on 2026-11-20, shortened to one line per type.
 */
const INSTALL_WITH_WARNINGS = [
	'{"type":"info","name":0,"displayName":"YN0000","indent":"· ","data":"Yarn 4.18.1"}',
	'{"type":"info","name":null,"displayName":"YN0000","indent":"","data":"┌ Post-resolution validation"}',
	'{"type":"warning","name":86,"displayName":"YN0086","indent":"│ ","data":"Some peer dependencies are incorrectly met by dependencies; run yarn explain peer-requirements for details."}',
	'{"type":"warning","name":0,"displayName":"YN0000","indent":"· ","data":"Done with warnings in 6s 863ms"}',
].join("\n")

describe("parseYarnInstallOutput", () => {
	it("counts Yarn's typed warning lines and leaves its closing line out of the count", () => {
		expect(parseYarnInstallOutput(INSTALL_WITH_WARNINGS, 0)).toMatchObject({ parsed: true, errors: 0, warnings: 1 })
	})

	it("counts an error line of a failed install and repeats it", () => {
		const failed = [
			'{"type":"error","name":28,"displayName":"YN0028","indent":"│ ","data":"The lockfile would have been modified by this install, which is explicitly forbidden."}',
			'{"type":"error","name":0,"displayName":"YN0000","indent":"· ","data":"Failed with errors in 2s"}',
		].join("\n")

		expect(parseYarnInstallOutput(failed, 1)).toMatchObject({
			parsed: true,
			errors: 1,
			errorLines: ["YN0028: The lockfile would have been modified by this install, which is explicitly forbidden."],
		})
	})

	it("reports output without Yarn's closing line as unparsed", () => {
		expect(parseYarnInstallOutput("➤ YN0000: · Done in 1s", 0)).toMatchObject({ parsed: false, errors: null })
	})
})

describe("parseWeightsCopyOutput", () => {
	it("reads the output object printed after the progress lines", () => {
		const output = [
			"copied weights → packages/neural-weights-en-us/{model.onnx,tokenizer.model}",
			"{",
			'  "skipped": false,',
			'  "workspaces": ["packages/neural-weights-en-us"]',
			"}",
		].join("\n")

		expect(parseWeightsCopyOutput(output, 0)).toMatchObject({ parsed: true, errors: 0, warnings: 0 })
	})

	it("counts the thrown error of a failed copy", () => {
		const output = "Error: Missing source model: /data/models/model.onnx\n    at copyWeights (copy-weights.ts:1:1)"

		expect(parseWeightsCopyOutput(output, 1)).toMatchObject({
			parsed: true,
			errors: 1,
			errorLines: ["Error: Missing source model: /data/models/model.onnx"],
		})
	})
})
